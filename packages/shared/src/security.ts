/**
 * Security primitives — secret encryption at rest, log redaction, and
 * cookie-export normalization. Framework-free; the ONLY dependency is
 * node:crypto. See docs/ARCHITECTURE.md §10 and docs/adr/0005.
 *
 * Encryption: AES-256-GCM, single application master key (`APP_SECRET_KEY`,
 * 32 bytes base64). Envelope format (single text column):
 *
 *     v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * Fresh random 12-byte IV per record, 16-byte GCM auth tag. The `v1` prefix
 * versions the scheme for future rotation/algorithm changes.
 *
 * Write-only contract: secrets are accepted on create/update and NEVER
 * returned by read paths; decryption happens exclusively inside the worker.
 * `redactSecrets`/`redactProxyUrl` are the defense-in-depth net that keeps
 * secrets out of logs, run events, and error messages (ARCHITECTURE.md §9.3).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { CookieParam } from './types.js';

// ---------------------------------------------------------------------------
// AES-256-GCM secret box
// ---------------------------------------------------------------------------

export const SECRET_ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12; // 96-bit IV — the GCM recommendation
const AUTH_TAG_BYTES = 16;
const MASTER_KEY_BYTES = 32; // AES-256

/** Decodes and validates a base64 master key. Throws a clear error on bad input. */
function decodeMasterKey(keyBase64: string): Buffer {
    const trimmed = keyBase64.trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
        throw new Error('master key is not valid base64 (expected 32 bytes, base64-encoded)');
    }
    const key = Buffer.from(trimmed, 'base64');
    if (key.length !== MASTER_KEY_BYTES) {
        throw new Error(`master key must decode to exactly ${MASTER_KEY_BYTES} bytes, got ${key.length}`);
    }
    return key;
}

function encryptWithKey(plaintext: string, key: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [SECRET_ENVELOPE_VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
        ':',
    );
}

function decryptWithKey(envelope: string, key: Buffer): string {
    const parts = envelope.split(':');
    if (parts.length !== 4) {
        throw new Error('invalid secret envelope (expected v1:<iv>:<authTag>:<ciphertext>)');
    }
    // Justified cast: length asserted above (noUncheckedIndexedAccess still
    // types destructured entries as string | undefined).
    const [version, ivB64, authTagB64, ciphertextB64] = parts as [string, string, string, string];
    if (version !== SECRET_ENVELOPE_VERSION) {
        throw new Error(`unsupported secret envelope version '${version}'`);
    }
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');
    if (iv.length !== IV_BYTES) throw new Error('invalid secret envelope: bad IV length');
    if (authTag.length !== AUTH_TAG_BYTES) throw new Error('invalid secret envelope: bad auth tag length');
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        // GCM auth failure: wrong key or tampered ciphertext/tag. The original
        // error message is deliberately swallowed — it must not leak details.
        throw new Error('secret decryption failed (wrong key or tampered envelope)');
    }
}

/**
 * Encrypts a UTF-8 secret into the `v1:` envelope format.
 * `keyBase64` must be a base64-encoded 32-byte key (see loadMasterKey).
 */
export function encryptSecret(plaintext: string, keyBase64: string): string {
    return encryptWithKey(plaintext, decodeMasterKey(keyBase64));
}

/**
 * Decrypts a `v1:` envelope. Throws on malformed envelopes, wrong keys, and
 * tampered ciphertext/auth tags (GCM authentication).
 */
export function decryptSecret(envelope: string, keyBase64: string): string {
    return decryptWithKey(envelope, decodeMasterKey(keyBase64));
}

/** Eagerly-validated encrypt/decrypt pair bound to one key (ADR-0005's `createSecretBox`). */
export interface SecretBox {
    encrypt(plaintext: string): string;
    decrypt(envelope: string): string;
}

/** Validates the key NOW (fail fast at wiring time), then returns pure closures. */
export function createSecretBox(keyBase64: string): SecretBox {
    const key = decodeMasterKey(keyBase64);
    return {
        encrypt: (plaintext) => encryptWithKey(plaintext, key),
        decrypt: (envelope) => decryptWithKey(envelope, key),
    };
}

/**
 * Loads and validates the master key from the environment (default:
 * process.env). Fails fast with a clear, secret-free message when the key is
 * missing, not base64, or not exactly 32 bytes decoded. Returns the validated
 * base64 key string for injection into repositories/providers.
 */
export function loadMasterKey(env: { APP_SECRET_KEY?: string } = process.env): string {
    const raw = env.APP_SECRET_KEY;
    if (raw === undefined || raw.trim() === '') {
        throw new Error(
            'APP_SECRET_KEY is not set — generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
        );
    }
    const trimmed = raw.trim();
    try {
        // base64 alphabet + exact 32-byte length validation.
        decodeMasterKey(trimmed);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`APP_SECRET_KEY invalid: ${detail}`);
    }
    return trimmed;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Key names that must never reach logs/events at any depth (ARCHITECTURE.md §9.3). */
const SENSITIVE_KEY_PATTERN = /password|passwd|token|secret|cookie|authorization|auth/i;

