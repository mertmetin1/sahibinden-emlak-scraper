/**
 * Dashboard route — single-round-trip operator aggregates.
 *
 * All numbers are Prisma count/groupBy/select queries — no table is ever
 * loaded into memory. REPOSITORY GAP (reported, not patched): the database
 * package exposes no aggregate/settings repository, so this route uses the
 * documented raw-prisma escape hatch (DatabaseClient.prisma — same pattern
 * as RunControlService.findActiveRun).
 *
 * "Today" is Europe/Istanbul local time (the product's default timezone).
 */
import type { FastifyPluginAsync } from 'fastify';
import { routeDoc } from '../docs.js';

const DASHBOARD_TIMEZONE = 'Europe/Istanbul';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * UTC instant of local midnight for `timeZone` on the same local date as
 * `now`. The offset is derived from Intl wall-clock math at `now` — correct
 * for Europe/Istanbul (fixed UTC+3, no DST since 2016).
 */
export function startOfDayInTimezone(timeZone: string, now: Date): Date {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = dtf.formatToParts(now);
    const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    // Wall clock in `timeZone` interpreted as UTC → offset vs the real instant.
    const wallNowAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    const offsetMs = wallNowAsUtc - Math.floor(now.getTime() / 1000) * 1000;
    const wallMidnightAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), 0, 0, 0);
    return new Date(wallMidnightAsUtc - offsetMs);
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
    app.get(
        '/api/dashboard',
        {
            schema: routeDoc({
                tags: ['dashboard'],
                summary: 'Operator dashboard aggregates',
                description:
                    'Counts and summaries for the operator home page, computed with DB-level count/groupBy ' +
                    '(never full-table loads). "Today" boundaries use Europe/Istanbul. ' +
                    'updatedListingsToday = listings re-touched today that were first seen before today ' +
                    '(Listing.updatedAt bumps on every observation). failedRuns24h counts runs that ' +
                    'REACHED a terminal FAILED state in the last 24h (finishedAt). proxyHealthSummary is ' +
                    'a groupBy over ProxyEndpoint.healthStatus (DISABLED included).',
            }),
        },
        async () => {
            const prisma = app.db.prisma;
            const now = new Date();
            const todayStart = startOfDayInTimezone(DASHBOARD_TIMEZONE, now);
            const last24h = new Date(now.getTime() - DAY_MS);

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
                recentRunRows,
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
                prisma.scanRun.findMany({
                    take: 10,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        status: true,
                        startedAt: true,
                        durationMs: true,
                        itemsInserted: true,
                        scanDefinition: { select: { name: true } },
                    },
                }),
            ]);

            const proxyHealthSummary = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0, disabled: 0 };
            for (const group of proxyHealthGroups) {
                const key = group.healthStatus.toLowerCase() as keyof typeof proxyHealthSummary;
                if (key in proxyHealthSummary) proxyHealthSummary[key] = group._count._all;
            }

            return {
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
                proxyHealthSummary,
                recentRuns: recentRunRows.map((run) => ({
                    id: run.id,
                    scanName: run.scanDefinition.name,
                    status: run.status,
                    startedAt: run.startedAt,
                    durationMs: run.durationMs,
                    itemsInserted: run.itemsInserted,
                })),
            };
        },
    );
};
