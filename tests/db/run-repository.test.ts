/**
 * PrismaRunRepository — run lifecycle (createRun/updateStatus/heartbeat/
 * finishRun/incrementCounter), the event journal with BigInt autoincrement
 * ids (SSE replay contract: getRunWithEvents afterEventId), and stale-run
 * discovery for the sweeper (findStaleRunningRuns).
 *
 * Dedicated database: sahibindenbot_test_runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CrawlError } from '../../packages/shared/src/index.js';
import type { DatabaseClient, RunCounterField } from '../../packages/database/src/index.js';
import { createRun, createScan, openTestDatabase, truncateAllTables } from './db-test-kit.js';

const DB_NAME = 'sahibindenbot_test_runs';

let db: DatabaseClient;

beforeAll(() => {
    db = openTestDatabase(DB_NAME);
});

beforeEach(async () => {
    await truncateAllTables(db);
});

afterAll(async () => {
    await db.disconnect();
});

describe('run lifecycle', () => {
    it('createRun -> QUEUED with zeroed counters and the configuration snapshot round-tripped', async () => {
        const scan = await createScan(db);
        const snapshot = { incrementalMode: false, maxItems: 50, nested: { a: [1, 2, 3] } };
        const run = await createRun(db, scan.id, snapshot, 'MANUAL');

        expect(run.status).toBe('QUEUED');
        expect(run.trigger).toBe('MANUAL');
        expect(run.scanDefinitionId).toBe(scan.id);
        expect(run.configurationSnapshot).toEqual(snapshot);
        expect(run.counters).toEqual({
            pagesVisited: 0,
            categoryPagesVisited: 0,
            detailPagesVisited: 0,
            itemsDiscovered: 0,
            itemsInserted: 0,
            itemsUpdated: 0,
            pricesChanged: 0,
            failedRequests: 0,
            retryCount: 0,
        });
        expect(run.startedAt).toBeNull();
        expect(run.finishedAt).toBeNull();
        expect(run.heartbeatAt).toBeNull();
    });

    it('updateStatus walks QUEUED -> STARTING -> RUNNING -> SUCCEEDED with timestamps', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);

        await db.repos.runs.updateStatus(run.id, 'STARTING');
        await db.repos.runs.updateStatus(run.id, 'RUNNING', { startedAt: new Date() });

        let fetched = (await db.repos.runs.getRunWithEvents(run.id))!.run;
        expect(fetched.status).toBe('RUNNING');
        expect(fetched.startedAt).not.toBeNull();

        const finishedAt = new Date();
        await db.repos.runs.updateStatus(run.id, 'SUCCEEDED', { finishedAt, durationMs: 1234 });
        fetched = (await db.repos.runs.getRunWithEvents(run.id))!.run;
        expect(fetched.status).toBe('SUCCEEDED');
        expect(fetched.finishedAt!.getTime()).toBe(finishedAt.getTime());
        expect(fetched.durationMs).toBe(1234);
    });

    it('heartbeat sets and advances heartbeatAt', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        await db.repos.runs.updateStatus(run.id, 'RUNNING', { startedAt: new Date() });

        expect((await db.repos.runs.getRunWithEvents(run.id))!.run.heartbeatAt).toBeNull();

        await db.repos.runs.heartbeat(run.id);
        const first = (await db.repos.runs.getRunWithEvents(run.id))!.run.heartbeatAt;
        expect(first).not.toBeNull();

        await db.repos.runs.heartbeat(run.id);
        const second = (await db.repos.runs.getRunWithEvents(run.id))!.run.heartbeatAt;
        expect(second).not.toBeNull();
        expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
    });

    it('incrementCounter accumulates; unknown counter field throws CrawlError(DATABASE)', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);

        await db.repos.runs.incrementCounter(run.id, 'itemsInserted', 5);
        await db.repos.runs.incrementCounter(run.id, 'itemsInserted'); // default by=1
        await db.repos.runs.incrementCounter(run.id, 'failedRequests', 2);

        const counters = (await db.repos.runs.getRunWithEvents(run.id))!.run.counters;
        expect(counters.itemsInserted).toBe(6);
        expect(counters.failedRequests).toBe(2);

        await expect(
            db.repos.runs.incrementCounter(run.id, 'bogusCounter' as RunCounterField),
        ).rejects.toThrow(CrawlError);
        await expect(
            db.repos.runs.incrementCounter(run.id, 'bogusCounter' as RunCounterField),
        ).rejects.toMatchObject({ code: 'DATABASE' });
    });

    it('finishRun writes terminal status + absolute counters; durationMs derived from startedAt', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        await db.repos.runs.updateStatus(run.id, 'RUNNING', { startedAt: new Date(Date.now() - 1500) });

        await db.repos.runs.finishRun(run.id, 'SUCCEEDED', { itemsDiscovered: 10, itemsInserted: 7 }, 'tamam');

        const finished = (await db.repos.runs.getRunWithEvents(run.id))!.run;
        expect(finished.status).toBe('SUCCEEDED');
        expect(finished.counters.itemsDiscovered).toBe(10);
        expect(finished.counters.itemsInserted).toBe(7);
        expect(finished.finishedAt).not.toBeNull();
        expect(finished.durationMs).not.toBeNull();
        expect(finished.durationMs!).toBeGreaterThanOrEqual(1400);
        expect(finished.durationMs!).toBeLessThan(60_000);
        expect(finished.errorSummary).toBe('tamam');

        await expect(db.repos.runs.finishRun('nonexistent-run-id', 'FAILED', {})).rejects.toMatchObject({
            code: 'DATABASE',
        });
    });
});

describe('event journal (SSE replay contract)', () => {
    it('addEvent ids are strictly increasing decimal strings; data round-trips', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);

        const e1 = await db.repos.runs.addEvent(run.id, 'RUN_STARTED', { scanId: scan.id });
        const e2 = await db.repos.runs.addEvent(run.id, 'CATEGORY_PARSED', { page: 1, items: 20 });
        const e3 = await db.repos.runs.addEvent(run.id, 'RUN_COMPLETED'); // no data

        expect(BigInt(e2.id)).toBeGreaterThan(BigInt(e1.id));
        expect(BigInt(e3.id)).toBeGreaterThan(BigInt(e2.id));
        expect(e1.data).toEqual({ scanId: scan.id });
        expect(e2.data).toEqual({ page: 1, items: 20 });
        expect(e3.data).toBeNull();
        expect(e1.runId).toBe(run.id);
    });

    it('getRunWithEvents(afterEventId) returns only LATER events, ordered by id', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        const other = await createRun(db, scan.id);

        const events = [];
        for (let i = 0; i < 5; i += 1) {
            // eslint-disable-next-line no-await-in-loop -- ids must be strictly ordered
            events.push(await db.repos.runs.addEvent(run.id, `EV_${i}`));
        }
        await db.repos.runs.addEvent(other.id, 'OTHER_RUN_EVENT');

        // full replay
        const all = await db.repos.runs.getRunWithEvents(run.id);
        expect(all).not.toBeNull();
        expect(all!.events.map((e) => e.type)).toEqual(['EV_0', 'EV_1', 'EV_2', 'EV_3', 'EV_4']);

        // replay after the 2nd event -> only events 3..5 (Last-Event-ID semantics)
        const tail = await db.repos.runs.getRunWithEvents(run.id, events[1]!.id);
        expect(tail!.events.map((e) => e.type)).toEqual(['EV_2', 'EV_3', 'EV_4']);

        // after the last event -> empty
        const empty = await db.repos.runs.getRunWithEvents(run.id, events[4]!.id);
        expect(empty!.events).toEqual([]);

        // unknown run -> null
        await expect(db.repos.runs.getRunWithEvents('nonexistent-run-id')).resolves.toBeNull();
    });
});

describe('findStaleRunningRuns (sweeper input)', () => {
    it('returns only STARTING/RUNNING/CANCELLING runs with an old heartbeat (or old creation, never heartbeated)', async () => {
        const scan = await createScan(db);
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

        // stale RUNNING (old heartbeat) -> returned
        const staleRunning = await createRun(db, scan.id);
        await db.repos.runs.updateStatus(staleRunning.id, 'RUNNING', { startedAt: tenMinutesAgo });
        await db.repos.runs.heartbeat(staleRunning.id);
        await db.prisma.scanRun.update({ where: { id: staleRunning.id }, data: { heartbeatAt: tenMinutesAgo } });

        // fresh RUNNING -> NOT returned
        const freshRunning = await createRun(db, scan.id);
        await db.repos.runs.updateStatus(freshRunning.id, 'RUNNING', { startedAt: new Date() });
        await db.repos.runs.heartbeat(freshRunning.id);

        // stale heartbeat but SUCCEEDED -> NOT returned (terminal status)
        const staleSucceeded = await createRun(db, scan.id);
        await db.prisma.scanRun.update({
            where: { id: staleSucceeded.id },
            data: { status: 'SUCCEEDED', heartbeatAt: tenMinutesAgo },
        });

        // old creation, never heartbeated, QUEUED -> NOT returned (not an active status)
        const oldQueued = await createRun(db, scan.id);
        await db.prisma.scanRun.update({ where: { id: oldQueued.id }, data: { createdAt: tenMinutesAgo } });

        // old creation, never heartbeated, STARTING -> returned (createdAt fallback)
        const staleStarting = await createRun(db, scan.id);
        await db.prisma.scanRun.update({
            where: { id: staleStarting.id },
            data: { status: 'STARTING', createdAt: tenMinutesAgo },
        });

        // CANCELLING with old heartbeat -> returned
        const staleCancelling = await createRun(db, scan.id);
        await db.prisma.scanRun.update({
            where: { id: staleCancelling.id },
            data: { status: 'CANCELLING', heartbeatAt: tenMinutesAgo },
        });

        const stale = await db.repos.runs.findStaleRunningRuns(60_000);
        expect(new Set(stale.map((r) => r.id))).toEqual(
            new Set([staleRunning.id, staleStarting.id, staleCancelling.id]),
        );
    });
});
