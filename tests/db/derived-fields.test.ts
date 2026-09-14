/**
 * listWithDerived — derived price fields (priceChanged, latestPriceChangePercent),
 * filters (province/district, sellerType, price range, search, priceChanged),
 * pagination, and price sorting.
 *
 * Price-history semantics under test (outcome.ts + prisma-listing-repository):
 * history rows are written ONLY on a real price change and store the NEW price,
 * so percent needs >= 2 change rows: prices [90,100,125] produce rows [100,125]
 * -> (125-100)/100 = +25.00%.
 *
 * Dedicated database: sahibindenbot_test_derived.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient, ListingListRow } from '../../packages/database/src/index.js';
import {
    createRun,
    createScan,
    makeCategoryListing,
    makeListingDetail,
    openTestDatabase,
    truncateAllTables,
} from './db-test-kit.js';

const DB_NAME = 'sahibindenbot_test_derived';

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

/** Observes `id` at each price in sequence, one run per observation. */
async function seedPriceHistory(scanId: string, id: string, prices: number[]): Promise<void> {
    for (const price of prices) {
        // eslint-disable-next-line no-await-in-loop -- sequential observations are the scenario
        const run = await createRun(db, scanId);
        // eslint-disable-next-line no-await-in-loop
        await db.repos.listings.upsertCategoryListing(
            makeCategoryListing({ id, price, price_raw: `${price} TL` }),
            run.id,
        );
    }
}

function rowBySourceId(result: { rows: ListingListRow[] }, sourceListingId: string): ListingListRow {
    const row = result.rows.find((r) => r.sourceListingId === sourceListingId);
    expect(row, `row for ${sourceListingId} must be present`).toBeDefined();
    return row!;
}

describe('listWithDerived — derived price fields', () => {
    it('computes priceChanged and latestPriceChangePercent from change-only history', async () => {
        const scan = await createScan(db);
        await seedPriceHistory(scan.id, 'D-UP', [90_000, 100_000, 125_000]); // rows 100k,125k -> +25%
        await seedPriceHistory(scan.id, 'D-DOWN', [180_000, 200_000, 150_000]); // rows 200k,150k -> -25%
        await seedPriceHistory(scan.id, 'D-SINGLE', [300_000]); // no rows
        await seedPriceHistory(scan.id, 'D-ONE-CHANGE', [400_000, 450_000]); // one row -> percent null

        const result = await db.repos.listings.listWithDerived({}, 1, 10);
        expect(result.total).toBe(4);

        const up = rowBySourceId(result, 'D-UP');
        expect(up.priceChanged).toBe(true);
        expect(up.latestPriceChangePercent).toBe(25);
        expect(up.price).toBe(125_000);

        const down = rowBySourceId(result, 'D-DOWN');
        expect(down.priceChanged).toBe(true);
        expect(down.latestPriceChangePercent).toBe(-25);
        expect(down.price).toBe(150_000);

        const single = rowBySourceId(result, 'D-SINGLE');
        expect(single.priceChanged).toBe(false);
        expect(single.latestPriceChangePercent).toBeNull();

        const oneChange = rowBySourceId(result, 'D-ONE-CHANGE');
        expect(oneChange.priceChanged).toBe(true);
        expect(oneChange.latestPriceChangePercent).toBeNull();
    });
});

