/**
 * PrismaOutputRepository — the engine-facing adapter behind shared's
 * OutputRepository port: batch upserts, ScanRun counter flushing, error
 * isolation (one broken item never poisons the batch), finalize() no-op.
 *
 * Exercised through the shared OutputRepository interface type, exactly as the
 * scraper engine consumes it. Dedicated database: sahibindenbot_test_output.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CategoryListing, OutputRepository } from '../../packages/shared/src/index.js';
import { PrismaOutputRepository } from '../../packages/database/src/index.js';
import type { DatabaseClient, RunRecord } from '../../packages/database/src/index.js';
import { createRun, createScan, makeCategoryListing, makeListingDetail, openTestDatabase, REPO_ROOT, truncateAllTables } from './db-test-kit.js';

const DB_NAME = 'sahibindenbot_test_output';
const FIXTURE_PATH = path.join(REPO_ROOT, 'fixtures', 'baseline', 'upstream-category-output-istanbul-20.json');

let db: DatabaseClient;
let fixture: CategoryListing[];

beforeAll(async () => {
    db = openTestDatabase(DB_NAME);
    fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as CategoryListing[];
});

beforeEach(async () => {
    await truncateAllTables(db);
});

afterAll(async () => {
    await db.disconnect();
});

async function runCounters(runId: string): Promise<RunRecord['counters']> {
    const result = await db.repos.runs.getRunWithEvents(runId);
    expect(result).not.toBeNull();
    return result!.run.counters;
}

describe('PrismaOutputRepository through the OutputRepository port', () => {
    it('upsertListings(20 fixture rows) -> itemsInserted=20 on the ScanRun; re-upsert tallies UPDATED/UNCHANGED', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        // typed as the shared port — the engine never sees the Prisma class
        const output: OutputRepository = new PrismaOutputRepository(db.repos.listings, db.repos.runs, run.id);
        expect(fixture).toHaveLength(20);

        await output.upsertListings(fixture);

        let counters = await runCounters(run.id);
        expect(counters.itemsInserted).toBe(20);
        expect(counters.itemsUpdated).toBe(0);
        expect(counters.pricesChanged).toBe(0);
        expect(await db.prisma.listing.count()).toBe(20);

        // second pass: one title changed (UPDATED), one price changed
        // (PRICE_CHANGED), 18 identical (UNCHANGED)
        const again = fixture.map((item, index) => {
            if (index === 0) return { ...item, title: `${item.title} — GÜNCEL` };
            if (index === 1) return { ...item, price: (item.price ?? 0) + 1 };
            return item;
        });
        await output.upsertListings(again);

        counters = await runCounters(run.id);
        expect(counters.itemsInserted).toBe(20); // unchanged — no new listings
        expect(counters.itemsUpdated).toBe(1);
        expect(counters.pricesChanged).toBe(1);
        expect(await db.prisma.listing.count()).toBe(20);

        // cumulative outcome tallies across both batches (UNCHANGED included)
        const adapter = output as PrismaOutputRepository;
        expect(adapter.getOutcomeCounts()).toEqual({ inserted: 20, updated: 1, priceChanged: 1, unchanged: 18 });
        expect(adapter.getErrors()).toEqual([]);
    });

    it('upsertDetails persists seller + images + attributes; finalize() resolves', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        const output: OutputRepository = new PrismaOutputRepository(db.repos.listings, db.repos.runs, run.id);

        const detail = makeListingDetail({ listingId: '3000000001' });
        await output.upsertDetails([detail]);
        await expect(output.finalize()).resolves.toBeUndefined();

        const counters = await runCounters(run.id);
        expect(counters.itemsInserted).toBe(1);

        const listing = await db.prisma.listing.findUnique({
            where: { source_sourceListingId: { source: 'sahibinden.com', sourceListingId: '3000000001' } },
        });
        expect(listing).not.toBeNull();
        const full = await db.repos.listings.getById(listing!.id);
        expect(full!.seller).not.toBeNull();
        expect(full!.seller!.displayName).toBe('Test Emlak Danışmanı');
        expect(full!.images).toHaveLength(3);
        expect(full!.attributes).toHaveLength(3);
        expect(full!.sellerType).toBe('REAL_ESTATE_OFFICE');
    });

    it('a deliberately broken item is isolated — batch continues, error collected', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        const output = new PrismaOutputRepository(db.repos.listings, db.repos.runs, run.id);

        const valid1 = makeCategoryListing({ id: '3000000010' });
        const broken = makeCategoryListing({ id: null }); // no usable identity
        const valid2 = makeCategoryListing({ id: '3000000011' });

        await output.upsertListings([valid1, broken, valid2]);

        // batch continued: both valid items persisted and counted
        expect(await db.prisma.listing.count()).toBe(2);
        const counters = await runCounters(run.id);
        expect(counters.itemsInserted).toBe(2);

        // exactly one collected error, classified DATABASE, sourceListingId null
        const errors = output.getErrors();
        expect(errors).toHaveLength(1);
        expect(errors[0]!.code).toBe('DATABASE');
        expect(errors[0]!.sourceListingId).toBeNull();
        expect(errors[0]!.message).toContain('no usable id');

        // same isolation on the detail path
        const before = errors.length;
        await output.upsertDetails([makeListingDetail({ listingId: null }), makeListingDetail({ listingId: '3000000012' })]);
        expect(output.getErrors()).toHaveLength(before + 1);
        expect(output.getErrors()[before]!.code).toBe('DATABASE');
        expect(await db.prisma.listing.count()).toBe(3);
    });
});
