/**
 * Dashboard aggregate tests.
 *
 * Exactness strategy: the root vitest config runs up to 2 files concurrently
 * against the shared `sahibindenbot_test` DB, so pre-seed baselines can drift
 * mid-test. Instead each aggregate is asserted EXACTLY against a direct
 * Prisma count/groupBy executed immediately after the API call (sub-ms race
 * window), plus a `>= baseline + seeded` check proving the seeded rows moved
 * the needle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, uniqueName, type TestAppContext } from '../testing/test-app.js';
import { makeDetail, seedDetailListing, seedRun, seedScan, shortId } from '../testing/seed.js';
import { startOfDayInTimezone } from './dashboard.js';

interface DashboardPayload {
    totalListings: number;
    newListingsToday: number;
    updatedListingsToday: number;
    priceChangesToday: number;
    ownerListings: number;
    officeListings: number;
    activeScans: number;
    runningRuns: number;
    failedRuns24h: number;
    staleListings: number;
    proxyHealthSummary: { healthy: number; degraded: number; unhealthy: number; unknown: number; disabled: number };
    recentRuns: Array<{
        id: string;
        scanName: string;
        status: string;
        startedAt: string | null;
        durationMs: number | null;
        itemsInserted: number;
    }>;
}

describe('dashboard', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
        ctx = await buildTestContext('dash');
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    it('aggregates match direct DB counts exactly; seeded rows move the needle', async () => {
        const prisma = ctx.app.db.prisma;
        const baseTotal = await prisma.listing.count();
        const baseOwner = await prisma.listing.count({ where: { sellerType: 'OWNER' } });

        // -- Scans: one enabled, one disabled --------------------------------
        const enabledScanId = await seedScan(ctx);
        await seedScan(ctx, { enabled: false });

        // -- Runs: one RUNNING, one FAILED (terminal, just now) ---------------
        const runningRunId = await seedRun(ctx, enabledScanId);
        await ctx.app.db.repos.runs.updateStatus(runningRunId, 'RUNNING', { startedAt: new Date() });
        const failedRunId = await seedRun(ctx, enabledScanId);
        // startedAt set first — finishRun derives durationMs from it.
        await ctx.app.db.repos.runs.updateStatus(failedRunId, 'RUNNING', { startedAt: new Date(Date.now() - 1500) });
        await ctx.app.db.repos.runs.finishRun(failedRunId, 'FAILED', { itemsInserted: 7 }, 'forced failure (test)');

        // -- Listings ----------------------------------------------------------
        // L1: OWNER, first seen today; then a price change (→ priceChangesToday).
        const ownerSourceId = `d-${shortId()}`;
        await seedDetailListing(ctx, runningRunId, ownerSourceId, { price: 1_000_000 });
        await ctx.app.db.repos.listings.upsertDetailListing(makeDetail(ownerSourceId, { price: 900_000 }), runningRunId);

        // L2: REAL_ESTATE_OFFICE, backdated firstSeen → re-observation counts as
        // updatedListingsToday, NOT newListingsToday.
        const officeSourceId = `d-${shortId()}`;
        const officeId = await seedDetailListing(ctx, runningRunId, officeSourceId, {
            sellerType: 'REAL_ESTATE_OFFICE',
            officeName: 'Dash Office',
        });
        const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
        await prisma.listing.update({ where: { id: officeId }, data: { firstSeenAt: yesterday } });
        await ctx.app.db.repos.listings.upsertDetailListing(
            makeDetail(officeSourceId, { sellerType: 'REAL_ESTATE_OFFICE', officeName: 'Dash Office', title: 'Re-touched' }),
            runningRunId,
        );

        // L3: OWNER → STALE (staleness evaluation is worker-side; set directly).
        const staleId = await seedDetailListing(ctx, runningRunId, `d-${shortId()}`);
        await prisma.listing.update({ where: { id: staleId }, data: { status: 'STALE' } });

        // -- Proxy endpoints across health statuses ---------------------------
        const profile = await ctx.app.proxyProfiles.createProfile({ name: uniqueName('dash-proxy') });
        ctx.track.proxyProfileIds.push(profile.id);
        await prisma.proxyEndpoint.create({ data: { profileId: profile.id, host: '10.0.0.1', port: 8080, healthStatus: 'HEALTHY' } });
        await prisma.proxyEndpoint.create({ data: { profileId: profile.id, host: '10.0.0.2', port: 8080, healthStatus: 'UNHEALTHY' } });
        await prisma.proxyEndpoint.create({
            data: { profileId: profile.id, host: '10.0.0.3', port: 8080, healthStatus: 'DISABLED', enabled: false },
        });

        // -- Act ---------------------------------------------------------------
        const res = await ctx.app.inject({ method: 'GET', url: '/api/dashboard' });
        expect(res.statusCode).toBe(200);
        const dash = res.json() as DashboardPayload;

        // -- Exact match vs direct DB truth (same semantics as the route) ------
        const todayStart = startOfDayInTimezone('Europe/Istanbul', new Date());
        const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [
            totalListings,
            newListingsToday,
            updatedListingsToday,
            priceChangesToday,
            ownerListings,
            officeListings,
            activeScans,
            runningRuns,
            failedRuns24h,
            staleListings,
            proxyHealthGroups,
        ] = await Promise.all([
            prisma.listing.count(),
            prisma.listing.count({ where: { firstSeenAt: { gte: todayStart } } }),
            prisma.listing.count({ where: { updatedAt: { gte: todayStart }, firstSeenAt: { lt: todayStart } } }),
            prisma.listingPriceHistory.count({ where: { changedAt: { gte: todayStart } } }),
            prisma.listing.count({ where: { sellerType: 'OWNER' } }),
            prisma.listing.count({ where: { sellerType: 'REAL_ESTATE_OFFICE' } }),
            prisma.scanDefinition.count({ where: { enabled: true } }),
            prisma.scanRun.count({ where: { status: { in: ['RUNNING', 'STARTING'] } } }),
            prisma.scanRun.count({ where: { status: 'FAILED', finishedAt: { gte: last24h } } }),
            prisma.listing.count({ where: { status: 'STALE' } }),
            prisma.proxyEndpoint.groupBy({ by: ['healthStatus'], _count: { _all: true } }),
        ]);

        expect(dash.totalListings).toBe(totalListings);
        expect(dash.newListingsToday).toBe(newListingsToday);
        expect(dash.updatedListingsToday).toBe(updatedListingsToday);
        expect(dash.priceChangesToday).toBe(priceChangesToday);
        expect(dash.ownerListings).toBe(ownerListings);
        expect(dash.officeListings).toBe(officeListings);
        expect(dash.activeScans).toBe(activeScans);
        expect(dash.runningRuns).toBe(runningRuns);
        expect(dash.failedRuns24h).toBe(failedRuns24h);
        expect(dash.staleListings).toBe(staleListings);

        const expectedHealth = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0, disabled: 0 };
        for (const group of proxyHealthGroups) {
            const key = group.healthStatus.toLowerCase() as keyof typeof expectedHealth;
            if (key in expectedHealth) expectedHealth[key] = group._count._all;
        }
        expect(dash.proxyHealthSummary).toEqual(expectedHealth);

        // -- Needle moved (seeded rows are inside those exact counts) ----------
        expect(totalListings).toBeGreaterThanOrEqual(baseTotal + 3);
        expect(ownerListings).toBeGreaterThanOrEqual(baseOwner + 2); // L1 + L3

        // -- recentRuns: newest first, exact contracted shape ------------------
        expect(dash.recentRuns.length).toBeGreaterThanOrEqual(2);
        expect(dash.recentRuns.length).toBeLessThanOrEqual(10);
        const scan = await ctx.app.db.repos.scans.getById(enabledScanId);
        const failedEntry = dash.recentRuns.find((run) => run.id === failedRunId);
        expect(failedEntry).toBeDefined();
        expect(failedEntry?.scanName).toBe(scan?.name);
        expect(failedEntry?.status).toBe('FAILED');
        expect(failedEntry?.itemsInserted).toBe(7);
        expect(failedEntry?.durationMs).not.toBeNull();
        const runningEntry = dash.recentRuns.find((run) => run.id === runningRunId);
        expect(runningEntry?.status).toBe('RUNNING');
        expect(runningEntry?.startedAt).not.toBeNull();
    });

    it('startOfDayInTimezone returns the UTC instant of Istanbul midnight', () => {
        // 2026-09-15 12:00 UTC = 15:00 +03 → Istanbul midnight = 2026-09-14 21:00 UTC.
        const noonUtc = new Date('2026-09-15T12:00:00.000Z');
        expect(startOfDayInTimezone('Europe/Istanbul', noonUtc).toISOString()).toBe('2026-09-14T21:00:00.000Z');
        // 00:30 UTC is still yesterday in UTC but already today (+03) in Istanbul.
        const earlyUtc = new Date('2026-09-15T00:30:00.000Z');
        expect(startOfDayInTimezone('Europe/Istanbul', earlyUtc).toISOString()).toBe('2026-09-14T21:00:00.000Z');
    });
});
