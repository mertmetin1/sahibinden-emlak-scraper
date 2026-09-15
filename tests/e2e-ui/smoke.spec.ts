/**
 * Smoke: every sidebar-navigable page returns 200, renders its h1 and the
 * sidebar, and produces zero pageerrors / console.error output.
 */
import { expect, test } from '@playwright/test';

const PAGES = [
    { path: '/', heading: 'Dashboard' },
    { path: '/ilanlar', heading: 'İlanlar' },
    { path: '/taramalar', heading: 'Taramalar' },
    { path: '/calistirmalar', heading: 'Çalıştırmalar' },
    { path: '/proxyler', heading: "Proxy'ler" },
    { path: '/oturumlar', heading: 'Oturumlar' },
    { path: '/ayarlar', heading: 'Ayarlar' },
] as const;

for (const { path, heading } of PAGES) {
    test(`smoke ${path} → "${heading}"`, async ({ page }) => {
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push(String(err)));
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        const response = await page.goto(path);
        expect(response, `navigation to ${path} should produce a response`).not.toBeNull();
        expect(response!.status(), `${path} should return HTTP 200`).toBe(200);

        // Page heading (PageHeader renders a real h1).
        await expect(
            page.getByRole('heading', { level: 1, name: heading, exact: true }),
            `h1 "${heading}" on ${path}`,
        ).toBeVisible();

        // Sidebar with the full nav (aside is hidden below the lg breakpoint;
        // the default 1280px viewport keeps it visible).
        const nav = page.locator('aside nav');
        await expect(nav, 'sidebar nav').toBeVisible();
        for (const label of ['Dashboard', 'İlanlar', 'Taramalar', 'Çalıştırmalar', "Proxy'ler", 'Oturumlar', 'Ayarlar']) {
            await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
        }

        // Give late async errors (effects, polling) a chance to surface.
        await page.waitForTimeout(750);
        expect(pageErrors, `pageerror(s) on ${path}:\n${pageErrors.join('\n')}`).toEqual([]);
        expect(consoleErrors, `console.error(s) on ${path}:\n${consoleErrors.join('\n')}`).toEqual([]);
    });
}
