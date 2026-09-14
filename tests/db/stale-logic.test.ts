/**
 * Staleness state machine — applySuccessfulRunStaleness with
 * staleAfterSuccessfulRuns=2: miss counting, STALE transition, resurrection,
 * and the exclusion rules (FAILED / non-SUCCEEDED / incremental runs never
 * advance staleness; never-expected and REMOVED listings are never touched).
 *
 * Dedicated database: sahibindenbot_test_stale.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE } from '../../packages/database/src/index.js';
import type { DatabaseClient } from '../../packages/database/src/index.js';
import { createScan, openTestDatabase, runScan, truncateAllTables } from './db-test-kit.js';

const DB_NAME = 'sahibindenbot_test_stale';

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

async function listingState(sourceListingId: string): Promise<{ status: string; missedRunCount: number }> {
    const row = await db.prisma.listing.findUnique({
        where: { source_sourceListingId: { source: DEFAULT_SOURCE, sourceListingId } },
        select: { status: true, missedRunCount: true },
    });
    expect(row, `listing ${sourceListingId} must exist`).not.toBeNull();
    return row!;
}

describe('applySuccessfulRunStaleness — full lifecycle (threshold 2)', () => {
    it('run1(A,B) -> run2(A) -> run3(A) marks B STALE; run4(A,B) resurrects B', async () => {
        const scan = await createScan(db, { staleAfterSuccessfulRuns: 2 });

        // run1: both observed -> nothing stale, nothing missed
        const { run: run1 } = await runScan(db, scan.id, ['A', 'B']);
        await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run1.id)).resolves.toEqual({
            staleMarked: 0,
            resurrected: 0,
        });
        expect(await listingState('A')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });
        expect(await listingState('B')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });

        // run2: B absent -> missedRunCount 1, still ACTIVE (a single absence NEVER marks stale)
        const { run: run2 } = await runScan(db, scan.id, ['A']);
        await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run2.id)).resolves.toEqual({
            staleMarked: 0,
            resurrected: 0,
        });
        expect(await listingState('B')).toEqual({ status: 'ACTIVE', missedRunCount: 1 });
        expect(await listingState('A')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });

        // run3: B absent again -> threshold reached -> STALE
        const { run: run3 } = await runScan(db, scan.id, ['A']);
        await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run3.id)).resolves.toEqual({
            staleMarked: 1,
            resurrected: 0,
        });
        expect(await listingState('B')).toEqual({ status: 'STALE', missedRunCount: 2 });
        expect(await listingState('A')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });

        // run4: B observed again. The upsert path itself resurrects on every
        // observation (status ACTIVE, missedRunCount 0), so by the time
        // applySuccessfulRunStaleness runs there is no STALE row left among the
        // present listings — the function's resurrected backstop is a no-op.
        const { run: run4 } = await runScan(db, scan.id, ['A', 'B']);
        await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run4.id)).resolves.toEqual({
            staleMarked: 0,
            resurrected: 0,
        });
        expect(await listingState('B')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });
        expect(await listingState('A')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });
    });
});

describe('applySuccessfulRunStaleness — exclusion rules', () => {
    it('FAILED / PARTIAL / RUNNING runs never advance staleness', async () => {
        const scan = await createScan(db, { staleAfterSuccessfulRuns: 2 });
        await runScan(db, scan.id, ['A', 'B']);

        for (const status of ['FAILED', 'PARTIAL', 'RUNNING'] as const) {
            const { run } = await runScan(db, scan.id, [], { status });
            // eslint-disable-next-line no-await-in-loop -- sequential state assertions
            await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run.id)).resolves.toEqual({
                staleMarked: 0,
                resurrected: 0,
            });
        }

        // no absence was ever recorded: both listings untouched
        expect(await listingState('A')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });
        expect(await listingState('B')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });
    });

    it('incremental runs neither advance staleness nor create expectations', async () => {
        const scan = await createScan(db, { staleAfterSuccessfulRuns: 2 });

        // run1 (full, SUCCEEDED) observes A -> A becomes "expected" from now on
        const { run: run1 } = await runScan(db, scan.id, ['A']);
        await db.repos.listings.applySuccessfulRunStaleness(scan.id, run1.id);

        // run2 (incremental, SUCCEEDED) observes nothing -> complete no-op
        const { run: run2 } = await runScan(db, scan.id, [], { incremental: true });
        await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run2.id)).resolves.toEqual({
            staleMarked: 0,
            resurrected: 0,
        });
        expect(await listingState('A')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });

        // run3 (full, SUCCEEDED) observes nothing -> A missed EXACTLY once.
        // If the incremental run2 had counted as a miss, this would be 2/STALE.
        const { run: run3 } = await runScan(db, scan.id, []);
        await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run3.id)).resolves.toEqual({
            staleMarked: 0,
            resurrected: 0,
        });
        expect(await listingState('A')).toEqual({ status: 'ACTIVE', missedRunCount: 1 });

        // run4 (full, SUCCEEDED) observes nothing -> second miss -> STALE
        const { run: run4 } = await runScan(db, scan.id, []);
        await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run4.id)).resolves.toEqual({
            staleMarked: 1,
            resurrected: 0,
        });
        expect(await listingState('A')).toEqual({ status: 'STALE', missedRunCount: 2 });
    });

    it('a listing never observed by THIS scan is never touched', async () => {
        const scan = await createScan(db, { staleAfterSuccessfulRuns: 2 });
        const otherScan = await createScan(db, { staleAfterSuccessfulRuns: 2 });

        // C only ever appears in OTHER scan's successful run
        await runScan(db, otherScan.id, ['C']);

        // two full successful runs of THIS scan observing only A (C absent both times)
        const { run: run1 } = await runScan(db, scan.id, ['A']);
        await db.repos.listings.applySuccessfulRunStaleness(scan.id, run1.id);
        const { run: run2 } = await runScan(db, scan.id, ['A']);
        await db.repos.listings.applySuccessfulRunStaleness(scan.id, run2.id);

        // C was never expected by this scan -> untouched
        expect(await listingState('C')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });
        expect(await listingState('A')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });
    });

    it('REMOVED listings are terminal — absence never increments their missedRunCount', async () => {
        const scan = await createScan(db, { staleAfterSuccessfulRuns: 2 });

        const { run: run1, listingIds } = await runScan(db, scan.id, ['A', 'B']);
        await db.repos.listings.applySuccessfulRunStaleness(scan.id, run1.id);

        // explicit site signal ("yayından kaldırıldı")
        await db.repos.listings.markRemoved(listingIds.get('B')!);
        expect(await listingState('B')).toEqual({ status: 'REMOVED', missedRunCount: 0 });

        // B absent from subsequent successful runs -> must NOT be touched at all
        const { run: run2 } = await runScan(db, scan.id, ['A']);
        await db.repos.listings.applySuccessfulRunStaleness(scan.id, run2.id);
        const { run: run3 } = await runScan(db, scan.id, ['A']);
        await db.repos.listings.applySuccessfulRunStaleness(scan.id, run3.id);

        expect(await listingState('B')).toEqual({ status: 'REMOVED', missedRunCount: 0 });
    });

    it('staleness is a no-op when the scan has staleDetectionEnabled=false', async () => {
        const scan = await createScan(db, { staleAfterSuccessfulRuns: 2, staleDetectionEnabled: false });

        const { run: run1 } = await runScan(db, scan.id, ['A', 'B']);
        await db.repos.listings.applySuccessfulRunStaleness(scan.id, run1.id);
        const { run: run2 } = await runScan(db, scan.id, ['A']);
        await expect(db.repos.listings.applySuccessfulRunStaleness(scan.id, run2.id)).resolves.toEqual({
            staleMarked: 0,
            resurrected: 0,
        });
        const { run: run3 } = await runScan(db, scan.id, ['A']);
        await db.repos.listings.applySuccessfulRunStaleness(scan.id, run3.id);

        expect(await listingState('B')).toEqual({ status: 'ACTIVE', missedRunCount: 0 });
    });
});
