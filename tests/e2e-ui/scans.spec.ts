/**
 * Taramalar: the seeded demo scan is listed, the new-scan form renders all
 * seven sections, and a minimal valid scan can be created through the UI
 * (landing on its detail page) and cleaned up via the API.
 */
import { expect, test } from '@playwright/test';

import { apiDelete, apiGet } from './helpers';

const DEMO_SCAN_NAME = 'Adana Seyhan Satılık (demo)';
const SCAN_NAME_PREFIX = 'E2E QA Taraması';

const SECTION_TABS = ['Hedefler', 'Çıkarım', 'Limitler', 'Proxy', 'Oturum', 'Zamanlama', 'Tanılama'] as const;

interface ScanListApi {
    rows: Array<{ id: string; name: string; createdAt?: string }>;
    total: number;
}

/**
 * Ids created by THIS worker. With fullyParallel the file's tests can be
 * split across workers, so a global prefix sweep would race a scan that
 * another worker is still exercising — only ever delete own ids (404 = the
 * test already cleaned up) plus stale (>10 min) leftovers from crashed runs.
 */
const createdScanIds: string[] = [];

test.afterAll(async () => {
    for (const id of createdScanIds) {
        await apiDelete(`/api/scans/${id}`); // 204 or 404 — both fine
    }
    const list = await apiGet<ScanListApi>('/api/scans');
    const staleBefore = Date.now() - 10 * 60_000;
    for (const scan of list.rows) {
        const createdAt = scan.createdAt !== undefined ? Date.parse(scan.createdAt) : Number.NaN;
        if (scan.name.startsWith(SCAN_NAME_PREFIX) && Number.isFinite(createdAt) && createdAt < staleBefore) {
            await apiDelete(`/api/scans/${scan.id}`);
        }
    }
});

test('scans list shows the seeded demo scan', async ({ page }) => {
    await page.goto('/taramalar');
    await expect(page.getByRole('heading', { level: 1, name: 'Taramalar', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: DEMO_SCAN_NAME })).toBeVisible();
});

test('new scan form renders all 7 sections', async ({ page }) => {
    await page.goto('/taramalar/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Yeni Tarama', exact: true })).toBeVisible();
    for (const tab of SECTION_TABS) {
        await expect(page.getByRole('tab', { name: tab, exact: true }), `tab "${tab}"`).toBeVisible();
    }
});

test('create a minimal valid scan via the UI, then delete it', async ({ page }) => {
    const name = `${SCAN_NAME_PREFIX} ${Date.now()}`;

    await page.goto('/taramalar/new');
    await page.locator('#sf-name').fill(name);
    await page
        .locator('#sf-startUrls')
        .fill('https://www.sahibinden.com/satilik-daire/istanbul-kadikoy');
    // Default browser mode is CDP, which requires a CDP URL.
    await page.locator('#sf-cdpUrl').fill('http://127.0.0.1:9222');

    await page.getByRole('button', { name: 'Kaydet', exact: true }).click();

    // Create mode lands on the new scan's detail (edit) page.
    await page.waitForURL(/\/taramalar\/(?!new$)[^/]+$/);
    const scanId = page.url().split('/').pop()!;
    createdScanIds.push(scanId);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

    // …and the scan is visible in the list.
    await page.goto('/taramalar');
    await expect(page.getByRole('link', { name })).toBeVisible();

    // Cleanup via API, then confirm it is gone from the UI.
    const status = await apiDelete(`/api/scans/${scanId}`);
    expect(status, 'DELETE /api/scans/:id').toBe(204);
    createdScanIds.splice(createdScanIds.indexOf(scanId), 1);
    await page.goto('/taramalar');
    await expect(page.getByRole('link', { name })).toHaveCount(0);
});