describe('listWithDerived — filters', () => {
    beforeEach(async () => {
        const scan = await createScan(db);
        const run1 = await createRun(db, scan.id);
        const run2 = await createRun(db, scan.id);

        // NOTE: descriptions are explicit per fixture — the search filter also
        // covers description (interfaces.ts), so the shared factory default
        // ('Deniz manzaralı...') would make every row match a 'deniz' search.
        await db.repos.listings.upsertDetailListing(
            makeListingDetail({
                listingId: 'F1',
                title: 'Deniz Manzaralı Lüks Daire',
                description: 'Deniz manzaralı, site içerisinde.',
                price: 1_000_000,
                province: 'İstanbul',
                district: 'Beylikdüzü',
                sellerType: 'REAL_ESTATE_OFFICE',
                sellerTypeEvidence: 'Emlak Ofisinden',
            }),
            run1.id,
        );
        await db.repos.listings.upsertDetailListing(
            makeListingDetail({
                listingId: 'F2',
                title: 'Bahçeli Müstakil Ev',
                description: 'Geniş bahçeli, müstakil ev.',
                price: 2_000_000,
                province: 'İstanbul',
                district: 'Kadıköy',
                sellerType: 'OWNER',
                sellerTypeEvidence: 'Sahibinden',
            }),
            run1.id,
        );
        // price change on F2 -> priceChanged=true for the filter test
        await db.repos.listings.upsertDetailListing(
            makeListingDetail({
                listingId: 'F2',
                title: 'Bahçeli Müstakil Ev',
                description: 'Geniş bahçeli, müstakil ev.',
                price: 1_800_000,
                province: 'İstanbul',
                district: 'Kadıköy',
                sellerType: 'OWNER',
                sellerTypeEvidence: 'Sahibinden',
            }),
            run2.id,
        );
        await db.repos.listings.upsertDetailListing(
            makeListingDetail({
                listingId: 'F3',
                title: 'Başkentte Geniş Daire',
                description: 'Başkentte geniş, ferah daire.',
                price: 3_000_000,
                province: 'Ankara',
                district: 'Çankaya',
                sellerType: 'OWNER',
                sellerTypeEvidence: 'Sahibinden',
            }),
            run1.id,
        );
    });

    it('filters by province (case-insensitive)', async () => {
        const result = await db.repos.listings.listWithDerived({ province: 'istanbul' }, 1, 10);
        expect(result.total).toBe(2);
        expect(result.rows.map((r) => r.sourceListingId).sort()).toEqual(['F1', 'F2']);
    });

    it('filters by province + district (case-insensitive)', async () => {
        const result = await db.repos.listings.listWithDerived({ province: 'İstanbul', district: 'kadıköy' }, 1, 10);
        expect(result.total).toBe(1);
        expect(result.rows[0]!.sourceListingId).toBe('F2');
    });

    it('filters by sellerType (denormalized mirror)', async () => {
        const owners = await db.repos.listings.listWithDerived({ sellerType: 'OWNER' }, 1, 10);
        expect(owners.total).toBe(2);
        expect(owners.rows.map((r) => r.sourceListingId).sort()).toEqual(['F2', 'F3']);

        const offices = await db.repos.listings.listWithDerived({ sellerType: 'REAL_ESTATE_OFFICE' }, 1, 10);
        expect(offices.total).toBe(1);
        expect(offices.rows[0]!.sourceListingId).toBe('F1');
    });

    it('filters by price range on the CURRENT price', async () => {
        const result = await db.repos.listings.listWithDerived({ priceMin: 1_500_000, priceMax: 2_500_000 }, 1, 10);
        expect(result.total).toBe(1);
        expect(result.rows[0]!.sourceListingId).toBe('F2');
        expect(result.rows[0]!.price).toBe(1_800_000);
    });

    it('searches by title fragment (case-insensitive)', async () => {
        const result = await db.repos.listings.listWithDerived({ search: 'deniz' }, 1, 10);
        expect(result.total).toBe(1);
        expect(result.rows[0]!.sourceListingId).toBe('F1');
    });

    it('filters priceChanged=true — only listings with at least one history row', async () => {
        const result = await db.repos.listings.listWithDerived({ priceChanged: true }, 1, 10);
        expect(result.total).toBe(1);
        expect(result.rows[0]!.sourceListingId).toBe('F2');
        expect(result.rows[0]!.priceChanged).toBe(true);
    });
});

describe('listWithDerived — pagination & sorting', () => {
    beforeEach(async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        const items = Array.from({ length: 25 }, (_, i) =>
            makeCategoryListing({
                id: `P-${String(i + 1).padStart(3, '0')}`,
                price: (i + 1) * 100_000,
                price_raw: `${(i + 1) * 100_000} TL`,
            }),
        );
        const batch = await db.repos.listings.upsertCategoryListings(items, run.id);
        expect(batch.errors).toEqual([]);
        expect(batch.counts.inserted).toBe(25);
    });

    it('pageSize 10 over 25 rows -> 3 pages with correct sizes and totals', async () => {
        const page1 = await db.repos.listings.listWithDerived({}, 1, 10);
        expect(page1.rows).toHaveLength(10);
        expect(page1.total).toBe(25);
        expect(page1.page).toBe(1);
        expect(page1.pageSize).toBe(10);

        const page2 = await db.repos.listings.listWithDerived({}, 2, 10);
        expect(page2.rows).toHaveLength(10);
        expect(page2.total).toBe(25);

        const page3 = await db.repos.listings.listWithDerived({}, 3, 10);
        expect(page3.rows).toHaveLength(5);
        expect(page3.total).toBe(25);

        const page4 = await db.repos.listings.listWithDerived({}, 4, 10);
        expect(page4.rows).toHaveLength(0);
        expect(page4.total).toBe(25);

        // no overlap between pages
        const ids = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
        expect(new Set(ids).size).toBe(25);
    });

    it('sorts by price ascending and descending', async () => {
        const asc = await db.repos.listings.listWithDerived({}, 1, 10, { field: 'price', direction: 'asc' });
        expect(asc.rows.map((r) => r.price)).toEqual([
            100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000,
        ]);

        const desc = await db.repos.listings.listWithDerived({}, 1, 10, { field: 'price', direction: 'desc' });
        expect(desc.rows.map((r) => r.price)).toEqual([
            2_500_000, 2_400_000, 2_300_000, 2_200_000, 2_100_000, 2_000_000, 1_900_000, 1_800_000, 1_700_000, 1_600_000,
        ]);
    });
});
