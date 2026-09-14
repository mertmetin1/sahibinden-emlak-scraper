/**
 * PrismaCookieProfileRepository — encrypted cookie profiles (authorized,
 * user-supplied sahibinden.com session cookies).
 *
 * SECRET HYGIENE (ARCHITECTURE.md §10, ADR-0005):
 * - The normalized cookie JSON array is encrypted via shared/security
 *   `encryptSecret` BEFORE save (CookieProfile.encryptedCookieJson holds only
 *   the AES-256-GCM `v1:` envelope).
 * - listProfiles/getProfile return METADATA ONLY (cookieCount, domainSummary,
 *   expirySummary, validationStatus, ...) — the ciphertext column is never
 *   selected, let alone decrypted, on read paths.
 * - `getCookiesDecrypted()` is the ONLY decryption path — worker use only
 *   (SessionProvider). API/UI layers must never call it.
 * - Normalization issues are indexed and secret-free (no cookie names/values,
 *   per §9.3).
 *
 * WIRING: requires `export * from './security.js';` in shared/src/index.ts
 * (Lead's export wiring) for the security helpers to resolve.
 */
import { CrawlError, decryptSecret, encryptSecret, normalizeCookieExport, summarizeCookies } from '@sahibindenbot/shared';
import type { CookieParam } from '@sahibindenbot/shared';
import type { CookieProfile, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Enum mirror (string values identical to prisma/schema.prisma)
// ---------------------------------------------------------------------------

export type CookieValidationStatusValue = 'UNKNOWN' | 'VALID' | 'EXPIRED' | 'INVALID';

// ---------------------------------------------------------------------------
// DTOs — metadata only, never the ciphertext
// ---------------------------------------------------------------------------

export interface CookieProfileMetadata {
    id: string;
    name: string;
    enabled: boolean;
    domainSummary: string;
    cookieCount: number;
    expirySummary: string;
    lastValidatedAt: Date | null;
    validationStatus: CookieValidationStatusValue;
    notes: string;
    /** Number of ScanDefinitions referencing this profile. */
    assignedScanCount: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface CookieProfileDetail extends CookieProfileMetadata {
    /** Scan definitions using this profile (id + name only). */
    assignedScans: Array<{ id: string; name: string }>;
}

export interface CookieImportResult {
    profile: CookieProfileMetadata;
    /** Indexed, secret-free normalization problems (dropped cookies etc.). */
    issues: string[];
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

type CookieProfileWithCount = CookieProfile & { _count: { scanDefinitions: number } };

function toMetadata(row: CookieProfileWithCount): CookieProfileMetadata {
    return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        domainSummary: row.domainSummary,
        cookieCount: row.cookieCount,
        expirySummary: row.expirySummary,
        lastValidatedAt: row.lastValidatedAt,
        validationStatus: row.validationStatus,
        notes: row.notes,
        assignedScanCount: row._count.scanDefinitions,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

const COUNT_INCLUDE = { _count: { select: { scanDefinitions: true } } } as const;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PrismaCookieProfileRepository {
    /**
     * @param prisma    Prisma client.
     * @param masterKey base64 32-byte key (from shared/security loadMasterKey) —
     *                  used to encrypt cookie JSON on write and to decrypt it
     *                  in getCookiesDecrypted ONLY.
     */
    constructor(
        private readonly prisma: PrismaClient,
        private readonly masterKey: string,
    ) {}

    /**
     * Imports a cookie export (EditThisCookie / Cookie-Editor / raw header —
     * see shared/security normalizeCookieExport), encrypts the normalized
     * array, and persists display metadata. validationStatus starts VALID
     * when at least one usable cookie survived normalization, else INVALID.
     * Never throws on malformed cookie entries — they land in `issues`.
     */
    async importCookies(name: string, rawJson: unknown, notes?: string): Promise<CookieImportResult> {
        const { cookies, issues } = normalizeCookieExport(rawJson);
        const summary = summarizeCookies(cookies);
        try {
            const row = await this.prisma.cookieProfile.create({
                data: {
                    name,
                    enabled: true,
                    encryptedCookieJson: encryptSecret(JSON.stringify(cookies), this.masterKey),
                    domainSummary: summary.domainSummary,
                    cookieCount: summary.cookieCount,
                    expirySummary: summary.expirySummary,
                    validationStatus: cookies.length > 0 ? 'VALID' : 'INVALID',
                    notes: notes ?? '',
                },
                include: COUNT_INCLUDE,
            });
            return { profile: toMetadata(row), issues };
        } catch (err) {
            throw wrapDbError(err, `cookie profile import failed for '${name}'`);
        }
    }

    /** Metadata list — ciphertext is never selected. */
    async listProfiles(): Promise<CookieProfileMetadata[]> {
        const rows = await this.prisma.cookieProfile.findMany({
            orderBy: { createdAt: 'asc' },
            include: COUNT_INCLUDE,
        });
        return rows.map(toMetadata);
    }

    /** Metadata + assigned scans — ciphertext is never selected. */
    async getProfile(id: string): Promise<CookieProfileDetail | null> {
        const row = await this.prisma.cookieProfile.findUnique({
            where: { id },
            include: {
                ...COUNT_INCLUDE,
                scanDefinitions: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } },
            },
        });
        if (row === null) return null;
        return { ...toMetadata(row), assignedScans: row.scanDefinitions.map((s) => ({ id: s.id, name: s.name })) };
    }

    /**
     * Re-normalizes and re-encrypts the cookie set, refreshing the metadata
     * summaries and validationStatus. `updatedAt` bumps via @updatedAt.
     */
    async replaceCookies(id: string, rawJson: unknown): Promise<CookieImportResult> {
        const { cookies, issues } = normalizeCookieExport(rawJson);
        const summary = summarizeCookies(cookies);
        try {
            const row = await this.prisma.cookieProfile.update({
                where: { id },
                data: {
                    encryptedCookieJson: encryptSecret(JSON.stringify(cookies), this.masterKey),
                    domainSummary: summary.domainSummary,
                    cookieCount: summary.cookieCount,
                    expirySummary: summary.expirySummary,
                    validationStatus: cookies.length > 0 ? 'VALID' : 'INVALID',
                },
                include: COUNT_INCLUDE,
            });
            return { profile: toMetadata(row), issues };
        } catch (err) {
            throw wrapDbError(err, `cookie replace failed for profile ${id}`);
        }
    }

    async setEnabled(id: string, enabled: boolean): Promise<CookieProfileMetadata> {
        try {
            const row = await this.prisma.cookieProfile.update({ where: { id }, data: { enabled }, include: COUNT_INCLUDE });
            return toMetadata(row);
        } catch (err) {
            throw wrapDbError(err, `cookie profile enable toggle failed for ${id}`);
        }
    }

    /** ScanDefinitions referencing the profile are SetNull-detached by the schema. */
    async deleteProfile(id: string): Promise<void> {
        try {
            await this.prisma.cookieProfile.delete({ where: { id } });
        } catch (err) {
            throw wrapDbError(err, `cookie profile delete failed for ${id}`);
        }
    }

    async updateNotes(id: string, notes: string): Promise<CookieProfileMetadata> {
        try {
            const row = await this.prisma.cookieProfile.update({ where: { id }, data: { notes }, include: COUNT_INCLUDE });
            return toMetadata(row);
        } catch (err) {
            throw wrapDbError(err, `cookie profile notes update failed for ${id}`);
        }
    }

    /** Records a validation outcome (worker cookie check) with its timestamp. */
    async markValidated(id: string, status: CookieValidationStatusValue): Promise<CookieProfileMetadata> {
        try {
            const row = await this.prisma.cookieProfile.update({
                where: { id },
                data: { validationStatus: status, lastValidatedAt: new Date() },
                include: COUNT_INCLUDE,
            });
            return toMetadata(row);
        } catch (err) {
            throw wrapDbError(err, `cookie profile validation mark failed for ${id}`);
        }
    }

    /**
     * THE ONLY DECRYPTION PATH in this repository — worker use only
     * (SessionProvider). API/UI layers must NEVER call this method; all other
     * reads return metadata only.
     */
    async getCookiesDecrypted(id: string): Promise<CookieParam[]> {
        const row = await this.prisma.cookieProfile.findUnique({
            where: { id },
            select: { encryptedCookieJson: true },
        });
        if (row === null) throw new CrawlError('DATABASE', `cookie profile not found: ${id}`);
        let parsed: unknown;
        try {
            parsed = JSON.parse(decryptSecret(row.encryptedCookieJson, this.masterKey));
        } catch (err) {
            throw wrapDbError(err, `cookie profile ${id} failed decryption/parse`);
        }
        if (!Array.isArray(parsed)) {
            throw new CrawlError('DATABASE', `cookie profile ${id} decrypted payload is not an array`);
        }
        // Justified cast: the stored JSON was produced by JSON.stringify of a
        // normalized CookieParam[] at import/replace time (this class is the
        // only writer), so the shape is guaranteed by construction.
        return parsed as CookieParam[];
    }
}

/** All persistence failures cross the boundary as CrawlError('DATABASE'). */
function wrapDbError(err: unknown, context: string): CrawlError {
    if (err instanceof CrawlError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CrawlError('DATABASE', `${context}: ${message}`, err);
}
