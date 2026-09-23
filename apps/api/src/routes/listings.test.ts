/**
 * Listings list tests — combined DB-level filters, pagination stability,
 * sorting, priceChanged, and validation. Every seed uses a unique province
 * (`TP-<id>`) so concurrent test files never interfere (province filter
 * isolates this file's rows exactly).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, type TestAppContext } from '../testing/test-app.js';
import { makeDetail, seedDetailListing, seedRun, seedScan, shortId } from '../testing/seed.js';

interface ListPayload {
    rows: Array<{ id: string; title: string; price: number | null; [k: string]: unknown }>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

describe('listings', () => {
    let ctx: TestAppContext;
    let province: string;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
        ctx = await buildTestContext('listings');
        province = `TP-${shortId()}`;
        const scanId = await seedScan(ctx);
        const runId = await seedRun(ctx, scanId);

        // Prices chosen so ascending price order is A,B,C,D,E deterministically.
        ids.a = await seedDetailListing(ctx, runId, `l-${shortId()}`, {
            title: 'Alpha Apartment',
            price: 1_000_000,
            province,
            district: 'Merkez',
            sellerType: 'OWNER',
            rooms: '2+1',
            grossAreaM2: 100,
        });
        ids.b = await seedDetailListing(ctx, runId, `l-${shortId()}`, {
            title: 'Beta Residence',
            price: 2_000_000,
            province,
            district: 'Merkez',
            sellerType: 'REAL_ESTATE_OFFICE',
            officeName: 'Beta Ofis',
            rooms: '3+1',
            grossAreaM2: 150,
        });
        ids.c = await seedDetailListing(ctx, runId, `l-${shortId()}`, {
            title: 'Gamma Flat',
            price: 3_000_000,
            province,
            district: 'Çarşı',
            sellerType: 'OWNER',
            rooms: '4+1',
            grossAreaM2: 200,
        });
        ids.d = await seedDetailListing(ctx, runId, `l-${shortId()}`, {
            title: 'Delta Villa',
            price: 4_000_000,
            province,
            district: 'Çarşı',
            sellerType: 'CONSTRUCTION_COMPANY',
            rooms: '5+2',
            grossAreaM2: 300,
        });
        // E: two price changes 5_000_000 → 4_500_000 → 4_050_000, so the derived
        // latestPriceChangePercent has two history rows: (4.05−4.5)/4.5 = −10%.
        const eSourceId = `l-${shortId()}`;
        const eBase = {
            title: 'Epsilon Loft',
            province,
            district: 'Merkez',
            sellerType: 'OWNER',
            sellerDisplayName: 'Epsilon Seller',
            rooms: '1+1',
            grossAreaM2: 80,
        } as const;
        ids.e = await seedDetailListing(ctx, runId, eSourceId, { ...eBase, price: 5_000_000 });
        await ctx.app.db.repos.listings.upsertDetailListing(makeDetail(eSourceId, { ...eBase, price: 4_500_000 }), runId);
        await ctx.app.db.repos.listings.upsertDetailListing(makeDetail(eSourceId, { ...eBase, price: 4_050_000 }), runId);
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    async function list(query: string): Promise<ListPayload> {
        const res = await ctx.app.inject({ method: 'GET', url: `/api/listings?${query}` });
        expect(res.statusCode).toBe(200);
        return res.json() as ListPayload;
    }

    it('composes province+district+sellerType+price range+search at the DB level', async () => {
        const payload = await list(
            `province=${province}&district=Merkez&sellerType=OWNER&priceMin=500000&priceMax=1500000&search=Alpha`,
        );
        expect(payload.total).toBe(1);
        expect(payload.rows.map((row) => row.id)).toEqual([ids.a]);
        expect(payload.totalPages).toBe(1);

        // Same filters but a price window that excludes A → empty.
        const empty = await list(
            `province=${province}&district=Merkez&sellerType=OWNER&priceMin=1500001&priceMax=2000000&search=Alpha`,
        );
        expect(empty.total).toBe(0);
        expect(empty.rows).toEqual([]);
    });

    it('filters by property type/subtype/rooms and exposes those values as facets', async () => {
        const daire = await list(`province=${province}&propertyCategory=Konut&propertySubtype=Daire&rooms=2%2B1`);
        expect(daire.total).toBe(1);
        expect(daire.rows.map((row) => row.id)).toEqual([ids.a]);

        const facetsRes = await ctx.app.inject({
            method: 'GET',
            url: `/api/listings/facets?province=${province}`,
        });
        expect(facetsRes.statusCode).toBe(200);
        const facets = facetsRes.json() as { propertyCategory: string[]; rooms: string[]; listingType: string[] };
        expect(facets.propertyCategory).toContain('Konut');
        expect(facets.rooms).toEqual(expect.arrayContaining(['2+1', '3+1', '4+1']));
        expect(facets.listingType).toContain('SALE');
    });

    it('paginates stably: pages 1/2/3 have no overlaps and totalPages is exact', async () => {
        const pageSize = 2;
        const seen: string[] = [];
        const pages: ListPayload[] = [];
        for (let page = 1; page <= 3; page += 1) {
            const payload = await list(`province=${province}&sort=price&order=asc&page=${page}&pageSize=${pageSize}`);
            pages.push(payload);
            seen.push(...payload.rows.map((row) => row.id));
        }
        // 5 seeded listings, 2 per page → 3 pages (2+2+1).
        for (const payload of pages) {
            expect(payload.total).toBe(5);
            expect(payload.totalPages).toBe(3);
            expect(payload.pageSize).toBe(pageSize);
        }
        expect(pages[0]?.rows).toHaveLength(2);
        expect(pages[1]?.rows).toHaveLength(2);
        expect(pages[2]?.rows).toHaveLength(1);
        expect(new Set(seen).size).toBe(5); // no overlaps
        // Ascending price order: A(1M), B(2M), C(3M), D(4M), E(4.5M after change).
        expect(seen).toEqual([ids.a, ids.b, ids.c, ids.d, ids.e]);
    });

    it('sorts by price desc and by title asc', async () => {
        // Desc: E(4.5M), D(4M), C(3M), B(2M), A(1M).
        const byPriceDesc = await list(`province=${province}&sort=price&order=desc&pageSize=10`);
        expect(byPriceDesc.rows.map((row) => row.id)).toEqual([ids.e, ids.d, ids.c, ids.b, ids.a]);

        const byTitle = await list(`province=${province}&sort=title&order=asc&pageSize=10`);
        expect(byTitle.rows.map((row) => row.title)).toEqual([
            'Alpha Apartment',
            'Beta Residence',
            'Delta Villa',
            'Epsilon Loft',
            'Gamma Flat',
        ]);
    });

    it('filters priceChanged=true (only listings with a price-history row)', async () => {
        const payload = await list(`province=${province}&priceChanged=true`);
        expect(payload.total).toBe(1);
        expect(payload.rows[0]?.id).toBe(ids.e);
        expect(payload.rows[0]?.priceChanged).toBe(true);
        expect(payload.rows[0]?.latestPriceChangePercent).toBe(-10);
    });

    it('filters by status and by seller-name search', async () => {
        await ctx.app.db.repos.listings.markRemoved(ids.d!);
        const removed = await list(`province=${province}&status=REMOVED`);
        expect(removed.rows.map((row) => row.id)).toEqual([ids.d]);
        const active = await list(`province=${province}&status=ACTIVE`);
        expect(active.total).toBe(4);

        const bySeller = await list(`province=${province}&search=epsilon seller`);
        expect(bySeller.rows.map((row) => row.id)).toEqual([ids.e]);
    });

    it('rejects a non-whitelisted sort field with 400 VALIDATION_ERROR', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: `/api/listings?province=${province}&sort=banana` });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects pageSize above the cap and bad booleans', async () => {
        const tooBig = await ctx.app.inject({ method: 'GET', url: '/api/listings?pageSize=101' });
        expect(tooBig.statusCode).toBe(400);
        const badBool = await ctx.app.inject({ method: 'GET', url: '/api/listings?priceChanged=yes' });
        expect(badBool.statusCode).toBe(400);
    });

    it('POST /api/listings/bulk-delete rejects an empty ids list', async () => {
        const res = await ctx.app.inject({
            method: 'POST',
            url: '/api/listings/bulk-delete',
            payload: { ids: [] },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('POST /api/listings/bulk-delete hard-deletes matching ids and skips unknowns', async () => {
        const doomed = ids.a;
        const res = await ctx.app.inject({
            method: 'POST',
            url: '/api/listings/bulk-delete',
            payload: { ids: [doomed, 'does-not-exist'] },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ deleted: 1 });

        const remaining = await list(`province=${province}`);
        expect(remaining.rows.map((row) => row.id)).not.toContain(doomed);
        expect(remaining.total).toBe(4);
    });
});
