/**
 * İlanlar: rows render, the filter drawer round-trips through the URL
 * (URL-addressable filters) with row counts consistent with the API, the
 * detail page renders its sections, and the CSV export link is wired to
 * /api/listings/export.csv.
 */
import { expect, test } from '@playwright/test';

import { apiGet, trNumber } from './helpers';

/** Splits the live price range (verified against current listings). */
const PRICE_MIN = '10000000';

interface ListingListApi {
    rows: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
}

test('listings table renders rows and search filters by title', async ({ page }) => {
    const api = await apiGet<ListingListApi>('/api/listings?pageSize=1');
    expect(api.total, 'API should report listings').toBeGreaterThanOrEqual(1);
    const sampleTitle = String(api.rows[0]?.title ?? '');
    expect(sampleTitle.length).toBeGreaterThan(0);

    await page.goto('/ilanlar');
    await expect(page.getByRole('heading', { level: 1, name: 'İlanlar', exact: true })).toBeVisible();
    await expect(page.getByText(`${trNumber(api.total)} ilan`, { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'İlan ara' })).toBeVisible();

    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count(), 'rendered row count').toBe(Math.min(api.total, 25));

    await page.getByRole('textbox', { name: 'İlan ara' }).fill(sampleTitle);
    await page.getByRole('button', { name: 'Ara' }).click();
    await page.waitForURL(/search=/);
    await expect(page.locator('tbody')).toContainText(sampleTitle);
});

test('price-min filter is URL-addressable and consistent with the API', async ({ page }) => {
    const unfiltered = await apiGet<ListingListApi>('/api/listings?pageSize=1');
    const filtered = await apiGet<ListingListApi>(`/api/listings?pageSize=100&priceMin=${PRICE_MIN}`);
    expect(filtered.total).toBeGreaterThan(0);
    expect(filtered.total, 'filter must actually narrow the result set').toBeLessThan(unfiltered.total);

    await page.goto('/ilanlar');
    await expect(page.getByRole('textbox', { name: 'İlan ara' })).toBeVisible();
    await page.getByRole('button', { name: 'Filtrele' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('İlan Filtreleri')).toBeVisible();
    await expect(sheet.getByText('Mülk tipi', { exact: true })).toBeVisible();
    await expect(sheet.getByText('Tür / emlak tipi', { exact: true })).toBeVisible();
    await sheet.locator('#f-priceMin').fill(PRICE_MIN);
    await sheet.getByRole('button', { name: 'Uygula' }).click();

    // Filters are URL-addressable.
    await page.waitForURL(new RegExp(`/ilanlar\\?.*priceMin=${PRICE_MIN}`));
    expect(page.url()).toContain(`priceMin=${PRICE_MIN}`);
    await expect(page.getByText(`${trNumber(filtered.total)} ilan`, { exact: true })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(Math.min(filtered.total, 25));
    await expect(page.getByText('Min fiyat', { exact: true })).toBeVisible();
});

test('listing detail shows title, fiyat, özellikler grid and ham özellikler section', async ({ page }) => {
    const list = await apiGet<ListingListApi>('/api/listings?pageSize=1');
    const listingId = String(list.rows[0]?.id ?? '');
    expect(listingId.length).toBeGreaterThan(0);

    const detail = await apiGet<{
        title: string;
        price: number | null;
        attributes: unknown[];
        grossAreaM2: number | null;
        rooms: string | null;
        listingType: string | null;
        propertyCategory: string | null;
        listingDateRaw: string | null;
    }>(`/api/listings/${listingId}`);

    await page.goto(`/ilanlar/${listingId}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(detail.title);

    const hasFeatures = [detail.grossAreaM2, detail.rooms, detail.listingType, detail.propertyCategory, detail.listingDateRaw].some(
        (v) => v !== null,
    );
    if (hasFeatures) {
        await expect(page.getByText('Özellikler', { exact: true })).toBeVisible();
        await expect(page.locator('main dl')).toBeVisible();
    }

    await expect(page.getByText('Ham Özellikler', { exact: true })).toBeVisible();
    if (detail.attributes.length > 0) {
        const rawCard = page.locator('[data-slot="card"]', { hasText: 'Ham Özellikler' });
        await expect(rawCard.locator('tbody tr').first()).toBeVisible();
    } else {
        await expect(page.getByText('Özellik kaydı yok.', { exact: true })).toBeVisible();
    }
});

test('CSV export link points to /api/listings/export.csv and serves CSV', async ({ page }) => {
    await page.goto('/ilanlar');
    const link = page.getByRole('link', { name: 'CSV İndir' });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/api\/listings\/export\.csv\?/);

    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    const body = await res.text();
    const lines = body.trim().split('\n');
    expect(lines.length, 'CSV header + seeded rows').toBeGreaterThan(1);
    expect(lines[0]).toContain('sourceListingId');
    expect(lines[0]).toContain('title');
});