/** scheme://user:pass@host — credential-bearing URLs inside arbitrary strings. */
const CREDENTIAL_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]*@[^\s]+/gi;

const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';
const DEPTH_LIMIT = '[DEPTH_LIMIT]';
const MAX_REDACT_DEPTH = 6;

/**
 * Redacts a proxy URL for logs: strips userinfo entirely, keeping only
 * `protocol://host:port` (path/query dropped — proxy URLs must not carry
 * them, and query strings can themselves leak secrets). Handles
 * http/https/socks4/socks5 (and any other scheme with an authority).
 * Malformed input → '<invalid-url>'.
 */
export function redactProxyUrl(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return '<invalid-url>';
    }
    // A URL without an authority (e.g. 'host:8080' parsed as scheme 'host:')
    // is not a usable proxy URL.
    if (parsed.host === '') return '<invalid-url>';
    return `${parsed.protocol}//${parsed.host}`;
}

function redactString(value: string): string {
    if (!value.includes('://')) return value;
    return value.replace(CREDENTIAL_URL_PATTERN, (match) => redactProxyUrl(match));
}

/**
 * Deep-redaction for arbitrary log/event objects:
 * - any key matching /password|passwd|token|secret|cookie|authorization|auth/i
 *   at any depth → '[REDACTED]' (intentionally aggressive: 'auth' also covers
 *   'author'-like keys — false positives are acceptable, leaks are not);
 * - string values containing credential-bearing URLs (scheme://user:pass@host)
 *   are redacted via redactProxyUrl (userinfo stripped, host kept);
 * - arrays and plain objects are recursed (a transformed COPY is returned;
 *   the input is never mutated);
 * - circular references → '[CIRCULAR]'; nesting beyond depth 6 → '[DEPTH_LIMIT]';
 * - Date instances pass through untouched.
 */
export function redactSecrets<T>(input: T): T {
    return redactValue(input, 0, new WeakSet()) as T;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (seen.has(value)) return CIRCULAR;
    if (depth >= MAX_REDACT_DEPTH) return DEPTH_LIMIT;
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => redactValue(item, depth + 1, seen));
        }
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(item, depth + 1, seen);
        }
        return out;
    } finally {
        // Path-based cycle detection: a sibling reference to the same object
        // (diamond, not a cycle) must NOT be marked circular.
        seen.delete(value);
    }
}

// ---------------------------------------------------------------------------
// Cookie export normalization (EditThisCookie / Cookie-Editor / raw header)
// ---------------------------------------------------------------------------

export interface CookieNormalizationResult {
    cookies: CookieParam[];
    /**
     * Per-cookie problems, referenced by INDEX ONLY — cookie names and values
     * are secret-adjacent (ARCHITECTURE.md §9.3) and never appear here.
     */
    issues: string[];
}

/**
 * Maps exporter sameSite variants onto the shared CookieParam union.
 * 'no_restriction' → 'None'; lax/strict/none case-insensitive;
 * 'unspecified'/empty/unknown → undefined (attribute omitted).
 */
function normalizeSameSite(raw: unknown): CookieParam['sameSite'] {
    if (typeof raw !== 'string') return undefined;
    switch (raw.trim().toLowerCase()) {
        case 'no_restriction':
        case 'none':
            return 'None';
        case 'lax':
            return 'Lax';
        case 'strict':
            return 'Strict';
        default:
            return undefined;
    }
}

function asOptionalString(raw: unknown): string | undefined {
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

function asOptionalBoolean(raw: unknown): boolean | undefined {
    return typeof raw === 'boolean' ? raw : undefined;
}

/**
 * Normalizes one exported cookie object. Returns null (and records an issue)
 * for nameless or expired entries. Never throws for shape problems — the
 * caller's catch-all handles genuinely hostile input.
 */
function normalizeCookie(item: unknown, index: number, nowSeconds: number, issues: string[]): CookieParam | null {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push(`cookie[${index}]: not an object — skipped`);
        return null;
    }
    const record = item as Record<string, unknown>;

    // name: 'name' (EditThisCookie/Cookie-Editor) with 'key' fallback (older exporters).
    const rawName = record.name ?? record.key;
    const name = typeof rawName === 'string' ? rawName : typeof rawName === 'number' ? String(rawName) : '';
    if (name === '') {
        issues.push(`cookie[${index}]: missing name — skipped`);
        return null;
    }

    const rawValue = record.value;
    const value = typeof rawValue === 'string' ? rawValue : rawValue === undefined || rawValue === null ? '' : String(rawValue);

    // expiry: expirationDate (EditThisCookie/Cookie-Editor) ?? expires.
    // `session: true` forces a session cookie; expires === -1 is the common
    // "session" sentinel (Playwright storage state). Expired → dropped.
    let expires: number | undefined;
    const isSession = record.session === true;
    const rawExpiry = record.expirationDate ?? record.expires;
    if (!isSession && rawExpiry !== undefined && rawExpiry !== null) {
        const parsed = typeof rawExpiry === 'number' ? rawExpiry : typeof rawExpiry === 'string' ? Number(rawExpiry) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
            const seconds = Math.floor(parsed);
            if (seconds <= nowSeconds) {
                issues.push(`cookie[${index}]: expired — skipped`);
                return null;
            }
            expires = seconds;
        } else if (parsed !== -1) {
            issues.push(`cookie[${index}]: unparseable expiry — treated as session cookie`);
        }
    }

    const cookie: CookieParam = { name, value };
    const domain = asOptionalString(record.domain);
    const path = asOptionalString(record.path);
    const secure = asOptionalBoolean(record.secure);
    const httpOnly = asOptionalBoolean(record.httpOnly);
    const sameSite = normalizeSameSite(record.sameSite);
    if (domain !== undefined) cookie.domain = domain;
    if (path !== undefined) cookie.path = path;
    if (expires !== undefined) cookie.expires = expires;
    if (secure !== undefined) cookie.secure = secure;
    if (httpOnly !== undefined) cookie.httpOnly = httpOnly;
    if (sameSite !== undefined) cookie.sameSite = sameSite;
    return cookie;
}

