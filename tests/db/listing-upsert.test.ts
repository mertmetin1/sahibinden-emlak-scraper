/**
 * CORE ACCEPTANCE — Listing upsert identity, outcome classification, price
 * history, detail upsert (seller/images/attributes), and removal semantics.
 *
 * Runs against a dedicated database (sahibindenbot_test_listing) recreated in
 * beforeAll; tables are truncated before each test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CrawlError } from '../../packages/shared/src/index.js';
import { DEFAULT_SOURCE } from '../../packages/database/src/index.js';
import type { DatabaseClient, ListingOutcome, RunRecord } from '../../packages/database/src/index.js';
import {
    createRun,
    createScan,
    makeCategoryListing,
    makeListingDetail,
    openTestDatabase,
    truncateAllTables,
} from './db-test-kit.js';

const DB_NAME = 'sahibindenbot_test_listing';

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

/** Raw listing row lookup by canonical identity. */
async function findListing(sourceListingId: string) {
    return db.prisma.listing.findUnique({
        where: { source_sourceListingId: { source: DEFAULT_SOURCE, sourceListingId } },
    });
}

describe('upsertCategoryListing — identity & observation journal', () => {
    it('upserts the same CategoryListing 20 times into exactly ONE Listing row', async () => {
        const scan = await createScan(db);
        const runs: RunRecord[] = [];
        for (let i = 0; i < 20; i += 1) {
            runs.push(await createRun(db, scan.id));
        }
        const item = makeCategoryListing({ id: '1334491628' });

        const outcomes: ListingOutcome[] = [];
        const lastSeenSequence: number[] = [];
        let firstSeenAt: Date | null = null;
        for (const run of runs) {
            // eslint-disable-next-line no-await-in-loop -- sequential observations are the scenario under test
            const result = await db.repos.listings.upsertCategoryListing(item, run.id);
            outcomes.push(result.outcome);
            // eslint-disable-next-line no-await-in-loop
            const row = await findListing('1334491628');
            expect(row).not.toBeNull();
            if (firstSeenAt === null) firstSeenAt = row!.firstSeenAt;
            lastSeenSequence.push(row!.lastSeenAt.getTime());
        }

        // exactly ONE Listing row for the canonical identity
        const count = await db.prisma.listing.count({
            where: { source: DEFAULT_SOURCE, sourceListingId: '1334491628' },
        });
        expect(count).toBe(1);

        // outcomes: INSERTED first, UNCHANGED for all 19 re-observations
        expect(outcomes[0]).toBe('INSERTED');
        expect(outcomes.slice(1)).toEqual(Array<ListingOutcome>(19).fill('UNCHANGED'));

        const listing = (await findListing('1334491628'))!;

        // firstSeenAt never moves; firstSeenRunId is the FIRST run
        expect(listing.firstSeenAt.getTime()).toBe(firstSeenAt!.getTime());
        expect(listing.firstSeenRunId).toBe(runs[0]!.id);
        // lastSeenRunId is the LAST run
        expect(listing.lastSeenRunId).toBe(runs[19]!.id);

        // lastSeenAt is monotone non-decreasing and strictly increases at least
        // once across 20 transactions (80+ DB round trips — cannot tie at ms precision)
        for (let i = 1; i < lastSeenSequence.length; i += 1) {
            expect(lastSeenSequence[i]!).toBeGreaterThanOrEqual(lastSeenSequence[i - 1]!);
        }
        expect(listing.lastSeenAt.getTime()).toBeGreaterThan(listing.firstSeenAt.getTime());

        // 20 append-only sighting rows, one per observation
        const seenCount = await db.prisma.listingSeenHistory.count({ where: { listingId: listing.id } });
        expect(seenCount).toBe(20);
        const seenRunIds = await db.prisma.listingSeenHistory.findMany({
            where: { listingId: listing.id },
            select: { runId: true },
        });
        expect(new Set(seenRunIds.map((r) => r.runId))).toEqual(new Set(runs.map((r) => r.id)));

        // 20 unique (runId, listingId) run-link rows, all journaled with the outcome
        const runLinks = await db.prisma.scanRunListing.findMany({ where: { listingId: listing.id } });
        expect(runLinks).toHaveLength(20);
        expect(new Set(runLinks.map((l) => l.runId))).toEqual(new Set(runs.map((r) => r.id)));
        expect(runLinks.find((l) => l.runId === runs[0]!.id)?.outcome).toBe('INSERTED');
        for (const link of runLinks.filter((l) => l.runId !== runs[0]!.id)) {
            expect(link.outcome).toBe('UNCHANGED');
        }

        // no price change ever happened -> no price history; cover image upserted once
        expect(await db.prisma.listingPriceHistory.count({ where: { listingId: listing.id } })).toBe(0);
        const images = await db.prisma.listingImage.findMany({ where: { listingId: listing.id } });
        expect(images).toHaveLength(1);
        expect(images[0]!.isPrimary).toBe(true);
        expect(images[0]!.position).toBe(0);
    }, 60_000);
});

