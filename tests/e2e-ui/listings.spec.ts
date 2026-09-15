/**
 * İlanlar: seeded rows render, the filter drawer round-trips through the URL
 * (URL-addressable filters) with row counts consistent with the API, the
 * detail page renders its sections, and the CSV export link is wired to
 * /api/listings/export.csv.
 */
import { expect, test } from '@playwright/test';

import { apiGet, trNumber } from './helpers';

/** Stable fragment of a seeded fixture title. */
const KNOWN_TITLE = 'SİLTAŞ PANORAMADA';
/** Splits the seeded price range 20 → 7 (verified against the fixture data). */
const PRICE_MIN = '10000000';

interface ListingListApi {
    rows: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
}

test('listings table renders the seeded rows', async ({ page }) => {
    const api = await apiGet<ListingListApi>('/api/listings?pageSize=1');
    expect(api.total, 'API should report the seeded listings').toBeGreaterThanOrEqual(20);

    await page.goto('/ilanlar');
    await expect(page.getByRole('heading', { level: 1, name: 'İlanlar', exact: true })).toBeVisible();

    // Header description is the API total, tr-TR formatted ("20 ilan").
    await expect(page.getByText(`${trNumber(api.total)} ilan`, { exact: true })).toBeVisible();

    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count, 'rendered row count').toBeGreaterThan(0);
    // Single page of seeded data (pageSize 25 ≥ 20): every seeded row renders.
    expect(count).toBe(Math.min(api.total, 25));
    await expect(page.locator('tbody')).toContainText(KNOWN_TITLE);
});

test('price-min filter is URL-addressable and consistent with the API', async ({ page }) => {
    const unfiltered = await apiGet<ListingListApi>('/api/listings?pageSize=1');
    const filtered = await apiGet<ListingListApi>(`/api/listings?pageSize=100&priceMin=${PRICE_MIN}`);
    expect(filtered.total).toBeGreaterThan(0);
    expect(filtered.total, 'filter must actually narrow the result set').toBeLessThan(unfiltered.total);

    await page.goto('/ilanlar');
    const beforeCount = await page.locator('tbody tr').count();

    await page.getByRole('button', { name: 'Filtrele' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('İlan Filtreleri')).toBeVisible();
    await sheet.locator('#f-priceMin').fill(PRICE_MIN);
    await sheet.getByRole('button', { name: 'Uygula' }).click();

    // Filters are URL-addressable.
    await page.waitForURL(new RegExp(`/ilanlar\\?.*priceMin=${PRICE_MIN}`));
    expect(page.url()).toContain(`priceMin=${PRICE_MIN}`);

    // Rendered rows match the API for the same filter (single page: total ≤ 25).
    const expectedRows = Math.min(filtered.total, 25);
    await expect(page.locator('tbody tr')).toHaveCount(expectedRows);
    expect(expectedRows).toBeLessThan(beforeCount);
    await expect(page.getByText(`${trNumber(filtered.total)} ilan`, { exact: true })).toBeVisible();
});

test('listing detail shows title, fiyat, özellikler grid and ham özellikler section', async ({ page }) => {
    await page.goto('/ilanlar');
    const row = page.locator('tbody tr', { hasText: KNOWN_TITLE }).first();
    await expect(row).toBeVisible();

    // Capture the row's rendered price to assert the same value on the detail page.
    const priceText = (await row.locator('td').nth(2).innerText()).trim();
    expect(priceText.length).toBeGreaterThan(0);
    const href = await row.getByRole('link').first().getAttribute('href');
    expect(href).toMatch(/^\/ilanlar\/[^/]+$/);
    const listingId = href!.split('/').pop()!;

    // Ground truth for data-driven section assertions.
    const detail = await apiGet<{
        title: string;
        attributes: unknown[];
        grossAreaM2: number | null;
        rooms: string | null;
        listingType: string | null;
        propertyCategory: string | null;
        listingDateRaw: string | null;
    }>(`/api/listings/${listingId}`);

    await row.getByRole('link').first().click();
    await page.waitForURL(new RegExp(`/ilanlar/${listingId}$`));

    // Title + fiyat.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(KNOWN_TITLE);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(detail.title);
    await expect(page.locator('main')).toContainText(priceText);

    // Özellikler grid — rendered only when at least one normalized feature exists.
    const hasFeatures = [detail.grossAreaM2, detail.rooms, detail.listingType, detail.propertyCategory, detail.listingDateRaw].some(
        (v) => v !== null,
    );
    if (hasFeatures) {
        await expect(page.getByText('Özellikler', { exact: true })).toBeVisible();
        await expect(page.locator('main dl')).toBeVisible();
    }

    // Ham Özellikler — the card always renders; its body must faithfully
    // reflect the API: attribute rows when present, the explicit empty state
    // otherwise (seeded fixture listings carry zero attributes).
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
