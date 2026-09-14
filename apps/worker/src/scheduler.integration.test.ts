/**
 * ScanScheduler.tickOnce against the real test DB + Redis: proves the
 * wiring computeDueScans → enqueueScanRun (run row + BullMQ job), the
 * double-fire guard across consecutive ticks, and the disabled-scan filter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScanScheduler } from './scheduler.js';
import type { QueueAdminDeps } from './queue-admin.js';
import { crawlJobId } from './queue-admin.js';
import {
    createTestContext,
    destroyTestContext,
    testKeyBuilders,
    truncateAll,
    type TestContext,
} from './test/helpers.js';

const SLUG = 'scheduler';
const START_URLS = ['https://www.sahibinden.com/emlak'];

describe('ScanScheduler (integration)', () => {
    let ctx: TestContext;
    let scheduler: ScanScheduler;

    beforeAll(async () => {
        ctx = await createTestContext(SLUG);
        const queueAdmin: QueueAdminDeps = {
            repos: ctx.db.repos,
            queue: ctx.queue,
            redis: ctx.redis,
            keyBuilders: testKeyBuilders(SLUG),
        };
        scheduler = new ScanScheduler({ repos: ctx.db.repos, queueAdmin, logger: ctx.logger });
    });

    beforeEach(async () => {
        await truncateAll(ctx.db);
        await ctx.queue.obliterate({ force: true });
    });

    afterAll(async () => {
        scheduler.stop();
        await destroyTestContext(ctx);
    });

    it('fires a due cron scan exactly once across consecutive ticks (double-fire guard)', async () => {
        // Every-minute cron is always within the 60s due window.
        const scan = await ctx.db.repos.scans.create({
            name: 'sched-every-minute',
            startUrls: START_URLS,
            schedule: '* * * * *',
            timezone: 'Europe/Istanbul',
        });

        const first = await scheduler.tickOnce(new Date());
        const firstDecision = first.find((d) => d.scanId === scan.id);
        expect(firstDecision?.due).toBe(true);

        let runs = await ctx.db.repos.runs.listRuns(scan.id);
        expect(runs.total).toBe(1);
        expect(runs.rows[0]?.trigger).toBe('SCHEDULE');
        expect(runs.rows[0]?.status).toBe('QUEUED');
        const job = await ctx.queue.getJob(crawlJobId(scan.id, runs.rows[0]?.id ?? ''));
        expect(job).toBeDefined();

        // Second tick: the run is QUEUED (active) AND already fired for this
        // occurrence — either guard must suppress a duplicate.
        const second = await scheduler.tickOnce(new Date());
        const secondDecision = second.find((d) => d.scanId === scan.id);
        expect(secondDecision?.due).toBe(false);
        expect(['already-active', 'already-fired']).toContain(secondDecision?.reason);
        runs = await ctx.db.repos.runs.listRuns(scan.id);
        expect(runs.total).toBe(1);
    });

    it('never schedules disabled scans', async () => {
        const scan = await ctx.db.repos.scans.create({
            name: 'sched-disabled',
            startUrls: START_URLS,
            schedule: '* * * * *',
            enabled: false,
        });

        await scheduler.tickOnce(new Date());

        const runs = await ctx.db.repos.runs.listRuns(scan.id);
        expect(runs.total).toBe(0);
    });

    it('skips invalid cron expressions without failing the tick', async () => {
        const bad = await ctx.db.repos.scans.create({
            name: 'sched-invalid',
            startUrls: START_URLS,
            schedule: 'not-a-cron',
        });
        const good = await ctx.db.repos.scans.create({
            name: 'sched-valid',
            startUrls: START_URLS,
            schedule: '* * * * *',
        });

        const decisions = await scheduler.tickOnce(new Date());

        expect(decisions.find((d) => d.scanId === bad.id)).toMatchObject({ due: false, reason: 'invalid-schedule' });
        expect(decisions.find((d) => d.scanId === good.id)?.due).toBe(true);
        expect((await ctx.db.repos.runs.listRuns(bad.id)).total).toBe(0);
        expect((await ctx.db.repos.runs.listRuns(good.id)).total).toBe(1);
    });
});
