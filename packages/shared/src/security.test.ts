/**
 * security.ts unit tests — secret box round-trip/tamper, master-key loading,
 * proxy URL redaction, deep log redaction, cookie export normalization and
 * metadata summaries. Pure: no DB, no network, no env mutation.
 */
import { describe, expect, it } from 'vitest';
import {
    createSecretBox,
    decryptSecret,
    encryptSecret,
    loadMasterKey,
    normalizeCookieExport,
    redactProxyUrl,
    redactSecrets,
    summarizeCookies,
} from './security.js';
import type { CookieParam } from './types.js';

/** Deterministic 32-byte keys (base64) — never derived from the environment. */
const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');

describe('encryptSecret / decryptSecret', () => {
    it('round-trips plaintext (incl. unicode) through the envelope', () => {
        const plaintext = 'session cookie json — şüğüı — {"a":1}';
        const envelope = encryptSecret(plaintext, KEY_A);
        expect(decryptSecret(envelope, KEY_A)).toBe(plaintext);
    });

    it('produces the v1 envelope: v1:<ivB64>:<authTagB64>:<ciphertextB64>', () => {
        const envelope = encryptSecret('hello', KEY_A);
        const parts = envelope.split(':');
        expect(parts).toHaveLength(4);
        expect(parts[0]).toBe('v1');
        expect(Buffer.from(parts[1]!, 'base64')).toHaveLength(12); // 96-bit IV
        expect(Buffer.from(parts[2]!, 'base64')).toHaveLength(16); // 128-bit GCM tag
        expect(Buffer.from(parts[3]!, 'base64').length).toBeGreaterThan(0);
    });

    it('uses a fresh IV per record — same plaintext encrypts differently', () => {
        expect(encryptSecret('same', KEY_A)).not.toBe(encryptSecret('same', KEY_A));
    });

    it('throws when the auth tag is tampered with', () => {
        const parts = encryptSecret('secret', KEY_A).split(':');
        const tag = Buffer.from(parts[2]!, 'base64');
        tag[0] = tag[0]! ^ 0xff;
        parts[2] = tag.toString('base64');
        expect(() => decryptSecret(parts.join(':'), KEY_A)).toThrow(/decryption failed/);
    });

    it('throws when the ciphertext is tampered with', () => {
        const parts = encryptSecret('secret', KEY_A).split(':');
        const ct = Buffer.from(parts[3]!, 'base64');
        ct[0] = ct[0]! ^ 0xff;
        parts[3] = ct.toString('base64');
        expect(() => decryptSecret(parts.join(':'), KEY_A)).toThrow(/decryption failed/);
    });

    it('throws with the wrong key', () => {
        const envelope = encryptSecret('secret', KEY_A);
        expect(() => decryptSecret(envelope, KEY_B)).toThrow(/decryption failed/);
    });

    it('rejects malformed envelopes and unknown versions', () => {
        expect(() => decryptSecret('not-an-envelope', KEY_A)).toThrow(/invalid secret envelope/);
        expect(() => decryptSecret('v1:only:three', KEY_A)).toThrow(/invalid secret envelope/);
        const v2 = encryptSecret('x', KEY_A).replace(/^v1:/, 'v2:');
        expect(() => decryptSecret(v2, KEY_A)).toThrow(/unsupported secret envelope version/);
        expect(() => decryptSecret('v1:QUJD:QUJD:QUJD', KEY_A)).toThrow(/bad IV length/);
    });

    it('rejects an invalid key (wrong decoded length)', () => {
        const shortKey = Buffer.alloc(16, 1).toString('base64');
        expect(() => encryptSecret('x', shortKey)).toThrow(/32 bytes/);
        expect(() => decryptSecret('v1:a:b:c', '!!!not-base64!!!')).toThrow(/base64/);
    });

    it('createSecretBox validates eagerly and round-trips', () => {
        expect(() => createSecretBox(Buffer.alloc(8, 1).toString('base64'))).toThrow(/32 bytes/);
        const box = createSecretBox(KEY_A);
        const envelope = box.encrypt('boxed');
        expect(envelope.startsWith('v1:')).toBe(true);
        expect(box.decrypt(envelope)).toBe('boxed');
    });
});