describe('upsertCategoryListing — price change semantics (outcome.ts matrix)', () => {
    it('value -> different value: PRICE_CHANGED, exactly ONE history row, Listing.price updated', async () => {
        const scan = await createScan(db);
        const run1 = await createRun(db, scan.id);
        const run2 = await createRun(db, scan.id);
        const run3 = await createRun(db, scan.id);

        const base = makeCategoryListing({ id: '2000000001', price: 1_000_000, price_raw: '1.000.000 TL' });
        const r1 = await db.repos.listings.upsertCategoryListing(base, run1.id);
        expect(r1.outcome).toBe('INSERTED');

        const changed = makeCategoryListing({ id: '2000000001', price: 1_250_000, price_raw: '1.250.000 TL' });
        const r2 = await db.repos.listings.upsertCategoryListing(changed, run2.id);
        expect(r2.outcome).toBe('PRICE_CHANGED');

        const listing = (await findListing('2000000001'))!;
        expect(listing.price).toBe(1_250_000);

        const history = await db.prisma.listingPriceHistory.findMany({ where: { listingId: listing.id } });
        expect(history).toHaveLength(1);
        expect(history[0]!.price).toBe(1_250_000);
        expect(history[0]!.currency).toBe('TL');
        expect(history[0]!.runId).toBe(run2.id);

        // same price again -> UNCHANGED, no new history row
        const r3 = await db.repos.listings.upsertCategoryListing(changed, run3.id);
        expect(r3.outcome).toBe('UNCHANGED');
        expect(await db.prisma.listingPriceHistory.count({ where: { listingId: listing.id } })).toBe(1);
    });

    it('null -> value: first price observation is UPDATED (no baseline -> no history row)', async () => {
        const scan = await createScan(db);
        const run1 = await createRun(db, scan.id);
        const run2 = await createRun(db, scan.id);

        const noPrice = makeCategoryListing({ id: '2000000002', price: null, price_raw: null });
        const r1 = await db.repos.listings.upsertCategoryListing(noPrice, run1.id);
        expect(r1.outcome).toBe('INSERTED');
        expect((await findListing('2000000002'))!.price).toBeNull();

        const withPrice = makeCategoryListing({ id: '2000000002', price: 500_000, price_raw: '500.000 TL' });
        const r2 = await db.repos.listings.upsertCategoryListing(withPrice, run2.id);
        // decideOutcome: isPriceChange requires BOTH sides non-null -> not PRICE_CHANGED
        expect(r2.outcome).toBe('UPDATED');

        const listing = (await findListing('2000000002'))!;
        expect(listing.price).toBe(500_000);
        expect(await db.prisma.listingPriceHistory.count({ where: { listingId: listing.id } })).toBe(0);
    });

    it('value -> null (category path): price is never erased, outcome UNCHANGED, no history', async () => {
        const scan = await createScan(db);
        const run1 = await createRun(db, scan.id);
        const run2 = await createRun(db, scan.id);

        const withPrice = makeCategoryListing({ id: '2000000003', price: 750_000, price_raw: '750.000 TL' });
        await db.repos.listings.upsertCategoryListing(withPrice, run1.id);

        const noPrice = makeCategoryListing({ id: '2000000003', price: null, price_raw: null });
        const r2 = await db.repos.listings.upsertCategoryListing(noPrice, run2.id);
        // Category rows refresh only non-null fields: a sparse row must not erase data.
        expect(r2.outcome).toBe('UNCHANGED');

        const listing = (await findListing('2000000003'))!;
        expect(listing.price).toBe(750_000);
        expect(await db.prisma.listingPriceHistory.count({ where: { listingId: listing.id } })).toBe(0);
    });

    it('value -> null (detail path): detail is authoritative — price IS erased, outcome UPDATED', async () => {
        const scan = await createScan(db);
        const run1 = await createRun(db, scan.id);
        const run2 = await createRun(db, scan.id);

        await db.repos.listings.upsertDetailListing(makeListingDetail({ listingId: '2000000004', price: 750_000 }), run1.id);
        expect((await findListing('2000000004'))!.price).toBe(750_000);

        const r2 = await db.repos.listings.upsertDetailListing(
            makeListingDetail({ listingId: '2000000004', price: null, priceRaw: null }),
            run2.id,
        );
        expect(r2.outcome).toBe('UPDATED');
        expect((await findListing('2000000004'))!.price).toBeNull();
        // history rows require an Int price — value->null never writes one
        const listing = (await findListing('2000000004'))!;
        expect(await db.prisma.listingPriceHistory.count({ where: { listingId: listing.id } })).toBe(0);
    });
});

