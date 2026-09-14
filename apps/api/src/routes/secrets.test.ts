/**
 * Secret-hygiene tests — the write-only contract for proxy credentials and
 * cookie material (ARCHITECTURE §10):
 * - create/import endpoints ACCEPT secrets;
 * - every read path is deep-scanned for those secrets (raw response text);
 * - reads expose presence booleans (hasUsername/hasPassword) and metadata
 *   (cookieCount/domainSummary/expirySummary) only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, expectNoSecrets, uniqueName, type TestAppContext } from '../testing/test-app.js';

const PROXY_USER = 'proxyuser-x9';
const PROXY_PASS = 'supersecretpass-x9';
const BULK_USER = 'bulkuser-x9';
const BULK_PASS = 'bulkpass-x9';

const COOKIE_NAME_1 = 'sessionid-x9';
const COOKIE_VALUE_1 = 'cookie-secret-value-x9';
const COOKIE_NAME_2 = 'prefs-x9';
const COOKIE_VALUE_2 = 'pref-secret-x9';
const COOKIE_NAME_3 = 'fresh-x9';
const COOKIE_VALUE_3 = 'fresh-secret-x9';

const ALL_SECRETS = [
    PROXY_USER,
    PROXY_PASS,
    BULK_USER,
    BULK_PASS,
    COOKIE_NAME_1,
    COOKIE_VALUE_1,
    COOKIE_NAME_2,
    COOKIE_VALUE_2,
    COOKIE_NAME_3,
    COOKIE_VALUE_3,
];

describe('secret hygiene', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
        ctx = await buildTestContext('secrets');
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    it('proxy endpoint credentials are write-only (hasPassword flags, no material anywhere)', async () => {
        // Create profile
        const profileRes = await ctx.app.inject({
            method: 'POST',
            url: '/api/proxy-profiles',
            payload: { name: uniqueName('proxy'), strategy: 'ROUND_ROBIN' },
        });
        expect(profileRes.statusCode).toBe(201);
        const profileId = profileRes.json().id as string;
        ctx.track.proxyProfileIds.push(profileId);

        // Add an endpoint WITH credentials
        const epRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/proxy-profiles/${profileId}/endpoints`,
            payload: { host: 'proxy.example.com', port: 8080, protocol: 'http', username: PROXY_USER, password: PROXY_PASS },
        });
        expect(epRes.statusCode).toBe(201);
        expect(epRes.json().hasUsername).toBe(true);
        expect(epRes.json().hasPassword).toBe(true);
        expectNoSecrets(epRes.body, ALL_SECRETS);
        const endpointId = epRes.json().id as string;

        // Profile detail: flags present, material absent (deep scan of raw body)
        const detail = await ctx.app.inject({ method: 'GET', url: `/api/proxy-profiles/${profileId}` });
        expect(detail.statusCode).toBe(200);
        const endpoint = detail.json().endpoints.find((e: { id: string }) => e.id === endpointId);
        expect(endpoint.hasUsername).toBe(true);
        expect(endpoint.hasPassword).toBe(true);
        expectNoSecrets(detail.body, ALL_SECRETS);

        // Bulk import with credential-bearing lines: response must not echo them
        const bulk = await ctx.app.inject({
            method: 'POST',
            url: `/api/proxy-profiles/${profileId}/endpoints/bulk`,
            payload: {
                text: [`http://${BULK_USER}:${BULK_PASS}@bulk.example.com:3128`, 'socks5://9.9.9.9:1080', 'bad line with no port'].join('\n'),
            },
        });
        expect(bulk.statusCode).toBe(200);
        expect(bulk.json().imported).toBe(2);
        expect(bulk.json().failed).toHaveLength(1);
        expectNoSecrets(bulk.body, ALL_SECRETS);

        // List + detail again: still no material after the bulk import
        const list = await ctx.app.inject({ method: 'GET', url: '/api/proxy-profiles' });
        expect(list.statusCode).toBe(200);
        expectNoSecrets(list.body, ALL_SECRETS);
        const detail2 = await ctx.app.inject({ method: 'GET', url: `/api/proxy-profiles/${profileId}` });
        expect(detail2.json().endpoints).toHaveLength(3);
        expectNoSecrets(detail2.body, ALL_SECRETS);

        // Toggle endpoint off → DISABLED; back on → UNKNOWN
        const off = await ctx.app.inject({
            method: 'POST',
            url: `/api/proxy-endpoints/${endpointId}/toggle`,
            payload: { enabled: false },
        });
        expect(off.statusCode).toBe(200);
        expect(off.json().enabled).toBe(false);
        expect(off.json().healthStatus).toBe('DISABLED');
        expectNoSecrets(off.body, ALL_SECRETS);

        // Clearing the username also clears the stored password (paired credentials)
        const cleared = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/proxy-endpoints/${endpointId}`,
            payload: { username: null },
        });
        expect(cleared.statusCode).toBe(200);
        expect(cleared.json().hasUsername).toBe(false);
        expect(cleared.json().hasPassword).toBe(false);
        expectNoSecrets(cleared.body, ALL_SECRETS);

        const del = await ctx.app.inject({ method: 'DELETE', url: `/api/proxy-endpoints/${endpointId}` });
        expect(del.statusCode).toBe(204);
    });

    it('cookie profiles expose metadata only — never names, values, or ciphertext', async () => {
        const futureExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
        const cookies = [
            { name: COOKIE_NAME_1, value: COOKIE_VALUE_1, domain: '.sahibinden.com', path: '/', expirationDate: futureExpiry },
            { name: COOKIE_NAME_2, value: COOKIE_VALUE_2, domain: '.sahibinden.com' },
        ];

        const create = await ctx.app.inject({
            method: 'POST',
            url: '/api/cookie-profiles',
            payload: { name: uniqueName('cookies'), cookieJson: cookies, notes: 'test profile' },
        });
        expect(create.statusCode).toBe(201);
        expect(create.json().profile.cookieCount).toBe(2);
        expect(create.json().profile.domainSummary).toContain('.sahibinden.com');
        expect(create.json().profile.validationStatus).toBe('VALID');
        expect(create.json().issues).toEqual([]);
        expectNoSecrets(create.body, ALL_SECRETS);
        const profileId = create.json().profile.id as string;
        ctx.track.cookieProfileIds.push(profileId);

        // Detail: metadata only
        const detail = await ctx.app.inject({ method: 'GET', url: `/api/cookie-profiles/${profileId}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().cookieCount).toBe(2);
        expect(detail.json().domainSummary).toContain('.sahibinden.com (2)');
        expect(detail.json().expirySummary).toContain('1 session');
        expect(detail.json().assignedScans).toEqual([]);
        expectNoSecrets(detail.body, ALL_SECRETS);

        // List: metadata only
        const list = await ctx.app.inject({ method: 'GET', url: '/api/cookie-profiles' });
        expect(list.statusCode).toBe(200);
        expectNoSecrets(list.body, ALL_SECRETS);

        // Replace flow works and stays secret-free
        const replace = await ctx.app.inject({
            method: 'POST',
            url: `/api/cookie-profiles/${profileId}/replace`,
            payload: { cookieJson: [{ name: COOKIE_NAME_3, value: COOKIE_VALUE_3, domain: '.sahibinden.com' }] },
        });
        expect(replace.statusCode).toBe(200);
        expect(replace.json().profile.cookieCount).toBe(1);
        expectNoSecrets(replace.body, ALL_SECRETS);

        const detail2 = await ctx.app.inject({ method: 'GET', url: `/api/cookie-profiles/${profileId}` });
        expect(detail2.json().cookieCount).toBe(1);
        expectNoSecrets(detail2.body, ALL_SECRETS);

        // Toggle + delete
        const off = await ctx.app.inject({
            method: 'POST',
            url: `/api/cookie-profiles/${profileId}/toggle`,
            payload: { enabled: false },
        });
        expect(off.statusCode).toBe(200);
        expect(off.json().enabled).toBe(false);

        const del = await ctx.app.inject({ method: 'DELETE', url: `/api/cookie-profiles/${profileId}` });
        expect(del.statusCode).toBe(204);
        const gone = await ctx.app.inject({ method: 'GET', url: `/api/cookie-profiles/${profileId}` });
        expect(gone.statusCode).toBe(404);
    });
});