describe('loadMasterKey', () => {
    it('throws a clear error when missing or empty', () => {
        expect(() => loadMasterKey({})).toThrow(/APP_SECRET_KEY is not set/);
        expect(() => loadMasterKey({ APP_SECRET_KEY: '' })).toThrow(/APP_SECRET_KEY is not set/);
        expect(() => loadMasterKey({ APP_SECRET_KEY: '   ' })).toThrow(/APP_SECRET_KEY is not set/);
    });

    it('throws on non-base64 and wrong-length keys', () => {
        expect(() => loadMasterKey({ APP_SECRET_KEY: 'not base64 !!!' })).toThrow(/APP_SECRET_KEY invalid.*base64/);
        expect(() => loadMasterKey({ APP_SECRET_KEY: Buffer.alloc(16, 1).toString('base64') })).toThrow(
            /APP_SECRET_KEY invalid.*32 bytes/,
        );
    });

    it('returns the validated (trimmed) base64 key', () => {
        expect(loadMasterKey({ APP_SECRET_KEY: KEY_A })).toBe(KEY_A);
        expect(loadMasterKey({ APP_SECRET_KEY: `  ${KEY_A}\n` })).toBe(KEY_A);
    });
});

describe('redactProxyUrl', () => {
    it('strips userinfo entirely for http/https/socks4/socks5', () => {
        expect(redactProxyUrl('http://user:pass@host:8080')).toBe('http://host:8080');
        expect(redactProxyUrl('https://user:pass@proxy.example.com:8443')).toBe('https://proxy.example.com:8443');
        // WHATWG URL normalizes default ports away — 443 is https's default.
        expect(redactProxyUrl('https://user:pass@proxy.example.com:443')).toBe('https://proxy.example.com');
        expect(redactProxyUrl('socks5://u:p@10.0.0.1:1080')).toBe('socks5://10.0.0.1:1080');
        expect(redactProxyUrl('socks4://u:p@10.0.0.2:1080')).toBe('socks4://10.0.0.2:1080');
    });

    it('strips a username-only authority too (no user at all)', () => {
        expect(redactProxyUrl('http://user@host:8080')).toBe('http://host:8080');
    });

    it('keeps credential-free URLs unchanged (minus path/query)', () => {
        expect(redactProxyUrl('http://host:3128')).toBe('http://host:3128');
        expect(redactProxyUrl('http://user:pass@host:8080/path?x=1')).toBe('http://host:8080');
    });

    it('returns <invalid-url> for malformed input', () => {
        expect(redactProxyUrl('not a url')).toBe('<invalid-url>');
        expect(redactProxyUrl('host:8080')).toBe('<invalid-url>'); // no authority
        expect(redactProxyUrl('')).toBe('<invalid-url>');
    });
});

