/**
 * Unusual-access recovery and residential proxy hops.
 *
 * "Olağan dışı erişim" is an IP-level block, not a PX/CF hold to solve
 * (ADR-0002). Cookie wipe on the same IP does not help. Safe automation:
 * rotate residential proxies on a cooldown BEFORE the block, and if the
 * interstitial still appears, wait longer, wipe cookies, hop IP, resume
 * from the last category URL (pagingOffset included).
 *
 * CDP attaches to the operator's Chrome and cannot change its network
 * stack — hops only run in managed mode with a proxy profile.
 */
import type { Page } from 'puppeteer';

export const UNUSUAL_ACCESS_COOLDOWN_MS = 10 * 60 * 1000;
export const UNUSUAL_ACCESS_MAX_RECOVERIES = 4;

/** Stay under the empirically observed 8-detail CF burst. */
export const PROXY_HOP_EVERY = 6;
export const PROXY_HOP_COOLDOWN_MIN_MS = 25_000;
export const PROXY_HOP_COOLDOWN_MAX_MS = 45_000;

export function isListingDetailUrl(url: string): boolean {
    return url.includes('/ilan/') && url.includes('/detay');
}

/** Live interstitial lives at `/olagan-disi-kullanim`, not only in body copy. */
export function isUnusualAccessUrl(url: string): boolean {
    try {
        const path = new URL(url).pathname.toLocaleLowerCase('tr');
        return (
            path.includes('/olagan-disi-kullanim') ||
            path.includes('/olagan-disi-erisim') ||
            path.includes('/olagandisi-kullanim') ||
            path.includes('/unusual-access')
        );
    } catch {
        const lower = url.toLowerCase();
        return lower.includes('/olagan-disi-kullanim') || lower.includes('/olagan-disi-erisim');
    }
}

export function proxyRotationAvailable(browserMode: string, hasProxyConfig: boolean): boolean {
    return hasProxyConfig && browserMode !== 'cdp';
}

export function shouldHopProxy(detailsWritten: number, hopEvery: number = PROXY_HOP_EVERY): boolean {
    return detailsWritten > 0 && detailsWritten % hopEvery === 0;
}

export function proxyHopCooldownMs(): number {
    return (
        PROXY_HOP_COOLDOWN_MIN_MS +
        Math.floor(Math.random() * (PROXY_HOP_COOLDOWN_MAX_MS - PROXY_HOP_COOLDOWN_MIN_MS + 1))
    );
}

/**
 * Prefer the last known category/list URL (keeps pagingOffset). An
 * interstitial or detail URL must not become the resume target.
 */
export function resumeUrlForUnusualAccess(currentUrl: string, lastListUrl: string): string {
    const fallback = lastListUrl.trim() !== '' ? lastListUrl : currentUrl;
    if (isListingDetailUrl(currentUrl)) return fallback;
    if (isUnusualAccessUrl(currentUrl)) return fallback;
    try {
        const u = new URL(currentUrl);
        const path = u.pathname.toLowerCase();
        if (path.includes('/giris') || path.includes('/cs/tloading')) return fallback;
        if (path.includes('/satilik') || path.includes('/kiralik') || u.searchParams.has('pagingOffset')) {
            return currentUrl;
        }
    } catch {
        return fallback;
    }
    return fallback;
}

export async function clearBrowserCookies(page: Page): Promise<void> {
    try {
        const cdp = await page.createCDPSession();
        try {
            await cdp.send('Network.clearBrowserCookies');
        } finally {
            await cdp.detach().catch(() => undefined);
        }
        return;
    } catch {
        // CDP session unavailable — fall back to Puppeteer's cookie API.
    }
    const cookies = await page.cookies().catch(() => []);
    if (cookies.length > 0) {
        await page.deleteCookie(...cookies);
    }
}
