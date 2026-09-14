/**
 * Run control tests — the frozen queue contract end to end (API side):
 * run → QUEUED row + BullMQ job in Redis; duplicate → 409; cancel flows;
 * retry reuses the snapshot; test runs apply the frozen overrides.
 *
 * No worker is running in these tests: QUEUED runs stay queued, and terminal
 * states are forced through the repository (simulating worker outcomes).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunControlService } from '../queue.js';
import { buildTestContext, uniqueName, type TestAppContext } from '../testing/test-app.js';

const SCAN_URL = 'https://www.sahibinden.com/satilik-daire/adana-seyhan';

describe('run control', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
        ctx = await buildTestContext('runs');
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    async function createScan(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
        const res = await ctx.app.inject({
            method: 'POST',
            url: '/api/scans',
            payload: { name: uniqueName('run-scan'), startUrls: [SCAN_URL], browserMode: 'managed', ...overrides },
        });
        expect(res.statusCode).toBe(201);
        const scan = res.json() as { id: string };
        ctx.track.scanIds.push(scan.id);
        return scan;
    }

    async function startRun(scanId: string): Promise<{ id: string; [k: string]: unknown }> {
        const res = await ctx.app.inject({ method: 'POST', url: `/api/scans/${scanId}/run` });
        expect(res.statusCode).toBe(201);
        return res.json() as { id: string };
    }

    /**
     * Simulates the worker's terminal handling: force the run into a terminal
     * status and release the transport artifacts (BullMQ job + scan lock).
     */
    async function forceTerminal(scanId: string, runId: string, status: 'FAILED' | 'CANCELLED'): Promise<void> {
        await ctx.app.db.repos.runs.finishRun(runId, status, {}, status === 'FAILED' ? 'forced failure (test)' : null);
        const jobId = RunControlService.jobId(scanId, runId);
        const job = await ctx.app.runControl.queue.getJob(jobId);
        if (job !== undefined) {
            await job.remove().catch(() => undefined);
        }
        await ctx.app.redis.del(ctx.keys.scanLockKey(scanId));
    }

    it('creates a QUEUED run row and enqueues a BullMQ job per the frozen contract', async () => {
        const scan = await createScan();
        const run = await startRun(scan.id);

        expect(run.status).toBe('QUEUED');
        expect(run.trigger).toBe('MANUAL');
        expect(run.scanDefinitionId).toBe(scan.id);
        const snapshot = run.configurationSnapshot as Record<string, unknown>;
        expect(snapshot.scanDefinitionId).toBe(scan.id);
        expect(snapshot.startUrls).toEqual([SCAN_URL]);
        expect(snapshot.browserMode).toBe('managed');
        expect(snapshot.trigger).toBe('MANUAL');

        // Job exists in Redis with the contract shape.
        const jobId = RunControlService.jobId(scan.id, run.id as string);
        const job = await ctx.app.runControl.queue.getJob(jobId);
        expect(job).toBeDefined();
        expect(job?.name).toBe('crawl');
        expect(job?.data).toEqual({ runId: run.id });
        expect(job?.opts.attempts).toBe(2);
        expect(job?.opts.backoff).toEqual({ type: 'fixed', delay: 5000 });
        expect(job?.opts.removeOnComplete).toBe(100);
        expect(job?.opts.removeOnFail).toBe(500);

        await forceTerminal(scan.id, run.id as string, 'CANCELLED');
    });

    it('refuses a duplicate run while one is active (409 RUN_ALREADY_ACTIVE)', async () => {
        const scan = await createScan();
        const run = await startRun(scan.id);

        const dup = await ctx.app.inject({ method: 'POST', url: `/api/scans/${scan.id}/run` });
        expect(dup.statusCode).toBe(409);
        expect(dup.json().error.code).toBe('RUN_ALREADY_ACTIVE');

        // test trigger is blocked by the same guard
        const dupTest = await ctx.app.inject({ method: 'POST', url: `/api/scans/${scan.id}/test` });
        expect(dupTest.statusCode).toBe(409);

        await forceTerminal(scan.id, run.id as string, 'CANCELLED');
    });

    it('cancels a QUEUED run: job removed, status CANCELLED, lock released', async () => {
        const scan = await createScan();
        const run = await startRun(scan.id);
        const jobId = RunControlService.jobId(scan.id, run.id as string);

        const cancel = await ctx.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
        expect(cancel.statusCode).toBe(200);
        expect(cancel.json().status).toBe('CANCELLED');

        // Job is gone from Redis…
        expect(await ctx.app.runControl.queue.getJob(jobId)).toBeUndefined();
        // …and the scan lock is released, so a new run can start immediately.
        const rerun = await startRun(scan.id);
        expect(rerun.status).toBe('QUEUED');

        await forceTerminal(scan.id, rerun.id as string, 'CANCELLED');
    });

    it('cancels a RUNNING run cooperatively: cancel key set + status CANCELLING', async () => {
        const scan = await createScan();
        const run = await startRun(scan.id);
        await ctx.app.db.repos.runs.updateStatus(run.id as string, 'RUNNING', { startedAt: new Date() });

        const cancel = await ctx.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
        expect(cancel.statusCode).toBe(200);
        expect(cancel.json().status).toBe('CANCELLING');

        // The cooperative cancel signal is in Redis (worker polls this key).
        expect(await ctx.app.redis.get(ctx.keys.cancelKey(run.id as string))).toBe('1');

        // Idempotent while CANCELLING.
        const again = await ctx.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
        expect(again.statusCode).toBe(200);
        expect(again.json().status).toBe('CANCELLING');

        await forceTerminal(scan.id, run.id as string, 'CANCELLED');
    });

    it('refuses to cancel a terminal run (409 RUN_NOT_CANCELLABLE)', async () => {
        const scan = await createScan();
        const run = await startRun(scan.id);
        await forceTerminal(scan.id, run.id as string, 'FAILED');

        const res = await ctx.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('RUN_NOT_CANCELLABLE');
    });

    it('retries a FAILED run: new RETRY run with the SAME snapshot', async () => {
        const scan = await createScan({ maxItems: 42 });
        const run = await startRun(scan.id);
        await forceTerminal(scan.id, run.id as string, 'FAILED');

        const retry = await ctx.app.inject({ method: 'POST', url: `/api/runs/${run.id}/retry` });
        expect(retry.statusCode).toBe(201);
        expect(retry.json().trigger).toBe('RETRY');
        expect(retry.json().status).toBe('QUEUED');
        expect(retry.json().id).not.toBe(run.id);
        // Same snapshot — retry = "same config, new attempt" (incl. capturedAt).
        expect(retry.json().configurationSnapshot).toEqual(run.configurationSnapshot);
        expect((retry.json().configurationSnapshot as Record<string, unknown>).maxItems).toBe(42);

        // The retry is enqueued under the contract job id.
        const job = await ctx.app.runControl.queue.getJob(RunControlService.jobId(scan.id, retry.json().id as string));
        expect(job?.data).toEqual({ runId: retry.json().id });

        await forceTerminal(scan.id, retry.json().id as string, 'CANCELLED');
    });

    it('refuses to retry a non-terminal run (409 RUN_NOT_RETRYABLE)', async () => {
        const scan = await createScan();
        const run = await startRun(scan.id);

        const res = await ctx.app.inject({ method: 'POST', url: `/api/runs/${run.id}/retry` });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('RUN_NOT_RETRYABLE');

        await forceTerminal(scan.id, run.id as string, 'CANCELLED');
    });

    it('applies the frozen test-run overrides in the snapshot only', async () => {
        const scan = await createScan();
        const res = await ctx.app.inject({ method: 'POST', url: `/api/scans/${scan.id}/test` });
        expect(res.statusCode).toBe(201);
        const run = res.json();
        expect(run.trigger).toBe('TEST');
        const snapshot = run.configurationSnapshot as Record<string, unknown>;
        expect(snapshot.maxItems).toBe(10);
        expect(snapshot.maxPages).toBe(1);

        // The definition itself is untouched.
        const detail = await ctx.app.inject({ method: 'GET', url: `/api/scans/${scan.id}` });
        expect(detail.json().maxItems).toBeNull();
        expect(detail.json().maxPages).toBeNull();
        // …and the detail view surfaces the latest run.
        expect(detail.json().latestRun.id).toBe(run.id);

        await forceTerminal(scan.id, run.id as string, 'CANCELLED');
    });

    it('lists runs filtered by scanId/status and returns full run detail with events', async () => {
        const scan = await createScan();
        const run = await startRun(scan.id);

        const byScan = await ctx.app.inject({ method: 'GET', url: `/api/runs?scanId=${scan.id}` });
        expect(byScan.statusCode).toBe(200);
        expect(byScan.json().rows.some((row: { id: string }) => row.id === run.id)).toBe(true);

        const queued = await ctx.app.inject({ method: 'GET', url: `/api/runs?scanId=${scan.id}&status=QUEUED` });
        expect(queued.json().rows.some((row: { id: string }) => row.id === run.id)).toBe(true);

        const failed = await ctx.app.inject({ method: 'GET', url: `/api/runs?scanId=${scan.id}&status=FAILED` });
        expect(failed.json().rows.some((row: { id: string }) => row.id === run.id)).toBe(false);

        const detail = await ctx.app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().configurationSnapshot).toBeDefined();
        expect(detail.json().counters).toMatchObject({ pagesVisited: 0, itemsDiscovered: 0, failedRequests: 0 });
        expect(detail.json().errorSummary).toBeNull();
        expect(detail.json().events).toEqual([]);

        const missing = await ctx.app.inject({ method: 'GET', url: '/api/runs/does-not-exist' });
        expect(missing.statusCode).toBe(404);

        await forceTerminal(scan.id, run.id as string, 'CANCELLED');
    });
});
