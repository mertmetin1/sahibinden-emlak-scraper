/**
 * Proxy providers. Replaces `Actor.createProxyConfiguration` — there is no
 * Apify proxy anymore; users supply conventional proxy URLs (or none).
 *
 * Credential hygiene: proxy URLs may embed user:pass. They are NEVER logged
 * in full — `redactProxyUrl` reduces them to protocol://host:port.
 */
import type { ProxyProvider, RuntimeLogger } from '@sahibindenbot/shared';
import { crawlError } from '../engine/errors.js';

/** protocol://[user:pass@]host:port — port is mandatory. */
const PROXY_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/@\s]+:[^/@\s]+@)?[^/:@\s]+:\d+\/?$/;

/** protocol://host:port — credentials stripped. Safe for logs. */
export function redactProxyUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch {
        return '<malformed proxy URL>';
    }
}

/** Static list of conventional proxy URLs; empty list = direct connection. */
export class StaticProxyProvider implements ProxyProvider {
    constructor(
        private readonly urls: string[],
        private readonly logger?: RuntimeLogger,
    ) {
        urls.forEach((url, i) => {
            if (!PROXY_URL_PATTERN.test(url)) {
                throw new Error(
                    `Malformed proxy URL at index ${i} (expected protocol://[user:pass@]host:port): ${redactProxyUrl(url)}`,
                );
            }
        });
    }

    async getProxyConfiguration(): Promise<unknown | null> {
        if (this.urls.length === 0) return null;
        this.logger?.info('Using static proxy list', { proxies: this.urls.map(redactProxyUrl) });
        const { ProxyConfiguration } = await import('crawlee');
        return new ProxyConfiguration({ proxyUrls: this.urls });
    }
}

/** Always direct — explicit no-proxy choice. */
export class NullProxyProvider implements ProxyProvider {
    constructor(private readonly logger?: RuntimeLogger) {}

    async getProxyConfiguration(): Promise<null> {
        this.logger?.warn('No proxy configured — crawling direct.');
        return null;
    }
}

// ---------------------------------------------------------------------------
// ProfileProxyProvider — DB-agnostic adapter for ProxyProfile rows (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Plain, decrypted endpoint data — mirrors the worker's ProxyEndpoint row
 * AFTER the worker decrypts `encryptedUrl` (AES-256-GCM, ARCHITECTURE.md
 * §10). This package never sees ciphertext and never touches the DB.
 */
export interface ProxyEndpointInput {
    host: string;
    port: number;
    /** 'http' | 'https' | 'socks4' | 'socks5' (case-insensitive; '://' suffix tolerated). */
    protocol: string;
    username: string | null;
    password: string | null;
    /**
     * Relative selection weight — the endpoint is repeated `weight` times in
     * Crawlee's rotation list, so weight-2 endpoints are picked ~2x as often.
     * Default 1.
     */
    weight?: number;
}

/**
 * ProxyProfile.strategy (ARCHITECTURE.md §5):
 * - ROUND_ROBIN: Crawlee's default rotation over the proxyUrls array.
 * - SESSION_STICKY: same Crawlee session always lands on the same endpoint.
 */
export type ProxyRotationStrategy = 'ROUND_ROBIN' | 'SESSION_STICKY';

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http', 'https', 'socks4', 'socks5']);

/** Normalizes a protocol string: lowercase, trims whitespace and any '://'/':' suffix. */
export function normalizeProxyProtocol(raw: string): string {
    return raw.trim().toLowerCase().replace(/:\/\/$/, '').replace(/:$/, '');
}

/**
 * Builds a conventional proxy URL from plain endpoint parts.
 * Credentials are percent-encoded; host is validated loosely (the final
 * `new URL` parse is the authoritative check).
 */
export function buildProxyUrl(endpoint: ProxyEndpointInput): string {
    const protocol = normalizeProxyProtocol(endpoint.protocol);
    const auth =
        endpoint.username !== null && endpoint.username !== ''
            ? `${encodeURIComponent(endpoint.username)}:${encodeURIComponent(endpoint.password ?? '')}@`
            : '';
    return `${protocol}://${auth}${endpoint.host}:${endpoint.port}`;
}

/** Redacted `protocol://host:port` — the ONLY representation safe for logs. */
export function describeEndpoint(endpoint: ProxyEndpointInput): string {
    return `${normalizeProxyProtocol(endpoint.protocol)}://${endpoint.host}:${endpoint.port}`;
}