describe('upsertDetailListing — seller, images, attributes', () => {
    it('creates seller + images + attributes; second upsert updates in place without duplicates', async () => {
        const scan = await createScan(db);
        const run1 = await createRun(db, scan.id);
        const run2 = await createRun(db, scan.id);

        const detail = makeListingDetail({ listingId: '2000000010' });
        const r1 = await db.repos.listings.upsertDetailListing(detail, run1.id);
        expect(r1.outcome).toBe('INSERTED');

        const full = await db.repos.listings.getById(r1.listingId);
        expect(full).not.toBeNull();

        // seller created and linked; denormalized sellerType mirrored onto the listing
        expect(full!.seller).not.toBeNull();
        expect(full!.seller!.displayName).toBe('Test Emlak Danışmanı');
        expect(full!.seller!.officeName).toBe('Test Emlak Ofisi');
        expect(full!.seller!.profileUrl).toBe('https://www.sahibinden.com/emlak-ofisi/test-emlak-9001');
        expect(full!.seller!.type).toBe('REAL_ESTATE_OFFICE');
        expect(full!.seller!.typeEvidence).toBe('Emlak Ofisinden');
        expect(full!.sellerId).toBe(full!.seller!.id);
        expect(full!.sellerType).toBe('REAL_ESTATE_OFFICE');

        // images with positions + exactly one primary
        expect(full!.images).toHaveLength(3);
        expect(full!.images.map((i) => i.position)).toEqual([0, 1, 2]);
        expect(full!.images.filter((i) => i.isPrimary)).toHaveLength(1);
        expect(full!.images[0]!.isPrimary).toBe(true);

        // attributes from attributesRaw
        expect(full!.attributes).toHaveLength(3);
        const attrMap = new Map(full!.attributes.map((a) => [a.key, a.value]));
        expect(attrMap.get('Oda Sayısı')).toBe('2+1');
        expect(attrMap.get('Bina Yaşı')).toBe('5');

        // second detail upsert: changed attribute, reordered image positions, same seller
        const detail2 = makeListingDetail({
            listingId: '2000000010',
            attributesRaw: { 'Oda Sayısı': '3+1', 'Bina Yaşı': '5', 'Isıtma': 'Kombi (Doğalgaz)' },
            images: [
                { url: 'https://i0.shbdn.com/photos/90/00/00/9000000001x01.jpg', position: 1, isPrimary: false },
                { url: 'https://i0.shbdn.com/photos/90/00/00/9000000001x02.jpg', position: 0, isPrimary: true },
                { url: 'https://i0.shbdn.com/photos/90/00/00/9000000001x03.jpg', position: 2, isPrimary: false },
            ],
        });
        const r2 = await db.repos.listings.upsertDetailListing(detail2, run2.id);
        // PINNED SEMANTICS (reported to API/worker agents): decideOutcome compares
        // only scalar Listing columns (ListingMutableData, prisma-listing-repository.ts).
        // Attribute/image/seller RELATION refreshes alone do NOT turn the outcome
        // UPDATED — the run journal records UNCHANGED even though the attribute
        // value and image positions below ARE updated in place.
        expect(r2.outcome).toBe('UNCHANGED');
        expect(r2.listingId).toBe(r1.listingId);

        // attribute value updated, NO duplicate key row
        const attributes = await db.prisma.listingAttribute.findMany({ where: { listingId: r1.listingId } });
        expect(attributes).toHaveLength(3);
        expect(attributes.find((a) => a.key === 'Oda Sayısı')?.value).toBe('3+1');

        // seller re-resolved by (source, profileUrl) — not duplicated
        expect(await db.prisma.seller.count()).toBe(1);

        // images upserted by (listingId, url) — positions/isPrimary refreshed, still 3 rows
        const images = await db.prisma.listingImage.findMany({
            where: { listingId: r1.listingId },
            orderBy: { url: 'asc' },
        });
        expect(images).toHaveLength(3);
        const primary = images.filter((i) => i.isPrimary);
        expect(primary).toHaveLength(1);
        expect(primary[0]!.url).toBe('https://i0.shbdn.com/photos/90/00/00/9000000001x02.jpg');
        expect(images.find((i) => i.url.endsWith('x02.jpg'))?.position).toBe(0);
        expect(images.find((i) => i.url.endsWith('x01.jpg'))?.position).toBe(1);
    });

    it('seller without profileUrl maps to the sentinel row (profileUrl null at the boundary)', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);

        const detail = makeListingDetail({
            listingId: '2000000011',
            sellerProfileUrl: null,
            sellerDisplayName: 'Profilsiz Satıcı',
        });
        const r = await db.repos.listings.upsertDetailListing(detail, run.id);
        const full = await db.repos.listings.getById(r.listingId);
        expect(full!.seller).not.toBeNull();
        // DB stores '' sentinel; the record mapper exposes null
        expect(full!.seller!.profileUrl).toBeNull();
        expect(full!.seller!.displayName).toBe('Profilsiz Satıcı');
    });
});

