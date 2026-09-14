/**
 * PrismaProxyProfileRepository — proxy profiles, endpoints, conventional
 * bulk import, and health/quarantine bookkeeping.
 *
 * SECRET HYGIENE (ARCHITECTURE.md §10, ADR-0005):
 * - username/password are encrypted via shared/security `encryptSecret`
 *   BEFORE save; the columns hold only AES-256-GCM `v1:` envelopes.
 * - Read paths NEVER decrypt: endpoint DTOs expose `hasUsername`/`hasPassword`
 *   booleans instead of secret material.
 * - `getEndpointCredentials()` is the ONLY decryption path — worker use only
 *   (ProxyProvider). API/UI layers must never call it.
 * - Bulk-import failure records are masked (maskProxyImportLine) — a rejected
 *   line never echoes credentials back.
 *
 * SCHEMA GAP (reported to the Lead — schema.prisma is NOT edited from here):
 * ProxyEndpoint has no `consecutiveFailures` column, but the health policy
 * (DEGRADED after 2 consecutive failures, UNHEALTHY + 15-min quarantine after
 * 4) is streak-based. Until a migration adds it, `failureCount` is maintained
 * as the CURRENT consecutive-failure streak (reset to 0 on success);
 * `successCount` remains cumulative. A cumulative failure total is therefore
 * NOT available from this table today.
 *
 * WIRING: requires `export * from './security.js';` in shared/src/index.ts
 * (Lead's export wiring) for the security primitives to resolve.
 */
import { CrawlError, decryptSecret, encryptSecret, redactProxyUrl } from '@sahibindenbot/shared';
import type { Prisma, PrismaClient, ProxyEndpoint, ProxyProfile } from '@prisma/client';

// ---------------------------------------------------------------------------
// Enum mirrors (string values identical to prisma/schema.prisma)
// ---------------------------------------------------------------------------

export type ProxyStrategyValue = 'ROUND_ROBIN' | 'SESSION_STICKY';
export type ProxyHealthStatusValue = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'DISABLED';

// ---------------------------------------------------------------------------
// DTOs — secret-free by construction
// ---------------------------------------------------------------------------

export interface ProxyProfileRecord {
    id: string;
    name: string;
    strategy: ProxyStrategyValue;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface ProxyHealthSummary {
    unknown: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    disabled: number;
}

export interface ProxyProfileSummary extends ProxyProfileRecord {
    endpointCount: number;
    enabledEndpointCount: number;
    healthSummary: ProxyHealthSummary;
}

/** Endpoint DTO for reads: credentials reduced to presence booleans. */
export interface ProxyEndpointRecord {
    id: string;
    profileId: string;
    name: string | null;
    host: string;
    port: number;
    protocol: string;
    hasUsername: boolean;
    hasPassword: boolean;
    enabled: boolean;
    weight: number;
    country: string | null;
    notes: string;
    lastCheckedAt: Date | null;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    successCount: number;
    /** Current consecutive-failure streak (see SCHEMA GAP note above). */
    failureCount: number;
    latencyMs: number | null;
    healthStatus: ProxyHealthStatusValue;
    quarantinedUntil: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ProxyProfileDetail extends ProxyProfileRecord {
    endpoints: ProxyEndpointRecord[];
}

export interface ProxyProfileCreateInput {
    name: string;
    strategy?: ProxyStrategyValue;
    enabled?: boolean;
}

export type ProxyProfileUpdateInput = Partial<ProxyProfileCreateInput>;

export interface ProxyEndpointCreateInput {
    name?: string | null;
    host: string;
    port: number;
    /** 'http' | 'https' | 'socks4' | 'socks5' (case-insensitive). Default 'http'. */
    protocol?: string;
    username?: string;
    password?: string;
    enabled?: boolean;
    weight?: number;
    country?: string | null;
    notes?: string;
}

export interface ProxyEndpointUpdateInput {
    name?: string | null;
    host?: string;
    port?: number;
    protocol?: string;
    /** Tri-state: omitted = keep, '' | null = clear, other = re-encrypt & store. */
    username?: string | null;
    /** Tri-state: omitted = keep, '' | null = clear, other = re-encrypt & store. */
    password?: string | null;
    enabled?: boolean;
    weight?: number;
    country?: string | null;
    notes?: string;
}

export interface ProxyImportFailure {
    /** The rejected line with credentials MASKED (host:port kept for identification). */
    line: string;
    error: string;
}

export interface ProxyImportResult {
    imported: number;
    failed: ProxyImportFailure[];
}

// ---------------------------------------------------------------------------
// Pure: conventional proxy-line parsing (bulk import)
// ---------------------------------------------------------------------------

const SUPPORTED_PROXY_PROTOCOLS: ReadonlySet<string> = new Set(['http', 'https', 'socks4', 'socks5']);

/** Lowercases and trims a protocol, tolerating '://' / ':' suffixes. */
export function normalizeProxyProtocol(raw: string): string {
    return raw.trim().toLowerCase().replace(/:\/\/$/, '').replace(/:$/, '');
}

export interface ParsedProxyEndpoint {
    protocol: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
}

/**
 * protocol://[user[:pass]@]host:port — parsed by regex (NOT `new URL`) so an
 * explicitly typed default port (e.g. `http://host:80`) survives; WHATWG URL
 * normalization would drop it. User/pass are percent-decoded.
 */
const URL_LINE_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(?:([^\s:@/]+)(?::([^\s@/]*))?@)?([^\s:@/]+):(\d{1,5})\/?$/i;

function parsePort(raw: string): number {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('port must be an integer between 1 and 65535');
    }
    return port;
}

function decodeCredential(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw; // malformed percent-escapes: keep the raw form
    }
}

