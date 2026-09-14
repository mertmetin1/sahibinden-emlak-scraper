/**
 * Crawl-worker processor paths that need NO browser, against the real
 * BullMQ Worker + real Redis (prefixed) + real test DB:
 *
 * - a run cancelled while queued (status CANCELLING at pickup) is marked
 *   CANCELLED and the job completes — no crawl ever starts;
 * - a job referencing a missing run fails WITHOUT retry
 *   (UnrecoverableError), proving the "no retry on nonsense jobs" contract;
 * - a malformed snapshot is unrecoverable too (no retry), run marked FAILED.
 *
 * The full RUNNING→runCrawl path drives a real browser and is covered by
 * the (gated) live smoke suite, not here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CrawlJobData } from '@sahibindenbot/shared';
import { PrismaCookieProfileRepository, PrismaProxyProfileRepository, PrismaSessionPolicyRepository } from '@sahibindenbot/database';
import { crawlJobId } from './queue-admin.js';
import { bullmqConnectionOptions } from './redis.js';
import { createCrawlWorker } from './worker.js';
import type { CrawlWorkerHandle } from './worker.js';
import {
    createTestContext,
    destroyTestContext,
    testKeyBuilders,
    truncateAll,
    TEST_REDIS_URL,
    type TestContext,
} from './test/helpers.js';

const SLUG = 'worker_exec';
/** Any valid base64 32-byte key — these paths never decrypt anything. */
const DUMMY_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const SNAPSHOT = { startUrls: ['https://www.sahibinden.com/emlak'] };

describe('crawl worker (browser-free paths)', () => {
    let ctx: TestContext;
    let handle: CrawlWorkerHandle;

    beforeAll(async () => {
        ctx = await createTestContext(SLUG);
        handle = createCrawlWorker({
            db: ctx.db,
            redis: ctx.redis,
            connection: bullmqConnectionOptions(TEST_REDIS_URL),
            proxyProfiles: new PrismaProxyProfileRepository(ctx.db.prisma, DUMMY_MASTER_KEY),
            cookieProfiles: new PrismaCookieProfileRepository(ctx.db.prisma, DUMMY_MASTER_KEY),
            sessionPolicies: new PrismaSessionPolicyRepository(ctx.db.prisma),
            logger: ctx.logger,
            artifactsDir: 'storage/artifacts-test',
            keyBuilders: testKeyBuilders(SLUG),
            prefix: `sahtest-${SLUG}`,
        });
        // Surface async worker errors immediately instead of as unhandled rejections.
        handle.worker.on('error', () => undefined);
    });

    beforeEach(async () => {
        await truncateAll(ctx.db);
    });

    afterAll(async () => {
        await handle.worker.close();
        await destroyTestContext(ctx);
    });

    it('marks a run cancelled-while-queued as CANCELLED and completes the job', async () => {
        const scan = await ctx.db.repos.scans.create({ name: 'exec-cancel-queued', startUrls: SNAPSHOT.startUrls });
        const run = await ctx.db.repos.runs.createRun(scan.id, 'MANUAL', SNAPSHOT);
        // The API's job removal lost the race: the job is in the queue AND
        // the run is already CANCELLING when the worker picks it up.
        await ctx.db.repos.runs.updateStatus(run.id, 'CANCELLING');

        const completed = new Promise<string>((resolve, reject) => {
            handle.worker.once('completed', (job) => resolve(String(job.returnvalue)));
            handle.worker.once('failed', (_job, err) => reject(err));
        });
        await ctx.queue.add('crawl', { runId: run.id } satisfies CrawlJobData, {
            jobId: crawlJobId(scan.id, run.id),
        });

        await expect(completed).resolves.toBe('CANCELLED');
        const after = await ctx.db.repos.runs.getRunWithEvents(run.id);
        expect(after?.run.status).toBe('CANCELLED');
        expect(after?.run.errorSummary).toBe('cancelled while queued');
        expect(after?.run.finishedAt).not.toBeNull();
    });

    it('fails a job with a missing run WITHOUT retry (UnrecoverableError)', async () => {
        const bogusRunId = `missing-${randomUUID()}`;
        const failed = new Promise<{ err: Error; attemptsMade: number }>((resolve) => {
            handle.worker.on('failed', (job, err) => {
                if (job?.data.runId === bogusRunId) resolve({ err, attemptsMade: job.attemptsMade });
            });
        });
        await ctx.queue.add('crawl', { runId: bogusRunId }, { attempts: 2 });

        const { err, attemptsMade } = await failed;
        expect(err.name).toBe('UnrecoverableError');
        expect(err.message).toContain('ScanRun not found');
        // BullMQ increments attemptsMade when the attempt FINISHES (job.js:
        // "Number of attempts after the job has failed"), so exactly 1 here
        // proves the single attempt was consumed and NOT retried (a retry
        // would surface a second 'failed' with attemptsMade === 2).
        expect(attemptsMade).toBe(1);
    });

    it('fails a run with a malformed snapshot as FAILED without retry', async () => {
        const scan = await ctx.db.repos.scans.create({ name: 'exec-bad-snapshot', startUrls: SNAPSHOT.startUrls });
        const run = await ctx.db.repos.runs.createRun(scan.id, 'MANUAL', { noStartUrls: true });

        const failed = new Promise<{ attemptsMade: number }>((resolve, reject) => {
            handle.worker.on('failed', (job, _err) => {
                if (job?.data.runId === run.id) resolve({ attemptsMade: job.attemptsMade });
            });
            handle.worker.once('completed', (job) => {
                if (job.data.runId === run.id) reject(new Error('must not complete'));
            });
        });
        await ctx.queue.add('crawl', { runId: run.id }, { jobId: crawlJobId(scan.id, run.id), attempts: 2 });

        const { attemptsMade } = await failed;
        expect(attemptsMade).toBe(1); // exactly one attempt — no retry (see above)
        const after = await ctx.db.repos.runs.getRunWithEvents(run.id);
        expect(after?.run.status).toBe('FAILED');
        expect(after?.run.errorSummary).toContain('configurationSnapshot');
    });
});
