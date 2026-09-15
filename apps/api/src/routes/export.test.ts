/**
 * CSV export tests — BOM, exact headers, filter-matched row counts, RFC 4180
 * escaping, and the export.maxRows cap (wired through PATCH /api/settings).
 * Unique province per run isolates the file's rows from concurrent files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, type TestAppContext } from '../testing/test-app.js';
import { seedDetailListing, seedRun, seedScan, shortId } from '../testing/seed.js';

const EXPECTED_HEADER =
    'id,sourceListingId,title,price,currency,pricePerSquareMeter,rooms,grossAreaM2,netAreaM2,' +
    'province,district,neighborhood,sellerType,sellerName,listingType,propertyCategory,status,firstSeenAt,lastSeenAt,url';

describe('listings CSV export', () => {
    let ctx: TestAppContext;
    let province: string;
    const sourceIds: string[] = [];

    beforeAll(async () => {
        ctx = await buildTestContext('export');
        province = `TE-${shortId()}`;
        const scanId = await seedScan(ctx);
        const runId = await seedRun(ctx, scanId);

        // One title exercises every CSV escape trigger: comma, quote, newline.
        const special = `e-${shortId()}`;
        sourceIds.push(special);
        await seedDetailListing(ctx, runId, special, {
            title: 'Comma, "Quoted"\nLine',
            price: 1_250_000,
            province,
            sellerType: 'OWNER',
        });
        const plain = `e-${shortId()}`;
        sourceIds.push(plain);
        await seedDetailListing(ctx, runId, plain, { title: 'Plain Title', price: 750_000, province, sellerType: 'OWNER' });
        const office = `e-${shortId()}`;
        sourceIds.push(office);
        await seedDetailListing(ctx, runId, office, {
            title: 'Office Listing',
            price: 3_500_000,
            province,
            sellerType: 'REAL_ESTATE_OFFICE',
            sellerDisplayName: null,
            officeName: 'Export Ofis',
        });
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    async function exportCsv(query: string): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
        const res = await ctx.app.inject({ method: 'GET', url: `/api/listings/export.csv?${query}` });
        return { statusCode: res.statusCode, headers: res.headers, body: res.body };
    }

    it('streams CSV with BOM, exact headers, and one row per filtered listing', async () => {
        const { statusCode, headers, body } = await exportCsv(`province=${province}`);
        expect(statusCode).toBe(200);
        expect(headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(String(headers['content-disposition'])).toMatch(/^attachment; filename="listings-export-\d{4}-\d{2}-\d{2}\.csv"$/);

        // UTF-8 BOM first (Excel tr-TR), then the exact header line.
        expect(body.charCodeAt(0)).toBe(0xfeff);
        expect(body.slice(1, body.indexOf('\r\n'))).toBe(EXPECTED_HEADER);

        // One data row per filtered listing (the escaped title contains a raw
        // newline inside quotes, so count rows by listing id, not line count).
        for (const sourceId of sourceIds) {
            expect(body).toContain(sourceId);
        }
        expect(body).not.toContain('EXPORT CAPPED');

        // sellerName falls back to officeName when displayName is null.
        expect(body).toContain('Export Ofis');
    });

    it('escapes comma, quote and newline per RFC 4180', async () => {
        const { body } = await exportCsv(`province=${province}`);
        // Comma → quoted; inner quotes doubled; raw newline stays inside quotes.
        expect(body).toContain('"Comma, ""Quoted""\nLine"');
    });

    it('applies the same filters as the list endpoint', async () => {
        const owners = await exportCsv(`province=${province}&sellerType=OWNER`);
        expect(owners.body).toContain(sourceIds[0]!);
        expect(owners.body).toContain(sourceIds[1]!);
        expect(owners.body).not.toContain(sourceIds[2]!);

        const priceWindow = await exportCsv(`province=${province}&priceMin=700000&priceMax=800000`);
        expect(priceWindow.body).not.toContain(sourceIds[0]!);
        expect(priceWindow.body).toContain(sourceIds[1]!);
        expect(priceWindow.body).not.toContain(sourceIds[2]!);
    });

    it('caps at export.maxRows (via settings) and appends a clear notice row', async () => {
        // Whitelist rejection first: unknown keys are not free-form.
        const rejected = await ctx.app.inject({
            method: 'PATCH',
            url: '/api/settings',
            payload: { 'export.maxRows': 2, 'evil.key': true },
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().error.code).toBe('VALIDATION_ERROR');

        const patched = await ctx.app.inject({ method: 'PATCH', url: '/api/settings', payload: { 'export.maxRows': 2 } });
        expect(patched.statusCode).toBe(200);
        expect(patched.json()['export.maxRows']).toBe(2);
        ctx.track.settingKeys.push('export.maxRows');

        const { statusCode, body } = await exportCsv(`province=${province}&sort=price&order=asc`);
        expect(statusCode).toBe(200);
        // 2 of the 3 rows (cheapest two: 750_000 and 1_250_000) + notice.
        expect(body).toContain(sourceIds[1]!);
        expect(body).toContain(sourceIds[0]!);
        expect(body).not.toContain(sourceIds[2]!);
        expect(body).toContain('EXPORT CAPPED at 2 of 3 matching rows');
    });

    it('rejects a non-whitelisted sort field with 400', async () => {
        const { statusCode, body } = await exportCsv('sort=banana');
        expect(statusCode).toBe(400);
        expect(JSON.parse(body).error.code).toBe('VALIDATION_ERROR');
    });
});