function assertProtocol(raw: string): string {
    const protocol = normalizeProxyProtocol(raw);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(protocol)) {
        throw new Error(`unsupported protocol '${protocol}' (expected http/https/socks4/socks5)`);
    }
    return protocol;
}

function assertHost(raw: string): string {
    const host = raw.trim();
    if (host === '') throw new Error('host is required');
    if (/[\s/@]/.test(host)) throw new Error('host must not contain whitespace, "/" or "@"');
    return host;
}

/**
 * Parses ONE conventional proxy line. Throws (secret-free message) on any
 * format/validation problem. Accepted formats:
 *   protocol://user:pass@host:port
 *   protocol://host:port
 *   host:port:user:pass   (password may itself contain ':')
 *   host:port             (protocol defaults to http)
 */
export function parseProxyEndpointLine(line: string): ParsedProxyEndpoint {
    const trimmed = line.trim();
    if (trimmed === '') throw new Error('empty line');

    if (trimmed.includes('://')) {
        const match = URL_LINE_PATTERN.exec(trimmed);
        if (match === null) {
            throw new Error('malformed proxy URL (expected protocol://[user[:pass]@]host:port)');
        }
        // Justified cast: regex match with 5 capture groups (noUncheckedIndexedAccess).
        const [, rawProtocol, rawUser, rawPass, rawHost, rawPort] = match as unknown as [
            string,
            string,
            string | undefined,
            string | undefined,
            string,
            string,
        ];
        const parsed: ParsedProxyEndpoint = {
            protocol: assertProtocol(rawProtocol),
            host: assertHost(rawHost),
            port: parsePort(rawPort),
        };
        if (rawUser !== undefined && rawUser !== '') {
            parsed.username = decodeCredential(rawUser);
            if (rawPass !== undefined && rawPass !== '') parsed.password = decodeCredential(rawPass);
        }
        return parsed;
    }

    const parts = trimmed.split(':');
    if (parts.length === 2) {
        return { protocol: 'http', host: assertHost(parts[0] ?? ''), port: parsePort(parts[1] ?? '') };
    }
    if (parts.length >= 4) {
        const username = (parts[2] ?? '').trim();
        if (username === '') throw new Error('empty username in host:port:user:pass line');
        const password = parts.slice(3).join(':'); // passwords may contain ':'
        const parsed: ParsedProxyEndpoint = {
            protocol: 'http',
            host: assertHost(parts[0] ?? ''),
            port: parsePort(parts[1] ?? ''),
            username,
        };
        if (password !== '') parsed.password = password;
        return parsed;
    }
    throw new Error('expected host:port[:user:pass] or protocol://[user[:pass]@]host:port');
}

