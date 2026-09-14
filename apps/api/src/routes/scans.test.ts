/**
 * Scan definition route tests — validation errors + CRUD/duplicate/toggle
 * happy path + delete protection while a run is active.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, uniqueName, type TestAppContext } from '../testing/test-app.js';

const SCAN_URL = 'https://www.sahibinden.com/satilik-daire/adana-seyhan';

function validScanBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name: uniqueName('scan'),
        startUrls: [SCAN_URL],
        browserMode: 'managed',
        ...overrides,
    };
}

describe('scan routes', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
        ctx = await buildTestContext('scans');
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    async function createScan(overrides: Record<string, unknown> = {}): Promise<{ id: string; [k: string]: unknown }> {
        const res = await ctx.app.inject({ method: 'POST', url: '/api/scans', payload: validScanBody(overrides) });
        expect(res.statusCode).toBe(201);
        const scan = res.json() as { id: string };
        ctx.track.scanIds.push(scan.id);
        return scan;
    }

    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------

    it('rejects a non-URL startUrl with the uniform error shape', async () => {
        const res = await ctx.app.inject({
            method: 'POST',
            url: '/api/scans',
            payload: validScanBody({ startUrls: ['not-a-url'] }),
        });
        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.details.issues.some((i: { path: string }) => i.path.startsWith('startUrls'))).toBe(true);
    });

    it('rejects an empty startUrls array', async () => {
        const res = await ctx.app.inject({ method: 'POST', url: '/api/scans', payload: validScanBody({ startUrls: [] }) });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects browserMode cdp without cdpUrl', async () => {
        const res = await ctx.app.inject({
            method: 'POST',
            url: '/api/scans',
            payload: { name: uniqueName('scan'), startUrls: [SCAN_URL], browserMode: 'cdp' },
        });
        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.details.issues.some((i: { path: string }) => i.path === 'cdpUrl')).toBe(true);
    });

    it('rejects cdp-by-default (browserMode omitted) without cdpUrl', async () => {
        const res = await ctx.app.inject({
            method: 'POST',
            url: '/api/scans',
            payload: { name: uniqueName('scan'), startUrls: [SCAN_URL] },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.details.issues.some((i: { path: string }) => i.path === 'cdpUrl')).toBe(true);
    });

    it('accepts browserMode cdp with a cdpUrl', async () => {
        const scan = await createScan({ browserMode: 'cdp', cdpUrl: 'http://127.0.0.1:9222' });
        expect(scan.browserMode).toBe('cdp');
        expect(scan.cdpUrl).toBe('http://127.0.0.1:9222');
    });

    it('rejects an invalid cron schedule', async () => {
        const res = await ctx.app.inject({
            method: 'POST',
            url: '/api/scans',
            payload: validScanBody({ schedule: 'definitely not cron' }),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.details.issues.some((i: { path: string }) => i.path === 'schedule')).toBe(true);
    });

    it('accepts a valid cron schedule and rejects an invalid timezone', async () => {
        const ok = await createScan({ schedule: '*/15 * * * *', timezone: 'Europe/Istanbul' });
        expect(ok.schedule).toBe('*/15 * * * *');
        const bad = await ctx.app.inject({
            method: 'POST',
            url: '/api/scans',
            payload: validScanBody({ timezone: 'Not/AZone' }),
        });
        expect(bad.statusCode).toBe(400);
        expect(bad.json().error.details.issues.some((i: { path: string }) => i.path === 'timezone')).toBe(true);
    });

    it('rejects delayMaxMs < delayMinMs and unknown profile ids', async () => {
        const delay = await ctx.app.inject({
            method: 'POST',
            url: '/api/scans',
            payload: validScanBody({ delayMinMs: 9000, delayMaxMs: 1000 }),
        });
        expect(delay.statusCode).toBe(400);
        expect(delay.json().error.details.issues.some((i: { path: string }) => i.path === 'delayMaxMs')).toBe(true);

        const profile = await ctx.app.inject({
            method: 'POST',
            url: '/api/scans',
            payload: validScanBody({ proxyProfileId: 'missing-profile-id' }),
        });
        expect(profile.statusCode).toBe(400);
        expect(profile.json().error.code).toBe('PROFILE_NOT_FOUND');
    });

    // ------------------------------------------------------------------
    // Happy path: create → get → patch → toggle → duplicate → delete
    // ------------------------------------------------------------------

    it('creates with defaults, reads, patches, toggles, duplicates, deletes', async () => {
        const scan = await createScan({ description: 'happy path' });
        expect(scan.enabled).toBe(true);
        expect(scan.timezone).toBe('Europe/Istanbul');
        expect(scan.allowedDomains).toEqual(['sahibinden.com', 'www.sahibinden.com']);

        // GET detail includes latestRun (null before any run)
        const detail = await ctx.app.inject({ method: 'GET', url: `/api/scans/${scan.id}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().latestRun).toBeNull();
        expect(detail.json().name).toBe(scan.name);

        // PATCH
        const patched = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/scans/${scan.id}`,
            payload: { description: 'updated', maxItems: 25 },
        });
        expect(patched.statusCode).toBe(200);
        expect(patched.json().description).toBe('updated');
        expect(patched.json().maxItems).toBe(25);

        // PATCH cdp without url (merged check) is rejected
        const badPatch = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/scans/${scan.id}`,
            payload: { browserMode: 'cdp' },
        });
        expect(badPatch.statusCode).toBe(400);
        expect(badPatch.json().error.details.issues.some((i: { path: string }) => i.path === 'cdpUrl')).toBe(true);

        // toggle off / on
        const off = await ctx.app.inject({
            method: 'POST',
            url: `/api/scans/${scan.id}/toggle`,
            payload: { enabled: false },
        });
        expect(off.statusCode).toBe(200);
        expect(off.json().enabled).toBe(false);
        const on = await ctx.app.inject({
            method: 'POST',
            url: `/api/scans/${scan.id}/toggle`,
            payload: { enabled: true },
        });
        expect(on.json().enabled).toBe(true);

        // duplicate → ' (kopya)' suffix, disabled
        const dup = await ctx.app.inject({ method: 'POST', url: `/api/scans/${scan.id}/duplicate` });
        expect(dup.statusCode).toBe(201);
        expect(dup.json().name).toBe(`${scan.name} (kopya)`);
        expect(dup.json().enabled).toBe(false);
        expect(dup.json().startUrls).toEqual([SCAN_URL]);
        const dupId = dup.json().id as string;

        // list contains the scan (q filter)
        const list = await ctx.app.inject({ method: 'GET', url: `/api/scans?q=${encodeURIComponent(scan.name as string)}` });
        expect(list.statusCode).toBe(200);
        expect(list.json().rows.some((row: { id: string }) => row.id === scan.id)).toBe(true);

        // delete the copy, then 404
        const del = await ctx.app.inject({ method: 'DELETE', url: `/api/scans/${dupId}` });
        expect(del.statusCode).toBe(204);
        const gone = await ctx.app.inject({ method: 'GET', url: `/api/scans/${dupId}` });
        expect(gone.statusCode).toBe(404);
        expect(gone.json().error.code).toBe('NOT_FOUND');
    });

    it('refuses to delete a scan while a run is active', async () => {
        const scan = await createScan();
        const run = await ctx.app.inject({ method: 'POST', url: `/api/scans/${scan.id}/run` });
        expect(run.statusCode).toBe(201);

        const del = await ctx.app.inject({ method: 'DELETE', url: `/api/scans/${scan.id}` });
        expect(del.statusCode).toBe(409);
        expect(del.json().error.code).toBe('SCAN_HAS_ACTIVE_RUN');

        // cleanup: cancel the queued run so the scan deactivates
        const cancel = await ctx.app.inject({ method: 'POST', url: `/api/runs/${run.json().id}/cancel` });
        expect(cancel.statusCode).toBe(200);
    });

    it('refuses to start a run for a disabled scan', async () => {
        const scan = await createScan({ enabled: false });
        const res = await ctx.app.inject({ method: 'POST', url: `/api/scans/${scan.id}/run` });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('SCAN_DISABLED');
    });
});