function validateEndpoint(endpoint: ProxyEndpointInput, index: number): void {
    const where = `endpoint[${index}] (${endpoint?.host ?? '<missing>'}:${endpoint?.port ?? '<missing>'})`;
    const fail = (reason: string): never => {
        // Never include username/password in the message — host:port only.
        throw crawlError('PROXY_ERROR', `Malformed proxy ${where}: ${reason}`);
    };
    if (typeof endpoint !== 'object' || endpoint === null) fail('not an object');
    if (typeof endpoint.host !== 'string' || endpoint.host.trim().length === 0) fail('host is required');
    if (/[\s/@]/.test(endpoint.host)) fail('host must not contain whitespace, "/" or "@"');
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
        fail('port must be an integer between 1 and 65535');
    }
    if (typeof endpoint.protocol !== 'string' || !SUPPORTED_PROXY_PROTOCOLS.has(normalizeProxyProtocol(endpoint.protocol))) {
        fail(`protocol must be one of ${[...SUPPORTED_PROXY_PROTOCOLS].join('/')}`);
    }
    if (endpoint.username !== null && typeof endpoint.username !== 'string') fail('username must be a string or null');
    if (endpoint.password !== null && typeof endpoint.password !== 'string') fail('password must be a string or null');
    if (endpoint.password && (endpoint.username === null || endpoint.username === '')) {
        fail('password without username');
    }
    if (endpoint.weight !== undefined && (!Number.isInteger(endpoint.weight) || endpoint.weight < 1)) {
        fail('weight must be a positive integer');
    }
    // Authoritative parse check of the assembled URL.
    try {
        new URL(buildProxyUrl(endpoint));
    } catch (err) {
        throw crawlError('PROXY_ERROR', `Malformed proxy ${where}: assembled URL does not parse`, err);
    }
}

/**
 * Builds a Crawlee ProxyConfiguration from a ProxyProfile's decrypted
 * endpoints. Empty endpoint list → null (direct connection).
 *
 * Stickiness evidence (Crawlee 3.18.x, satisfies ^3.13): with
 * `useSessionPool`, BrowserCrawler calls
 * `proxyConfiguration.newProxyInfo(session?.id, …)` (browser-crawler.js),
 * which flows to `ProxyConfiguration._handleCustomUrl(sessionId)`
 * (core/proxy_configuration.js). That method memoizes
 * `sessionId → proxyUrl` in `usedProxyUrls`, so the SAME session always
 * receives the SAME endpoint — and a sessionless call round-robins via
 * `nextCustomUrlIndex`. Plain `proxyUrls` therefore implements BOTH
 * strategies; no `newUrlFunction` is required for SESSION_STICKY.
 */
export class ProfileProxyProvider implements ProxyProvider {
    private readonly proxyUrls: string[];
    private readonly strategy: ProxyRotationStrategy;
    private readonly logger?: RuntimeLogger;
    private readonly endpoints: ProxyEndpointInput[];

    constructor(endpoints: ProxyEndpointInput[], strategy: ProxyRotationStrategy = 'ROUND_ROBIN', logger?: RuntimeLogger) {
        if (strategy !== 'ROUND_ROBIN' && strategy !== 'SESSION_STICKY') {
            throw crawlError('PROXY_ERROR', `Unknown proxy rotation strategy: ${String(strategy)}`);
        }
        if (!Array.isArray(endpoints)) {
            throw crawlError('PROXY_ERROR', 'Proxy endpoints must be an array');
        }
        endpoints.forEach((endpoint, i) => validateEndpoint(endpoint, i));
        this.endpoints = endpoints;
        this.strategy = strategy;
        this.logger = logger;
        // Weighted rotation: an endpoint with weight w appears w times.
        this.proxyUrls = endpoints.flatMap(e => {
            const url = buildProxyUrl(e);
            return Array.from({ length: e.weight ?? 1 }, () => url);
        });
    }

    /** Redacted endpoint list (`protocol://host:port`) — safe for logs/UI. */
    describe(): string[] {
        return this.endpoints.map(describeEndpoint);
    }

    async getProxyConfiguration(): Promise<unknown | null> {
        if (this.proxyUrls.length === 0) return null;
        this.logger?.info('Using proxy profile', {
            strategy: this.strategy,
            endpoints: this.describe(),
        });
        const { ProxyConfiguration } = await import('crawlee');
        return new ProxyConfiguration({ proxyUrls: this.proxyUrls });
    }
}