describe('redactSecrets', () => {
    it('redacts sensitive keys at any depth (case-insensitive)', () => {
        const input = {
            password: 'p',
            nested: { Token: 't', sessionCookies: ['c'], ok: 1 },
            list: [{ authorization: 'Bearer x' }, 'plain'],
        };
        const out = redactSecrets(input);
        expect(out.password).toBe('[REDACTED]');
        expect(out.nested.Token).toBe('[REDACTED]');
        expect(out.nested.sessionCookies).toBe('[REDACTED]');
        expect(out.nested.ok).toBe(1);
        const first = out.list[0] as { authorization: string };
        expect(first.authorization).toBe('[REDACTED]');
        expect(out.list[1]).toBe('plain');
    });

    it('matches the aggressive auth substring (author is collateral)', () => {
        const out = redactSecrets({ auth: 'a', author: 'b', unaffected: 'c' });
        expect(out.auth).toBe('[REDACTED]');
        expect(out.author).toBe('[REDACTED]');
        expect(out.unaffected).toBe('c');
    });

    it('redacts credential-bearing URL strings, whole or embedded', () => {
        expect(redactSecrets('http://user:pass@proxy.local:8080')).toBe('http://proxy.local:8080');
        expect(redactSecrets('failed on socks5://u:p@10.0.0.1:1080 twice')).toBe('failed on socks5://10.0.0.1:1080 twice');
        expect(redactSecrets('http://host:3128 has no creds')).toBe('http://host:3128 has no creds');
    });

    it('is circular-safe and diamond-safe', () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        const out = redactSecrets(circular);
        expect(out.a).toBe(1);
        expect(out.self).toBe('[CIRCULAR]');

        const shared = { token: 't', fine: 2 };
        const diamond = redactSecrets({ first: shared, second: shared });
        expect(diamond.first).toEqual({ token: '[REDACTED]', fine: 2 });
        expect(diamond.second).toEqual({ token: '[REDACTED]', fine: 2 });
    });

    it('stops expanding objects past depth 6 but still redacts strings', () => {
        const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'too deep' } } } } } } };
        const out = redactSecrets(deep);
        expect(out.l1.l2.l3.l4.l5.l6).toBe('[DEPTH_LIMIT]');
    });

    it('passes primitives and Dates through; never mutates the input', () => {
        const date = new Date('2026-09-14T00:00:00Z');
        const input = { n: 42, b: false, nil: null, date, password: 'keep-me' };
        const out = redactSecrets(input);
        expect(out.n).toBe(42);
        expect(out.b).toBe(false);
        expect(out.nil).toBeNull();
        expect(out.date).toBe(date);
        expect(input.password).toBe('keep-me'); // untouched original
    });
});

