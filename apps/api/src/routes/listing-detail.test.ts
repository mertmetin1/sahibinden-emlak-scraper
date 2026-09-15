/**
 * Listing detail + price-history tests — full record shape (seller, ordered
 * images/attributes, price history desc, seen history, run links) and 404s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, type TestAppContext } from '../testing/test-app.js';
import { makeDetail, seedDetailListing, seedRun, seedScan, shortId } from '../testing/seed.js';

describe('listing detail', () => {
    let ctx: TestAppContext;
    let listingId: string;
    let runId: string;
    const sourceId = `dt-${shortId()}`;

    beforeAll(async () => {
        ctx = await buildTestContext('listing-detail');
        const scanId = await seedScan(ctx);
        runId = await seedRun(ctx, scanId);

        listingId = await seedDetailListing(ctx, runId, sourceId, {
            title: 'Detail Villa',
            price: 2_500_000,
            sellerType: 'REAL_ESTATE_OFFICE',
            officeName: 'Detail Ofis',
            sellerDisplayName: 'Detail Agent',
            // Deliberately reversed positions — the API must order by position.
            images: [
                { url: 'https://img.example.com/second.jpg', position: 1, isPrimary: false },
                { url: 'https://img.example.com/first.jpg', position: 0, isPrimary: true },
            ],
            attributesRaw: { 'Oda Sayısı': '3+1', 'Bina Yaşı': '5', 'Isıtma': 'Kombi' },
        });
        // Second observation: price change + another seen-history entry.
        await ctx.app.db.repos.listings.upsertDetailListing(
            makeDetail(sourceId, {
                title: 'Detail Villa',
                price: 2_250_000,
                sellerType: 'REAL_ESTATE_OFFICE',
                officeName: 'Detail Ofis',
                sellerDisplayName: 'Detail Agent',
                images: [
                    { url: 'https://img.example.com/second.jpg', position: 1, isPrimary: false },
                    { url: 'https://img.example.com/first.jpg', position: 0, isPrimary: true },
                ],
                attributesRaw: { 'Oda Sayısı': '3+1', 'Bina Yaşı': '5', 'Isıtma': 'Kombi' },
            }),
            runId,
        );
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    it('returns the full record shape', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: `/api/listings/${listingId}` });
        expect(res.statusCode).toBe(200);
        const body = res.json();

        // Snapshot fields
        expect(body.id).toBe(listingId);
        expect(body.sourceListingId).toBe(sourceId);
        expect(body.title).toBe('Detail Villa');
        expect(body.price).toBe(2_250_000);
        expect(body.status).toBe('ACTIVE');
        expect(body.canonicalUrl).toBe(`https://www.sahibinden.com/ilan/${sourceId}`);
        expect(body.sellerType).toBe('REAL_ESTATE_OFFICE');

        // Seller
        expect(body.seller.displayName).toBe('Detail Agent');
        expect(body.seller.officeName).toBe('Detail Ofis');
        expect(body.seller.type).toBe('REAL_ESTATE_OFFICE');

        // Images ordered by position (seeded reversed).
        expect(body.images.map((img: { url: string }) => img.url)).toEqual([
            'https://img.example.com/first.jpg',
            'https://img.example.com/second.jpg',
        ]);
        expect(body.images[0].isPrimary).toBe(true);

        // Attributes key-ordered (Bina Yaşı < Isıtma < Oda Sayısı by codepoint).
        expect(body.attributes.map((attr: { key: string }) => attr.key)).toEqual(['Bina Yaşı', 'Isıtma', 'Oda Sayısı']);
        expect(body.attributes[0].value).toBe('5');

        // Price history: newest first, one row per real change.
        expect(body.priceHistory).toHaveLength(1);
        expect(body.priceHistory[0].price).toBe(2_250_000);
        expect(body.priceHistory[0].runId).toBe(runId);

        // Seen history: one entry per observation (2 upserts).
        expect(body.seenHistory).toHaveLength(2);
        expect(body.seenHistory[0].runId).toBe(runId);

        // Run links → run summary.
        expect(body.runLinks).toHaveLength(1);
        expect(body.runLinks[0].run.id).toBe(runId);
        expect(body.runLinks[0].run.status).toBe('QUEUED');
        expect(body.runLinks[0].outcome).toBe('PRICE_CHANGED'); // second upsert wins (upsert on runId+listingId)
    });

    it('returns price history ascending with an exact summary', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: `/api/listings/${listingId}/price-history` });
        expect(res.statusCode).toBe(200);
        const body = res.json();

        expect(body.points).toHaveLength(1);
        expect(body.points[0]).toMatchObject({ price: 2_250_000, currency: 'TL', runId });
        expect(body.points[0].changedAt).toBeDefined();
        expect(body.summary).toEqual({
            firstPrice: 2_250_000,
            latestPrice: 2_250_000,
            totalChangePercent: null, // single point — no computable delta
            changeCount: 1,
        });
    });

    it('computes totalChangePercent across two changes', async () => {
        // A second listing with two price changes: 1_000_000 → 900_000 → 810_000.
        const multiSourceId = `dt-${shortId()}`;
        const multiId = await seedDetailListing(ctx, runId, multiSourceId, { price: 1_000_000 });
        await ctx.app.db.repos.listings.upsertDetailListing(makeDetail(multiSourceId, { price: 900_000 }), runId);
        await ctx.app.db.repos.listings.upsertDetailListing(makeDetail(multiSourceId, { price: 810_000 }), runId);

        const res = await ctx.app.inject({ method: 'GET', url: `/api/listings/${multiId}/price-history` });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.points.map((p: { price: number }) => p.price)).toEqual([900_000, 810_000]);
        expect(body.summary).toEqual({
            firstPrice: 900_000,
            latestPrice: 810_000,
            totalChangePercent: -10,
            changeCount: 2,
        });
    });

    it('404s with the uniform error shape for unknown listings', async () => {
        const detail = await ctx.app.inject({ method: 'GET', url: '/api/listings/does-not-exist' });
        expect(detail.statusCode).toBe(404);
        expect(detail.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'listing does-not-exist not found' } });

        const history = await ctx.app.inject({ method: 'GET', url: '/api/listings/does-not-exist/price-history' });
        expect(history.statusCode).toBe(404);
        expect(history.json().error.code).toBe('NOT_FOUND');
    });
});
