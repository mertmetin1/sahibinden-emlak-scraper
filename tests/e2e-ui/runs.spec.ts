/**
 * Çalıştırmalar: the seeded synthetic run is listed, and its detail page
 * renders the status badge, the statistics grid, the configuration snapshot
 * viewer and the event log — including the DB-replayed journal events
 * (seeded by global setup; the worker is not run for UI tests).
 */
import { expect, test } from '@playwright/test';

import { apiGet } from './helpers';

const DEMO_SCAN_NAME = 'Adana Seyhan Satılık (demo)';

let seededRunId: string;

test.beforeAll(async () => {
    const scans = await apiGet<{
        rows: Array<{ name: string; latestRun: { id: string; status: string } | null }>;
    }>('/api/scans');
    const demo = scans.rows.find((s) => s.name === DEMO_SCAN_NAME);
    expect(demo, `seeded scan "${DEMO_SCAN_NAME}" must exist`).toBeTruthy();
    expect(demo!.latestRun, 'seeded scan must have a latest run').not.toBeNull();
    seededRunId = demo!.latestRun!.id;

    const detail = await apiGet<{ status: string; events: unknown[] }>(`/api/runs/${seededRunId}`);
    expect(detail.status).toBe('SUCCEEDED');
    expect(
        detail.events.length,
        'seeded run should carry replayed journal events (inserted by global setup)',
    ).toBeGreaterThanOrEqual(3);
});

test('runs list shows the seeded run with its status', async ({ page }) => {
    await page.goto('/calistirmalar');
    await expect(page.getByRole('heading', { level: 1, name: 'Çalıştırmalar', exact: true })).toBeVisible();

    const row = page.locator('tbody tr', { hasText: DEMO_SCAN_NAME }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Başarılı');
    await expect(row).toContainText('Test'); // trigger badge

    // Row click navigates to the run detail.
    await row.click();
    await page.waitForURL(new RegExp(`/calistirmalar/${seededRunId}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Run');
});

test('run detail renders status, statistics, snapshot viewer and replayed log', async ({ page }) => {
    await page.goto(`/calistirmalar/${seededRunId}`);

    // Status + trigger badges in the header.
    await expect(page.getByText('Başarılı', { exact: true })).toBeVisible();
    await expect(page.getByText('Test', { exact: true })).toBeVisible();

    // Statistics grid (all ten counter cards).
    for (const label of [
        'Ziyaret Edilen Sayfa',
        'Kategori Sayfası',
        'Detay Sayfası',
        'Keşfedilen İlan',
        'Eklenen',
        'Güncellenen',
        'Fiyat Değişimi',
        'Başarısız İstek',
        'Yeniden Deneme',
        'Süre',
    ]) {
        await expect(page.getByText(label, { exact: true }), `stat "${label}"`).toBeVisible();
    }
    // Seeded run discovered 20 items.
    await expect(
        page.locator('[data-slot="card"]', { hasText: 'Keşfedilen İlan' }).getByText('20', { exact: true }),
    ).toBeVisible();

    // Configuration snapshot viewer (collapsible; seeded snapshot marker inside).
    const snapshotToggle = page.getByRole('button', { name: 'Yapılandırma Anlık Görüntüsü' });
    await expect(snapshotToggle).toBeVisible();
    await snapshotToggle.click();
    await expect(page.locator('pre')).toContainText('"seed": true');

    // Event log: container, terminal-state connection badge, and the
    // DB-replayed journal events rendered as Turkish one-liners.
    await expect(page.getByText('Canlı Olay Akışı', { exact: true })).toBeVisible();
    await expect(page.getByText('Kapandı (SUCCEEDED)', { exact: true })).toBeVisible();
    await expect(page.getByText('Run başladı — 1 hedef URL, mod managed')).toBeVisible();
    await expect(page.getByText('Kategori işlendi: 20 ilan bulundu, 20 yeni')).toBeVisible();
    await expect(page.getByText('Run tamamlandı: SUCCEEDED')).toBeVisible();
    await expect(page.getByText('RUN_COMPLETED', { exact: true })).toBeVisible();
});