/** Raw `Cookie` request header: "a=1; b=2" — names/values only, no metadata. */
function normalizeRawHeader(header: string, issues: string[]): CookieParam[] {
    const cookies: CookieParam[] = [];
    const pairs = header.split(';');
    for (let index = 0; index < pairs.length; index += 1) {
        const pair = pairs[index] ?? '';
        const eq = pair.indexOf('=');
        const name = eq === -1 ? pair.trim() : pair.slice(0, eq).trim();
        if (eq === -1 || name === '') {
            if (pair.trim() !== '') issues.push(`cookie[${index}]: not a name=value pair — skipped`);
            continue;
        }
        cookies.push({ name, value: pair.slice(eq + 1).trim() });
    }
    return cookies;
}

/**
 * Normalizes a cookie export into shared CookieParam[]. Accepted shapes:
 * - EditThisCookie / Cookie-Editor JSON arrays (`name`/`key`, `value`,
 *   `expirationDate`/`expires` unix seconds, `session`, `sameSite` variants);
 * - an object wrapper with a `cookies` array;
 * - a raw Cookie header string ("a=1; b=2") — a string containing JSON is
 *   parsed as JSON first, falling back to header parsing;
 * Expired and nameless cookies are dropped. NEVER throws — problems are
 * collected into `issues` (indexed, secret-free).
 */
export function normalizeCookieExport(input: unknown): CookieNormalizationResult {
    const issues: string[] = [];
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed === '') return { cookies: [], issues: ['empty cookie export'] };
        // A pasted JSON export arrives as a string too — try JSON first.
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                return normalizeCookieExport(JSON.parse(trimmed));
            } catch {
                // Not JSON after all — fall through to raw-header parsing.
            }
        }
        return { cookies: normalizeRawHeader(trimmed, issues), issues };
    }

    let items: unknown[] | null = null;
    if (Array.isArray(input)) {
        items = input;
    } else if (typeof input === 'object' && input !== null) {
        const wrapped = (input as Record<string, unknown>).cookies;
        if (Array.isArray(wrapped)) items = wrapped;
    }
    if (items === null) {
        return {
            cookies: [],
            issues: ['unsupported export shape — expected a cookie array, { cookies: [...] }, or a raw Cookie header'],
        };
    }

    const cookies: CookieParam[] = [];
    for (let index = 0; index < items.length; index += 1) {
        try {
            const cookie = normalizeCookie(items[index], index, nowSeconds, issues);
            if (cookie !== null) cookies.push(cookie);
        } catch (err) {
            issues.push(`cookie[${index}]: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { cookies, issues };
}

// ---------------------------------------------------------------------------
// Cookie metadata summary (NO values — safe for list/detail API responses)
// ---------------------------------------------------------------------------

export interface CookieSummary {
    /** "'sahibinden.com (41), .google.com (2)'" — domains sorted by count desc. */
    domainSummary: string;
    cookieCount: number;
    /** "'3 session, 38 persistent, soonest expiry 2026-09-15'". */
    expirySummary: string;
}

/** Computes display metadata from normalized cookies. Contains NO cookie values. */
export function summarizeCookies(cookies: CookieParam[]): CookieSummary {
    const byDomain = new Map<string, number>();
    let session = 0;
    let persistent = 0;
    let soonest: number | null = null;

    for (const cookie of cookies) {
        const domain = typeof cookie.domain === 'string' && cookie.domain !== '' ? cookie.domain : '(no domain)';
        byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
        if (typeof cookie.expires === 'number' && Number.isFinite(cookie.expires)) {
            persistent += 1;
            if (soonest === null || cookie.expires < soonest) soonest = cookie.expires;
        } else {
            session += 1;
        }
    }

    const domainSummary = [...byDomain.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([domain, count]) => `${domain} (${count})`)
        .join(', ');

    const expiryParts = [`${session} session`, `${persistent} persistent`];
    if (soonest !== null) {
        expiryParts.push(`soonest expiry ${new Date(soonest * 1000).toISOString().slice(0, 10)}`);
    }

    return { domainSummary, cookieCount: cookies.length, expirySummary: expiryParts.join(', ') };
}