/**
 * Masks a rejected import line for safe display: credentials are stripped,
 * host:port kept so the operator can identify the line.
 */
export function maskProxyImportLine(line: string): string {
    const trimmed = line.trim();
    if (trimmed.includes('://')) {
        const redacted = redactProxyUrl(trimmed);
        if (redacted !== '<invalid-url>') return redacted;
        // Unparseable URL — strip any userinfo manually so the host portion
        // stays visible for identification while credentials are removed.
        return trimmed.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/i, '$1');
    }
    const parts = trimmed.split(':');
    if (parts.length > 2) return `${parts[0]}:${parts[1]}:***`;
    return trimmed; // host:port carries no secret
}

/**
 * Parses a bulk-import text: one endpoint per line, `#` comments and empty
 * lines skipped. NEVER throws on a bad line — failures are collected with
 * masked line content.
 */
export function parseProxyImportText(text: string): { endpoints: ParsedProxyEndpoint[]; failed: ProxyImportFailure[] } {
    const endpoints: ParsedProxyEndpoint[] = [];
    const failed: ProxyImportFailure[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        try {
            endpoints.push(parseProxyEndpointLine(line));
        } catch (err) {
            failed.push({ line: maskProxyImportLine(line), error: err instanceof Error ? err.message : String(err) });
        }
    }
    return { endpoints, failed };
}

// ---------------------------------------------------------------------------
// Pure: health state machine (DEGRADED ≥2 streak, UNHEALTHY + quarantine ≥4)
// ---------------------------------------------------------------------------

/** Consecutive failures before an endpoint degrades. */
export const PROXY_DEGRADED_THRESHOLD = 2;
/** Consecutive failures before an endpoint becomes unhealthy and is quarantined. */
export const PROXY_UNHEALTHY_THRESHOLD = 4;
/** Quarantine window after reaching the unhealthy threshold. */
export const PROXY_QUARANTINE_MS = 15 * 60 * 1000;
/** Exponential moving average weight for latency samples. */
export const PROXY_LATENCY_EMA_ALPHA = 0.3;

export interface EndpointHealthState {
    healthStatus: ProxyHealthStatusValue;
    /** Consecutive failure streak BEFORE the event being applied. */
    consecutiveFailures: number;
    latencyMs: number | null;
    quarantinedUntil: Date | null;
}

export interface EndpointHealthTransition {
    healthStatus: ProxyHealthStatusValue;
    consecutiveFailures: number;
    latencyMs: number | null;
    quarantinedUntil: Date | null;
    /** True when THIS failure (re)armed the quarantine window. */
    quarantineArmed: boolean;
}

/**
 * Success: streak resets, latency folds into the EMA, quarantine clears.
 * UNKNOWN → HEALTHY; DEGRADED/UNHEALTHY → HEALTHY. DISABLED is operator-owned:
 * status stays DISABLED (streak/latency still update — the check did run).
 */
export function applyHealthSuccess(state: EndpointHealthState, latencyMs: number): EndpointHealthTransition {
    const sample = Math.max(0, Math.round(latencyMs));
    const latency =
        state.latencyMs === null
            ? sample
            : Math.round(state.latencyMs * (1 - PROXY_LATENCY_EMA_ALPHA) + sample * PROXY_LATENCY_EMA_ALPHA);
    if (state.healthStatus === 'DISABLED') {
        return {
            healthStatus: 'DISABLED',
            consecutiveFailures: 0,
            latencyMs: latency,
            quarantinedUntil: state.quarantinedUntil,
            quarantineArmed: false,
        };
    }
    return { healthStatus: 'HEALTHY', consecutiveFailures: 0, latencyMs: latency, quarantinedUntil: null, quarantineArmed: false };
}

/**
 * Failure: streak increments. Streak 1 keeps the current status; ≥2 → DEGRADED;
 * ≥4 → UNHEALTHY and quarantinedUntil = now + 15 min (re-armed on every further
 * failure, so a persistently failing endpoint stays quarantined). DISABLED is
 * operator-owned: status/quarantine untouched (streak still tracked).
 */
