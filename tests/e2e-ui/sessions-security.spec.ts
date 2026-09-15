/**
 * Oturumlar + secret hygiene: a cookie profile is imported through the UI,
 * listed with metadata only (cookieCount), and deleted through the UI. The
 * cookie VALUE is a canary — it must appear nowhere: not in the DOM, not in
 * any /api response body captured during the flow, not in the API's
 * list/detail payloads.
 */
import { expect, test } from '@playwright/test';

import { apiDelete, apiGet } from './helpers';

const SECRET = 'SECRETVALUE123';
const PROFILE_PREFIX = 'E2E Güvenlik';
const COOKIE_JSON = JSON.stringify([{ name: 'test', value: SECRET, domain: '.sahibinden.com' }]);

interface CookieProfileListApi {
    rows: Array<{ id: string; name: string; cookieCount: number; createdAt?: string }>;
    total: number;
}

/**
 * Names created by THIS worker. With fullyParallel the file's tests can be
 * split across workers, so a global prefix sweep would race a profile that
 * another worker is still exercising — only ever delete own names plus
 * stale (>10 min) leftovers from crashed runs.
 */
const createdProfileNames: string[] = [];

test.afterAll(async () => {
    const list = await apiGet<CookieProfileListApi>('/api/cookie-profiles');
    const staleBefore = Date.now() - 10 * 60_000;
    for (const profile of list.rows) {
        const createdAt = profile.createdAt !== undefined ? Date.parse(profile.createdAt) : Number.NaN;
        const own = createdProfileNames.includes(profile.name);
        const stale = profile.name.startsWith(PROFILE_PREFIX) && Number.isFinite(createdAt) && createdAt < staleBefore;
        if (own || stale) {
            await apiDelete(`/api/cookie-profiles/${profile.id}`);
        }
    }
});

test('cookie profile import shows metadata only and never leaks the secret', async ({ page }) => {
    const profileName = `${PROFILE_PREFIX} ${Date.now()}`;
    createdProfileNames.push(profileName);

    // Capture every JSON API response body during the whole flow.
    const apiBodies: string[] = [];
    page.on('response', (res) => {
        if (!res.url().includes('/api/')) return;
        const contentType = res.headers()['content-type'] ?? '';
        if (!contentType.includes('json')) return;
        res.text()
            .then((body) => apiBodies.push(body))
            .catch(() => undefined);
    });

    await page.goto('/oturumlar');
    await expect(page.getByRole('heading', { level: 1, name: 'Oturumlar', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Çerez Profilleri' })).toBeVisible();

    // Import via the UI dialog.
    await page.getByRole('button', { name: 'Çerez İçe Aktar', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('#ci-name').fill(profileName);
    await dialog.locator('#ci-json').fill(COOKIE_JSON);
    await dialog.getByRole('button', { name: 'İçe Aktar', exact: true }).click();
    // Clean import (no normalization issues) closes the dialog.
    await expect(dialog).toBeHidden();

    // The list shows the profile with cookieCount 1.
    const row = page.locator('tbody tr', { hasText: profileName });
    await expect(row).toBeVisible();
    await expect(row.locator('td').nth(2)).toHaveText('1');

    // API cross-check: metadata only, cookieCount 1.
    const list = await apiGet<CookieProfileListApi>('/api/cookie-profiles');
    const created = list.rows.find((p) => p.name === profileName);
    expect(created, 'profile must be listed by the API').toBeTruthy();
    expect(created!.cookieCount).toBe(1);
    const detail = await apiGet<Record<string, unknown>>(`/api/cookie-profiles/${created!.id}`);
    expect(JSON.stringify(detail), 'API detail payload must not contain the secret').not.toContain(SECRET);
    expect(JSON.stringify(list), 'API list payload must not contain the secret').not.toContain(SECRET);

    // The secret appears nowhere in the rendered DOM…
    const dom = await page.content();
    expect(dom.includes(SECRET), 'secret must not appear anywhere in the DOM').toBe(false);

    // …nor in any API response captured during the flow (incl. the POST 201).
    await page.waitForTimeout(500); // let in-flight response listeners settle
    expect(apiBodies.length, 'expected captured /api JSON responses').toBeGreaterThan(0);
    for (const body of apiBodies) {
        expect(body.includes(SECRET), 'secret must not appear in any /api response body').toBe(false);
    }

    // Delete through the UI (dropdown → Sil → confirm).
    await row.getByRole('button', { name: 'Aksiyonlar' }).click();
    await page.getByRole('menuitem', { name: 'Sil' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText('Çerez profilini sil', { exact: true })).toBeVisible();
    await confirm.getByRole('button', { name: 'Sil', exact: true }).click();
    await expect(page.locator('tbody tr', { hasText: profileName })).toHaveCount(0);

    // Post-delete: still no secret anywhere, and the API no longer lists it.
    const afterList = await apiGet<CookieProfileListApi>('/api/cookie-profiles');
    expect(afterList.rows.some((p) => p.name === profileName)).toBe(false);
    const domAfter = await page.content();
    expect(domAfter.includes(SECRET), 'secret must stay out of the DOM after delete').toBe(false);
});
