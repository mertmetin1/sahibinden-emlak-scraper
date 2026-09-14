/**
 * queue-admin against the real Postgres test DB + real Redis (prefixed).
 * No browser: jobs stay `waiting` in the queue, which is exactly what the
 * duplicate-guard / cancel / retry flows need.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    crawlJobId,
    enqueueScanRun,
    QueueAdminError,
    requestCancelRun,
    retryRun,
} from './queue-admin.js';
import type { QueueAdminDeps } from './queue-admin.js';
import type { WorkerSnapshot } from './snapshot.js';
import {
    createTestContext,
    destroyTestContext,
    flushTestKeys,
    testKeyBuilders,
    truncateAll,
    type TestContext,
} from './test/helpers.js';

const START_URLS = ['https://www.sahibinden.com/emlak'];
/** Isolation slug: own database (sahibindenbot_test_queue_admin) + own Redis keyspace (sahtest-queue_admin:*). */
const SLUG = 'queue_admin';

describe('queue-admin', () => {
    let ctx: TestContext;
    let deps: QueueAdminDeps;

    beforeAll(async () => {
        ctx = await createTestContext(SLUG);
        deps = {
            repos: ctx.db.repos,
            queue: ctx.queue,
            redis: ctx.redis,
            logger: undefined,
            keyBuilders: testKeyBuilders(SLUG),
        };
    });

    beforeEach(async () => {
        await truncateAll(ctx.db);
        await ctx.queue.obliterate({ force: true });
        await flushTestKeys(ctx.redis, SLUG);
    });

    afterAll(async () => {
        await destroyTestContext(ctx);
    });

    async function createScan(name: string, enabled = true): Promise<string> {
        const scan = await ctx.db.repos.scans.create({ name, startUrls: START_URLS, enabled });
        return scan.id;
    }

    it('creates a QUEUED run with a snapshot and enqueues the BullMQ job', async () => {
        const scanId = await createScan('qa-enqueue');

        const { runId, jobId } = await enqueueScanRun(deps, scanId, 'MANUAL');

        expect(jobId).toBe(crawlJobId(scanId, runId));
        const loaded = await ctx.db.repos.runs.getRunWithEvents(runId);
        expect(loaded?.run.status).toBe('QUEUED');
        expect(loaded?.run.trigger).toBe('MANUAL');
        const snapshot = loaded?.run.configurationSnapshot as WorkerSnapshot;
        expect(snapshot.startUrls).toEqual(START_URLS);
        expect(snapshot.snapshotVersion).toBe(1);

        const job = await ctx.queue.getJob(jobId);
        expect(job).toBeDefined();
        expect(job?.data.runId).toBe(runId);
        expect(job?.opts.attempts).toBe(2);
        expect(job?.opts.backoff).toEqual({ type: 'fixed', delay: 5000 });
    });

    it('rejects a second enqueue while a run is active (typed RUN_ALREADY_ACTIVE)', async () => {
        const scanId = await createScan('qa-duplicate');
        await enqueueScanRun(deps, scanId, 'MANUAL');

        await expect(enqueueScanRun(deps, scanId, 'MANUAL')).rejects.toMatchObject({
            name: 'QueueAdminError',
            code: 'RUN_ALREADY_ACTIVE',
        });
        // exactly one run row exists
        const runs = await ctx.db.repos.runs.listRuns(scanId);
        expect(runs.total).toBe(1);
    });

    it('rejects enqueue for a disabled scan (SCAN_DISABLED) and a missing scan (SCAN_NOT_FOUND)', async () => {
        const disabledId = await createScan('qa-disabled', false);
        await expect(enqueueScanRun(deps, disabledId, 'MANUAL')).rejects.toMatchObject({ code: 'SCAN_DISABLED' });
        await expect(enqueueScanRun(deps, 'nonexistent-scan-id', 'MANUAL')).rejects.toMatchObject({
            code: 'SCAN_NOT_FOUND',
        });
    });

    it('caps TEST runs (maxItems 25, maxPages 2, debugMode) without touching the definition', async () => {
        const scanId = await createScan('qa-test-caps');

        const { runId } = await enqueueScanRun(deps, scanId, 'TEST');

        const loaded = await ctx.db.repos.runs.getRunWithEvents(runId);
        const snapshot = loaded?.run.configurationSnapshot as WorkerSnapshot;
        expect(snapshot.maxItems).toBe(25);
        expect(snapshot.maxPages).toBe(2);
        expect(snapshot.debugMode).toBe(true);

        const scan = await ctx.db.repos.scans.getById(scanId);
        expect(scan?.maxItems).toBeNull();
        expect(scan?.maxPages).toBeNull();
        expect(scan?.debugMode).toBe(false);
    });

    it('cancels a QUEUED run: job removed, run CANCELLED, lock released, scan re-enqueueable', async () => {
        const scanId = await createScan('qa-cancel-queued');
        const { runId, jobId } = await enqueueScanRun(deps, scanId, 'MANUAL');

        const result = await requestCancelRun(deps, runId);

        expect(result).toEqual({ runId, status: 'CANCELLED' });
        const loaded = await ctx.db.repos.runs.getRunWithEvents(runId);
        expect(loaded?.run.status).toBe('CANCELLED');
        expect(await ctx.queue.getJob(jobId)).toBeUndefined();
        expect(await ctx.redis.get(testKeyBuilders(SLUG).scanLockKey(scanId))).toBeNull();

        // The scan is free again — a new enqueue succeeds.
        const again = await enqueueScanRun(deps, scanId, 'MANUAL');
        expect(again.runId).not.toBe(runId);
    });

    it('cancels a RUNNING run cooperatively: cancel key set + status CANCELLING', async () => {
        const scanId = await createScan('qa-cancel-running');
        const { runId } = await enqueueScanRun(deps, scanId, 'MANUAL');
        await ctx.db.repos.runs.updateStatus(runId, 'RUNNING', { startedAt: new Date() });

        const result = await requestCancelRun(deps, runId);

        expect(result).toEqual({ runId, status: 'CANCELLING' });
        expect(await ctx.redis.get(testKeyBuilders(SLUG).cancelKey(runId))).toBe('1');
        const loaded = await ctx.db.repos.runs.getRunWithEvents(runId);
        expect(loaded?.run.status).toBe('CANCELLING');
    });

    it('rejects cancel of a terminal run (INVALID_RUN_STATE)', async () => {
        const scanId = await createScan('qa-cancel-terminal');
        const { runId } = await enqueueScanRun(deps, scanId, 'MANUAL');
        await requestCancelRun(deps, runId); // → CANCELLED

        await expect(requestCancelRun(deps, runId)).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });
        await expect(requestCancelRun(deps, 'nonexistent-run-id')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    });

    it('retryRun creates a NEW run with trigger RETRY and the SAME snapshot', async () => {
        const scanId = await createScan('qa-retry');
        const original = await enqueueScanRun(deps, scanId, 'MANUAL');
        await requestCancelRun(deps, original.runId); // CANCELLED is retryable
        const originalRun = (await ctx.db.repos.runs.getRunWithEvents(original.runId))?.run;

        const retried = await enqueueScanRunRetry(original.runId);

        expect(retried.runId).not.toBe(original.runId);
        const retryRunRow = (await ctx.db.repos.runs.getRunWithEvents(retried.runId))?.run;
        expect(retryRunRow?.trigger).toBe('RETRY');
        expect(retryRunRow?.status).toBe('QUEUED');
        expect(retryRunRow?.configurationSnapshot).toEqual(originalRun?.configurationSnapshot);
        // The retry is enqueued as its own job.
        const job = await ctx.queue.getJob(crawlJobId(scanId, retried.runId));
        expect(job?.data.runId).toBe(retried.runId);
    });

    it('retryRun rejects non-terminal runs (INVALID_RUN_STATE)', async () => {
        const scanId = await createScan('qa-retry-active');
        const { runId } = await enqueueScanRun(deps, scanId, 'MANUAL'); // QUEUED = active

        await expect(enqueueScanRunRetry(runId)).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });
    });

    it('QueueAdminError is an Error subclass with a stable code', () => {
        const err = new QueueAdminError('RUN_ALREADY_ACTIVE', 'boom');
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('QueueAdminError');
        expect(err.code).toBe('RUN_ALREADY_ACTIVE');
    });

    async function enqueueScanRunRetry(runId: string) {
        return retryRun(deps, runId);
    }
});
