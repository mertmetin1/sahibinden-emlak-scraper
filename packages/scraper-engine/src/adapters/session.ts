/**
 * Session providers — supply authorized, user-exported cookies (the one
 * sanctioned anti-block mechanism, audit §11). Replaces the `sessionCookies`
 * Actor input.
 *
 * File format: EditThisCookie / Cookie-Editor JSON array export. Raw shapes
 * are normalized here (`key`→`name`, `expirationDate`→`expires` unix secs,
 * `no_restriction`→`None`); expired and nameless entries are dropped.
 */
import { readFile } from 'node:fs/promises';
import type { CookieParam, RuntimeLogger, SessionProvider } from '@sahibindenbot/shared';

/** Raw cookie export entry — every field unknown until validated. */
interface RawCookieExport {
    name?: unknown;
    key?: unknown;
    value?: unknown;
    domain?: unknown;
    path?: unknown;
    expirationDate?: unknown;
    expires?: unknown;
    secure?: unknown;
    httpOnly?: unknown;
    sameSite?: unknown;
}

function normalizeSameSite(value: unknown): CookieParam['sameSite'] {
    if (typeof value !== 'string') return undefined;
    const v = value.toLowerCase();
    if (v === 'strict') return 'Strict';
    if (v === 'lax') return 'Lax';
    if (v === 'no_restriction' || v === 'none') return 'None';
    return undefined;
}

/**
 * Normalizes one raw export entry into a CookieParam.
 * Returns null for nameless or expired entries (dropped by the caller).
 */
export function normalizeCookieExport(raw: unknown): CookieParam | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const c = raw as RawCookieExport;

    // Some exporters use 'key' instead of 'name' (upstream main.js:291).
    const name =
        typeof c.name === 'string' && c.name.length > 0
            ? c.name
            : typeof c.key === 'string' && c.key.length > 0
              ? c.key
              : null;
    if (!name) return null;

    const value = typeof c.value === 'string' ? c.value : String(c.value ?? '');

    // Expiry: expirationDate ?? expires, unix seconds (may be fractional).
    const expRaw =
        typeof c.expirationDate === 'number'
            ? c.expirationDate
            : typeof c.expires === 'number'
              ? c.expires
              : undefined;
    const expires = expRaw !== undefined ? Math.floor(expRaw) : undefined;
    // expires <= 0 means "session cookie" in common exporters — treat as absent.
    if (expires !== undefined && expires > 0 && expires < Date.now() / 1000) return null; // expired

    const out: CookieParam = { name, value };
    if (typeof c.domain === 'string' && c.domain.length > 0) out.domain = c.domain;
    if (typeof c.path === 'string' && c.path.length > 0) out.path = c.path;
    if (expires !== undefined && expires > 0) out.expires = expires;
    if (typeof c.secure === 'boolean') out.secure = c.secure;
    if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
    const sameSite = normalizeSameSite(c.sameSite);
    if (sameSite) out.sameSite = sameSite;
    return out;
}

/** Reads cookies from a JSON file on disk (gitignored — contains secrets). */
export class FileSessionProvider implements SessionProvider {
    constructor(
        private readonly filePath: string,
        private readonly logger?: RuntimeLogger,
    ) {}

    async getCookies(): Promise<CookieParam[]> {
        let raw: string;
        try {
            raw = await readFile(this.filePath, 'utf8');
        } catch (err) {
            this.logger?.warn('Session cookies file not readable — continuing without cookies', {
                path: this.filePath,
                error: (err as Error).message,
            });
            return [];
        }

        // Malformed JSON throws on purpose: a broken secrets file is a loud
        // config error, not a silent empty session.
        const json: unknown = JSON.parse(raw);
        if (!Array.isArray(json)) {
            throw new Error(`Session cookies file must contain a JSON array: ${this.filePath}`);
        }

        const cookies = json
            .map(normalizeCookieExport)
            .filter((c): c is CookieParam => c !== null);
        const dropped = json.length - cookies.length;
        if (dropped > 0) {
            this.logger?.warn(`Dropped ${dropped} expired/nameless cookies`, { path: this.filePath });
        }
        return cookies;
    }
}

/** In-memory cookies (tests, programmatic use). */
export class StaticSessionProvider implements SessionProvider {
    constructor(private readonly cookies: CookieParam[]) {}

    async getCookies(): Promise<CookieParam[]> {
        return this.cookies;
    }
}