export function applyHealthFailure(state: EndpointHealthState, now: Date): EndpointHealthTransition {
    const consecutiveFailures = state.consecutiveFailures + 1;
    if (state.healthStatus === 'DISABLED') {
        return {
            healthStatus: 'DISABLED',
            consecutiveFailures,
            latencyMs: state.latencyMs,
            quarantinedUntil: state.quarantinedUntil,
            quarantineArmed: false,
        };
    }
    let healthStatus = state.healthStatus;
    let quarantinedUntil = state.quarantinedUntil;
    let quarantineArmed = false;
    if (consecutiveFailures >= PROXY_UNHEALTHY_THRESHOLD) {
        healthStatus = 'UNHEALTHY';
        quarantinedUntil = new Date(now.getTime() + PROXY_QUARANTINE_MS);
        quarantineArmed = true;
    } else if (consecutiveFailures >= PROXY_DEGRADED_THRESHOLD) {
        healthStatus = 'DEGRADED';
    }
    return { healthStatus, consecutiveFailures, latencyMs: state.latencyMs, quarantinedUntil, quarantineArmed };
}

// ---------------------------------------------------------------------------
// Mappers (row → secret-free DTO)
// ---------------------------------------------------------------------------

function toProfileRecord(row: ProxyProfile): ProxyProfileRecord {
    return {
        id: row.id,
        name: row.name,
        strategy: row.strategy,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function toEndpointRecord(row: ProxyEndpoint): ProxyEndpointRecord {
    return {
        id: row.id,
        profileId: row.profileId,
        name: row.name,
        host: row.host,
        port: row.port,
        protocol: row.protocol,
        hasUsername: row.usernameEncrypted !== null,
        hasPassword: row.passwordEncrypted !== null,
        enabled: row.enabled,
        weight: row.weight,
        country: row.country,
        notes: row.notes,
        lastCheckedAt: row.lastCheckedAt,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt,
        successCount: row.successCount,
        failureCount: row.failureCount,
        latencyMs: row.latencyMs,
        healthStatus: row.healthStatus,
        quarantinedUntil: row.quarantinedUntil,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function toHealthState(row: ProxyEndpoint): EndpointHealthState {
    return {
        healthStatus: row.healthStatus,
        consecutiveFailures: row.failureCount, // streak semantics — see SCHEMA GAP note
        latencyMs: row.latencyMs,
        quarantinedUntil: row.quarantinedUntil,
    };
}

function validateEndpointInput(host: string, port: number, protocol: string): void {
    try {
        assertHost(host);
        parsePort(String(port));
        assertProtocol(protocol);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CrawlError('DATABASE', `invalid proxy endpoint: ${message}`);
    }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PrismaProxyProfileRepository {
    /**
     * @param prisma    Prisma client.
     * @param masterKey base64 32-byte key (from shared/security loadMasterKey) —
     *                  used to encrypt credentials on write and to decrypt them
     *                  in getEndpointCredentials ONLY.
     */
    constructor(
        private readonly prisma: PrismaClient,
        private readonly masterKey: string,
    ) {}

    // ------------------------------------------------------------------
    // Profile CRUD
    // ------------------------------------------------------------------

    async createProfile(data: ProxyProfileCreateInput): Promise<ProxyProfileRecord> {
        try {
            const row = await this.prisma.proxyProfile.create({
                data: {
                    name: data.name,
                    ...(data.strategy !== undefined ? { strategy: data.strategy } : {}),
                    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
                },
            });
            return toProfileRecord(row);
        } catch (err) {
            throw wrapDbError(err, `proxy profile create failed for '${data.name}'`);
        }
    }

    /** Profiles with endpoint counts and a healthStatus breakdown. Secret-free. */
    async listProfiles(): Promise<ProxyProfileSummary[]> {
        const rows = await this.prisma.proxyProfile.findMany({
            orderBy: { createdAt: 'asc' },
            include: { endpoints: { select: { enabled: true, healthStatus: true } } },
        });
        return rows.map((row) => {
            const healthSummary: ProxyHealthSummary = { unknown: 0, healthy: 0, degraded: 0, unhealthy: 0, disabled: 0 };
            let enabledEndpointCount = 0;
            for (const endpoint of row.endpoints) {
                if (endpoint.enabled) enabledEndpointCount += 1;
                switch (endpoint.healthStatus) {
                    case 'UNKNOWN':
                        healthSummary.unknown += 1;
                        break;
                    case 'HEALTHY':
                        healthSummary.healthy += 1;
                        break;
                    case 'DEGRADED':
                        healthSummary.degraded += 1;
                        break;
                    case 'UNHEALTHY':
                        healthSummary.unhealthy += 1;
                        break;
                    case 'DISABLED':
                        healthSummary.disabled += 1;
                        break;
                }
            }
            return {
                ...toProfileRecord(row),
                endpointCount: row.endpoints.length,
                enabledEndpointCount,
                healthSummary,
            };
        });
    }

    /** Profile + endpoints (credentials masked to hasUsername/hasPassword). */
    async getProfile(id: string): Promise<ProxyProfileDetail | null> {
        const row = await this.prisma.proxyProfile.findUnique({
            where: { id },
            include: { endpoints: { orderBy: { createdAt: 'asc' } } },
        });
        if (row === null) return null;
        return { ...toProfileRecord(row), endpoints: row.endpoints.map(toEndpointRecord) };
    }

    async updateProfile(id: string, patch: ProxyProfileUpdateInput): Promise<ProxyProfileRecord> {
        try {
            const data: Prisma.ProxyProfileUpdateInput = {};
            if (patch.name !== undefined) data.name = patch.name;
            if (patch.strategy !== undefined) data.strategy = patch.strategy;
            if (patch.enabled !== undefined) data.enabled = patch.enabled;
            const row = await this.prisma.proxyProfile.update({ where: { id }, data });
            return toProfileRecord(row);
        } catch (err) {
            throw wrapDbError(err, `proxy profile update failed for ${id}`);
        }
    }

    /** Deletes the profile; endpoints cascade (schema onDelete: Cascade). */
    async deleteProfile(id: string): Promise<void> {
        try {
            await this.prisma.proxyProfile.delete({ where: { id } });
        } catch (err) {
            throw wrapDbError(err, `proxy profile delete failed for ${id}`);
        }
    }

    async setProfileEnabled(id: string, enabled: boolean): Promise<ProxyProfileRecord> {
        try {
            const row = await this.prisma.proxyProfile.update({ where: { id }, data: { enabled } });
            return toProfileRecord(row);
        } catch (err) {
            throw wrapDbError(err, `proxy profile enable toggle failed for ${id}`);
        }
    }

    // ------------------------------------------------------------------
    // Endpoint CRUD (writes encrypt credentials BEFORE save)
    // ------------------------------------------------------------------

    async addEndpoint(profileId: string, data: ProxyEndpointCreateInput): Promise<ProxyEndpointRecord> {
        const protocol = normalizeProxyProtocol(data.protocol ?? 'http');
        validateEndpointInput(data.host, data.port, protocol);
        try {
            const row = await this.prisma.proxyEndpoint.create({
                data: {
                    profileId,
                    name: data.name ?? null,
                    host: data.host.trim(),
                    port: data.port,
                    protocol,
                    usernameEncrypted:
                        data.username !== undefined && data.username !== ''
                            ? encryptSecret(data.username, this.masterKey)
                            : null,
                    passwordEncrypted:
                        data.password !== undefined && data.password !== ''
                            ? encryptSecret(data.password, this.masterKey)
                            : null,
                    enabled: data.enabled ?? true,
                    weight: data.weight ?? 1,
                    country: data.country ?? null,
                    notes: data.notes ?? '',
                },
            });
            return toEndpointRecord(row);
        } catch (err) {
            throw wrapDbError(err, `endpoint create failed for ${data.host}:${data.port}`);
        }
    }

    /**
     * Partial update. Credential tri-state: omitted = keep existing;
     * '' | null = clear; any other string = re-encrypt & store. Clearing the
     * username also clears the stored password unless a new password is
     * supplied in the same patch (credentials are a pair).
     */
    async updateEndpoint(id: string, patch: ProxyEndpointUpdateInput): Promise<ProxyEndpointRecord> {
        try {
            const data: Prisma.ProxyEndpointUpdateInput = {};
            if (patch.name !== undefined) data.name = patch.name;
            if (patch.host !== undefined) data.host = patch.host.trim();
            if (patch.port !== undefined) data.port = patch.port;
            if (patch.protocol !== undefined) data.protocol = normalizeProxyProtocol(patch.protocol);
            if (patch.enabled !== undefined) data.enabled = patch.enabled;
            if (patch.weight !== undefined) data.weight = patch.weight;
            if (patch.country !== undefined) data.country = patch.country;
            if (patch.notes !== undefined) data.notes = patch.notes;
            if (patch.username !== undefined) {
                if (patch.username === null || patch.username === '') {
                    data.usernameEncrypted = null;
                    if (patch.password === undefined) data.passwordEncrypted = null;
                } else {
                    data.usernameEncrypted = encryptSecret(patch.username, this.masterKey);
                }
            }
            if (patch.password !== undefined) {
                data.passwordEncrypted =
                    patch.password === null || patch.password === '' ? null : encryptSecret(patch.password, this.masterKey);
            }
            if ((patch.host !== undefined || patch.port !== undefined || patch.protocol !== undefined)) {
                const row = await this.prisma.proxyEndpoint.findUnique({ where: { id } });
                if (row === null) throw new CrawlError('DATABASE', `endpoint not found: ${id}`);
                validateEndpointInput(
                    patch.host ?? row.host,
                    patch.port ?? row.port,
                    patch.protocol !== undefined ? normalizeProxyProtocol(patch.protocol) : row.protocol,
                );
            }
            const row = await this.prisma.proxyEndpoint.update({ where: { id }, data });
            return toEndpointRecord(row);
        } catch (err) {
            throw wrapDbError(err, `endpoint update failed for ${id}`);
        }
    }

    async deleteEndpoint(id: string): Promise<void> {
        try {
            await this.prisma.proxyEndpoint.delete({ where: { id } });
        } catch (err) {
            throw wrapDbError(err, `endpoint delete failed for ${id}`);
        }
    }

    /**
     * Enable: health resets to UNKNOWN with quarantine cleared (fresh evidence
     * required). Disable: healthStatus becomes DISABLED (operator-owned state,
     * excluded from usable listings and untouched by health transitions).
     */
    async setEndpointEnabled(id: string, enabled: boolean): Promise<ProxyEndpointRecord> {
        try {
            const row = await this.prisma.proxyEndpoint.update({
                where: { id },
                data: enabled
                    ? { enabled: true, healthStatus: 'UNKNOWN', quarantinedUntil: null }
                    : { enabled: false, healthStatus: 'DISABLED' },
            });
            return toEndpointRecord(row);
        } catch (err) {
            throw wrapDbError(err, `endpoint enable toggle failed for ${id}`);
        }
    }

    // ------------------------------------------------------------------
    // Bulk import
    // ------------------------------------------------------------------

    /**
     * Imports conventional proxy lines (see parseProxyEndpointLine) into the
     * profile. NEVER throws on a bad line — per-line failures are collected
     * with masked content. Throws only when the profile itself is missing.
     */
    async importEndpoints(profileId: string, text: string): Promise<ProxyImportResult> {
        const profile = await this.prisma.proxyProfile.findUnique({ where: { id: profileId }, select: { id: true } });
        if (profile === null) {
            throw new CrawlError('DATABASE', `proxy profile not found: ${profileId}`);
        }
        const { endpoints, failed } = parseProxyImportText(text);
        const failures: ProxyImportFailure[] = [...failed];
        let imported = 0;
        for (const endpoint of endpoints) {
            try {
                await this.addEndpoint(profileId, endpoint);
                imported += 1;
            } catch (err) {
                failures.push({
                    line: `${endpoint.protocol}://${endpoint.host}:${endpoint.port}`,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return { imported, failed: failures };
    }

    // ------------------------------------------------------------------
    // Health bookkeeping (transitions are the pure functions above)
    // ------------------------------------------------------------------

    async recordHealthSuccess(endpointId: string, latencyMs: number): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                const row = await tx.proxyEndpoint.findUnique({ where: { id: endpointId } });
                if (row === null) throw new CrawlError('DATABASE', `endpoint not found: ${endpointId}`);
                const next = applyHealthSuccess(toHealthState(row), latencyMs);
                const now = new Date();
                await tx.proxyEndpoint.update({
                    where: { id: endpointId },
                    data: {
                        healthStatus: next.healthStatus,
                        failureCount: next.consecutiveFailures, // streak — see SCHEMA GAP note
                        latencyMs: next.latencyMs,
                        quarantinedUntil: next.quarantinedUntil,
                        successCount: { increment: 1 },
                        lastCheckedAt: now,
                        lastSuccessAt: now,
                    },
                });
            });
        } catch (err) {
            throw wrapDbError(err, `recordHealthSuccess failed for endpoint ${endpointId}`);
        }
    }

    /**
     * @param _error failure description — accepted for caller-side logging;
     *               NOT persisted here (no column) and never logged by this
     *               repository (raw checker messages may embed proxy URLs).
     */
    async recordHealthFailure(endpointId: string, _error: string): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                const row = await tx.proxyEndpoint.findUnique({ where: { id: endpointId } });
                if (row === null) throw new CrawlError('DATABASE', `endpoint not found: ${endpointId}`);
                const next = applyHealthFailure(toHealthState(row), new Date());
                const now = new Date();
                await tx.proxyEndpoint.update({
                    where: { id: endpointId },
                    data: {
                        healthStatus: next.healthStatus,
                        failureCount: next.consecutiveFailures, // streak — see SCHEMA GAP note
                        latencyMs: next.latencyMs,
                        quarantinedUntil: next.quarantinedUntil,
                        lastCheckedAt: now,
                        lastFailureAt: now,
                    },
                });
            });
        } catch (err) {
            throw wrapDbError(err, `recordHealthFailure failed for endpoint ${endpointId}`);
        }
    }

    /**
     * Endpoints eligible for crawl use: enabled, not DISABLED, and not inside
     * an active quarantine window. Credentials masked (hasUsername/hasPassword).
     */
    async listUsableEndpoints(profileId: string): Promise<ProxyEndpointRecord[]> {
        const now = new Date();
        const rows = await this.prisma.proxyEndpoint.findMany({
            where: {
                profileId,
                enabled: true,
                healthStatus: { not: 'DISABLED' },
                OR: [{ quarantinedUntil: null }, { quarantinedUntil: { lte: now } }],
            },
            orderBy: [{ weight: 'desc' }, { createdAt: 'asc' }],
        });
        return rows.map(toEndpointRecord);
    }

    /**
     * THE ONLY DECRYPTION PATH in this repository — worker use only
     * (ProxyProvider builds conventional proxy URLs from the result).
     * API/UI layers must NEVER call this method; all other reads return
     * hasUsername/hasPassword presence booleans instead of secret material.
     */
    async getEndpointCredentials(endpointId: string): Promise<{ username: string | null; password: string | null }> {
        const row = await this.prisma.proxyEndpoint.findUnique({
            where: { id: endpointId },
            select: { usernameEncrypted: true, passwordEncrypted: true },
        });
        if (row === null) throw new CrawlError('DATABASE', `endpoint not found: ${endpointId}`);
        return {
            username: row.usernameEncrypted !== null ? decryptSecret(row.usernameEncrypted, this.masterKey) : null,
            password: row.passwordEncrypted !== null ? decryptSecret(row.passwordEncrypted, this.masterKey) : null,
        };
    }
}

/** All persistence failures cross the boundary as CrawlError('DATABASE'). */
function wrapDbError(err: unknown, context: string): CrawlError {
    if (err instanceof CrawlError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CrawlError('DATABASE', `${context}: ${message}`, err);
}