describe('normalizeCookieExport', () => {
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const past = 1_000_000_000; // 2001 — always expired

    it('normalizes an EditThisCookie export (expirationDate, no_restriction, extra fields dropped)', () => {
        const editThisCookie = [
            {
                domain: '.sahibinden.com',
                expirationDate: future,
                hostOnly: false,
                httpOnly: true,
                name: 'session_id',
                path: '/',
                sameSite: 'no_restriction',
                secure: true,
                session: false,
                storeId: '0',
                value: 'abc123',
                id: 1,
            },
        ];
        const { cookies, issues } = normalizeCookieExport(editThisCookie);
        expect(issues).toEqual([]);
        expect(cookies).toEqual([
            {
                name: 'session_id',
                value: 'abc123',
                domain: '.sahibinden.com',
                path: '/',
                expires: future,
                secure: true,
                httpOnly: true,
                sameSite: 'None',
            },
        ]);
    });

    it('normalizes a Cookie-Editor export (key fallback, expires, sameSite case-insensitive)', () => {
        const cookieEditor = [
            { name: 'pref', value: 'x', domain: '.example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax', expirationDate: future },
            { key: 'legacy', value: 'v', expires: future, sameSite: 'STRICT' },
        ];
        const { cookies, issues } = normalizeCookieExport(cookieEditor);
        expect(issues).toEqual([]);
        expect(cookies[0]).toMatchObject({ name: 'pref', sameSite: 'Lax', expires: future });
        expect(cookies[1]).toMatchObject({ name: 'legacy', sameSite: 'Strict', expires: future });
    });

    it('parses a raw Cookie header string', () => {
        const { cookies, issues } = normalizeCookieExport('a=1; b=hello world; c=');
        expect(issues).toEqual([]);
        expect(cookies).toEqual([
            { name: 'a', value: '1' },
            { name: 'b', value: 'hello world' },
            { name: 'c', value: '' },
        ]);
    });

    it('parses a pasted JSON string before falling back to header parsing', () => {
        const { cookies } = normalizeCookieExport(JSON.stringify([{ name: 'j', value: '1', expires: future }]));
        expect(cookies).toEqual([{ name: 'j', value: '1', expires: future }]);
    });

    it('accepts a { cookies: [...] } wrapper object', () => {
        const { cookies, issues } = normalizeCookieExport({ cookies: [{ name: 'w', value: '1' }] });
        expect(issues).toEqual([]);
        expect(cookies).toEqual([{ name: 'w', value: '1' }]);
    });

    it('drops expired and nameless cookies with indexed, secret-free issues', () => {
        const { cookies, issues } = normalizeCookieExport([
            { name: 'alive', value: '1', expirationDate: future },
            { name: 'dead', value: '2', expirationDate: past },
            { value: 'no-name' },
            'not-an-object',
        ]);
        expect(cookies).toEqual([{ name: 'alive', value: '1', expires: future }]);
        expect(issues).toHaveLength(3);
        expect(issues[0]).toMatch(/cookie\[1\]: expired/);
        expect(issues[1]).toMatch(/cookie\[2\]: missing name/);
        expect(issues[2]).toMatch(/cookie\[3\]: not an object/);
        // §9.3: cookie names/values must never leak into issue strings.
        expect(issues.join(' ')).not.toContain('dead');
        expect(issues.join(' ')).not.toContain('no-name');
    });

    it('maps sameSite variants and omits unspecified/unknown ones', () => {
        const cases: Array<[string, CookieParam['sameSite']]> = [
            ['no_restriction', 'None'],
            ['none', 'None'],
            ['None', 'None'],
            ['lax', 'Lax'],
            ['LAX', 'Lax'],
            ['strict', 'Strict'],
            ['Strict', 'Strict'],
            ['unspecified', undefined],
            ['', undefined],
            ['something-else', undefined],
        ];
        for (const [raw, expected] of cases) {
            const { cookies } = normalizeCookieExport([{ name: 'c', value: 'v', sameSite: raw }]);
            expect(cookies[0]?.sameSite).toBe(expected);
        }
    });

    it('honours the session flag and the -1 session sentinel', () => {
        const { cookies } = normalizeCookieExport([
            { name: 's', value: '1', session: true, expirationDate: past }, // session wins over expiry
            { name: 'p', value: '2', expires: -1 },
        ]);
        expect(cookies).toEqual([{ name: 's', value: '1' }, { name: 'p', value: '2' }]);
    });

    it('never throws on hostile input — collects issues instead', () => {
        expect(normalizeCookieExport(42).issues).toHaveLength(1);
        expect(normalizeCookieExport(null).issues).toHaveLength(1);
        expect(normalizeCookieExport({}).issues).toHaveLength(1);
        expect(normalizeCookieExport('').issues).toHaveLength(1);
        expect(normalizeCookieExport('garbage header').issues).toHaveLength(1); // no name=value pair
        expect(normalizeCookieExport(undefined).cookies).toEqual([]);
    });

    it('defaults a missing value to an empty string', () => {
        const { cookies } = normalizeCookieExport([{ name: 'empty' }]);
        expect(cookies).toEqual([{ name: 'empty', value: '' }]);
    });
});

describe('summarizeCookies', () => {
    it('summarizes domains (count desc), session/persistent split, and soonest expiry', () => {
        const soonest = Date.UTC(2026, 8, 15) / 1000; // 2026-09-15T00:00:00Z
        const later = Date.UTC(2027, 0, 1) / 1000;
        const cookies: CookieParam[] = [
            { name: 'a', value: '1', domain: 'sahibinden.com' }, // session
            { name: 'b', value: '2', domain: 'sahibinden.com', expires: later },
            { name: 'c', value: '3', domain: '.google.com', expires: soonest },
        ];
        expect(summarizeCookies(cookies)).toEqual({
            domainSummary: 'sahibinden.com (2), .google.com (1)',
            cookieCount: 3,
            expirySummary: '1 session, 2 persistent, soonest expiry 2026-09-15',
        });
    });

    it('handles cookies without a domain and an empty jar', () => {
        expect(summarizeCookies([{ name: 'x', value: '1' }]).domainSummary).toBe('(no domain) (1)');
        expect(summarizeCookies([])).toEqual({
            domainSummary: '',
            cookieCount: 0,
            expirySummary: '0 session, 0 persistent',
        });
    });

    it('omits the soonest-expiry clause when all cookies are session cookies', () => {
        const summary = summarizeCookies([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
        expect(summary.expirySummary).toBe('2 session, 0 persistent');
    });
});