describe('removal semantics', () => {
    it('unavailable detail on an existing listing -> REMOVED immediately, outcome UPDATED', async () => {
        const scan = await createScan(db);
        const run1 = await createRun(db, scan.id);
        const run2 = await createRun(db, scan.id);

        await db.repos.listings.upsertCategoryListing(makeCategoryListing({ id: '2000000020' }), run1.id);
        expect((await findListing('2000000020'))!.status).toBe('ACTIVE');

        const gone = makeListingDetail({ listingId: '2000000020', unavailable: true });
        const r = await db.repos.listings.upsertDetailListing(gone, run2.id);
        expect(r.outcome).toBe('UPDATED');
        expect((await findListing('2000000020'))!.status).toBe('REMOVED');

        // observation is still journaled for the removal sighting
        const listing = (await findListing('2000000020'))!;
        expect(await db.prisma.listingSeenHistory.count({ where: { listingId: listing.id } })).toBe(2);
    });

    it('unavailable detail as FIRST sighting -> minimal REMOVED row, outcome INSERTED (defensive path)', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);

        const gone = makeListingDetail({ listingId: '2000000021', unavailable: true });
        const r = await db.repos.listings.upsertDetailListing(gone, run.id);
        expect(r.outcome).toBe('INSERTED');
        const listing = (await findListing('2000000021'))!;
        expect(listing.status).toBe('REMOVED');
    });

    it('markRemoved: ACTIVE -> REMOVED returns true; already REMOVED returns false', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);

        const r = await db.repos.listings.upsertCategoryListing(makeCategoryListing({ id: '2000000022' }), run.id);
        await expect(db.repos.listings.markRemoved(r.listingId)).resolves.toBe(true);
        expect((await findListing('2000000022'))!.status).toBe('REMOVED');
        await expect(db.repos.listings.markRemoved(r.listingId)).resolves.toBe(false);
    });
});

describe('identity guard', () => {
    it('category listing with null id throws CrawlError(DATABASE)', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        await expect(db.repos.listings.upsertCategoryListing(makeCategoryListing({ id: null }), run.id)).rejects.toThrow(
            CrawlError,
        );
        await expect(
            db.repos.listings.upsertCategoryListing(makeCategoryListing({ id: null }), run.id),
        ).rejects.toMatchObject({ code: 'DATABASE' });
    });

    it('detail with null listingId throws CrawlError(DATABASE)', async () => {
        const scan = await createScan(db);
        const run = await createRun(db, scan.id);
        await expect(
            db.repos.listings.upsertDetailListing(makeListingDetail({ listingId: null }), run.id),
        ).rejects.toMatchObject({ code: 'DATABASE' });
    });
});
