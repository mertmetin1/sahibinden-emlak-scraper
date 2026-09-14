/**
 * Stale-run sweeper against the real Postgres test DB (sahibindenbot_test)
 * + real Redis (sahtest:-prefixed). No browser.
 *
 * Heartbeats are backdated via the raw Prisma client (the repository's
 * heartbeat() always writes "now" by design).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepOnce, STALE_FAILURE_SUMMARY, STALE_CANCEL_SUMMARY } from './sweeper.js';
import type { SweeperDeps } from './sweeper.js';
import { crawlJobId } from './queue-admin.js';
import {
    createTestContext,
    destroyTestContext,
    testKeyBuilders,
    truncateAll,
    type TestContext,
} from './test/helpers.js';

const SNAPSHOT = { startUrls: ['https://www.sahibinden.com/emlak'] };
/** Isolation slug: own database (sahibindenbot_test_sweeper) + own Redis keyspace (sahtest-sweeper:*). */
const SLUG = 'sweeper';

describe('stale-run sweeper', () => {
    let ctx: TestContext;
    let deps: SweeperDeps;

    beforeAll(async () => {
        ctx = await createTestContext(SLUG);
        deps = {
            repos: ctx.db.repos,
            queue: ctx.queue,
            redis: ctx.redis,
            logger: ctx.logger,
            keyBuilders: testKeyBuilders(SLUG),
        };
    });

    beforeEach(async () => {
        await truncateAll(ctx.db);
    });

    afterAll(async () => {
        await destroyTestContext(ctx);
    });

    async function createScanAndRun(name: string): Promise<{ scanId: string; runId: string }> {
        const scan = await ctx.db.repos.scans.create({ name, startUrls: SNAPSHOT.startUrls });
        const run = await ctx.db.repos.runs.createRun(scan.id, 'MANUAL', SNAPSHOT);
        return { scanId: scan.id, runId: run.id };
    }

    async function backdateHeartbeat(runId: string, ageMs: number): Promise<void> {
        await ctx.db.prisma.scanRun.update({
            where: { id: runId },
            data: { heartbeatAt: new Date(Date.now() - ageMs) },
        });
    }

    it('marks a stale RUNNING run FAILED with the recovery summary + RUN_FAILED event', async () => {
        const { runId } = await createScanAndRun('sweeper-stale-running');
        await ctx.db.repos.runs.updateStatus(runId, 'RUNNING', { startedAt: new Date(Date.now() - 300_000) });
        await backdateHeartbeat(runId, 300_000);

        const result = await sweepOnce(deps);

        expect(result.failed).toContain(runId);
        const after = await ctx.db.repos.runs.getRunWithEvents(runId);
        expect(after?.run.status).toBe('FAILED');
        expect(after?.run.errorSummary).toBe(STALE_FAILURE_SUMMARY);
        expect(after?.run.finishedAt).not.toBeNull();
        expect(after?.events.some((event) => event.type === 'RUN_FAILED')).toBe(true);
    });

    it('leaves a freshly-heartbeating RUNNING run alone', async () => {
        const { runId } = await createScanAndRun('sweeper-fresh-running');
        await ctx.db.repos.runs.updateStatus(runId, 'RUNNING', { startedAt: new Date() });
        await ctx.db.repos.runs.heartbeat(runId);

        const result = await sweepOnce(deps);

        expect(result.failed).not.toContain(runId);
        const after = await ctx.db.repos.runs.getRunWithEvents(runId);
        expect(after?.run.status).toBe('RUNNING');
    });

    it('marks a stale CANCELLING run CANCELLED (the cancelling worker is gone)', async () => {
        const { runId } = await createScanAndRun('sweeper-stale-cancelling');
        await ctx.db.repos.runs.updateStatus(runId, 'RUNNING', { startedAt: new Date(Date.now() - 300_000) });
        await ctx.db.repos.runs.updateStatus(runId, 'CANCELLING');
        await backdateHeartbeat(runId, 300_000);

        const result = await sweepOnce(deps);

        expect(result.cancelled).toContain(runId);
        expect(result.failed).not.toContain(runId);
        const after = await ctx.db.repos.runs.getRunWithEvents(runId);
        expect(after?.run.status).toBe('CANCELLED');
        expect(after?.run.errorSummary).toBe(STALE_CANCEL_SUMMARY);
        expect(after?.events.some((event) => event.type === 'RUN_COMPLETED')).toBe(true);
    });

    it('never touches QUEUED runs (they have no heartbeat by design)', async () => {
        const { runId } = await createScanAndRun('sweeper-queued');
        await ctx.db.prisma.scanRun.update({
            where: { id: runId },
            data: { createdAt: new Date(Date.now() - 3_600_000) },
        });

        const result = await sweepOnce(deps);

        expect(result.failed).not.toContain(runId);
        expect(result.cancelled).not.toContain(runId);
        const after = await ctx.db.repos.runs.getRunWithEvents(runId);
        expect(after?.run.status).toBe('QUEUED');
    });

    it('removes the leftover BullMQ job and releases the scan lock', async () => {
        const { scanId, runId } = await createScanAndRun('sweeper-cleanup');
        await ctx.queue.add('crawl', { runId }, { jobId: crawlJobId(scanId, runId) });
        await ctx.redis.set(testKeyBuilders(SLUG).scanLockKey(scanId), runId, 'PX', 300_000);
        await ctx.db.repos.runs.updateStatus(runId, 'RUNNING', { startedAt: new Date(Date.now() - 300_000) });
        await backdateHeartbeat(runId, 300_000);

        await sweepOnce(deps);

        expect(await ctx.queue.getJob(crawlJobId(scanId, runId))).toBeUndefined();
        expect(await ctx.redis.get(testKeyBuilders(SLUG).scanLockKey(scanId))).toBeNull();
    });
});
