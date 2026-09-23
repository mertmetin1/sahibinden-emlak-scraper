/**
 * Challenge DETECTION only — substring signatures ported 1:1 from upstream
 * `src/main.js:97-119`. All automated SOLVING (PX press-and-hold, CF
 * auto-wait-as-solve) is intentionally removed per ADR-0002; detection feeds
 * the human-in-the-loop flow in run-crawl.ts.
 */
import type { ChallengeKind } from '../types.js';

/** Cloudflare / generic interstitial signatures (upstream `isChallengedPage`). */
export function isChallengedPage(html: string): boolean {
    return (
        html.includes('Just a moment') ||
        html.includes('Checking your browser') ||
        html.includes('cf-browser-verification') ||
        html.includes('challenge-platform') ||
        html.includes('Performing security verification') ||
        html.includes('Verifying you are human') ||
        html.includes('cf-turnstile') ||
        html.includes('Güvenlik doğrulaması gerçekleştirme') ||
        html.includes('Bir dakika lütfen') ||
        html.includes('Uyumsuz tarayıcı eklentisi')
    );
}

/**
 * True when the live page already has scrapeable listing/detail markup.
 * Self-contained for `page.evaluate`.
 */
export const pageHasCrawlableContent = (): boolean => {
    if (document.querySelectorAll('tr.searchResultsItem').length > 0) return true;
    if (document.querySelector('ul.classifiedInfoList')) return true;
    if (document.querySelector('table.searchResultsTable')) return true;
    if (document.querySelector('#classifiedTitle, .classifiedDetailTitle, .classifiedInfo')) return true;
    return false;
};

/**
 * Browser-context probe: returns true if a VISIBLE challenge UI is still on
 * the page. Substring checks on raw HTML (isChallengedPage) stay true after
 * solve because Cloudflare leaves `challenge-platform` script references in
 * the DOM; this check looks for actually-rendered challenge elements only.
 * Run via page.evaluate(isChallengeVisible).
 *
 * Must stay self-contained (page.evaluate serializes this function only).
 */
export const isChallengeVisible = (): boolean => {
    const shown = (el: Element | null): boolean => {
        if (!el) return false;
        const html = el as HTMLElement;
        const rect = html.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return false;
        if (rect.bottom < 0 || rect.right < 0) return false;
        if (rect.top > (window.innerHeight || 0) || rect.left > (window.innerWidth || 0)) return false;
        const style = window.getComputedStyle(html);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        return true;
    };

    // Real content already on screen → this is not a challenge interstitial.
    if (document.querySelectorAll('tr.searchResultsItem').length > 0) return false;
    if (document.querySelector('ul.classifiedInfoList')) return false;
    if (document.querySelector('table.searchResultsTable')) return false;
    if (document.querySelector('#classifiedTitle, .classifiedDetailTitle, .classifiedInfo')) return false;

    const overlaySelectors = [
        '#challenge-running',
        '#challenge-stage',
        '.cf-browser-verification',
        '.cf-turnstile',
        '#px-captcha',
        '.px-captcha',
        '[id^="_px"]',
    ];
    for (const sel of overlaySelectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
            if (shown(el)) return true;
        }
    }

    const cfIframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
        const src = f.getAttribute('src') || '';
        return src.includes('challenges.cloudflare.com') || src.includes('turnstile') || src.includes('cdn-cgi/challenge');
    });
    for (const f of cfIframes) {
        if (shown(f)) return true;
    }

    // innerText skips hidden nodes and <script>; textContent does not.
    const bodyText = (document.body && document.body.innerText) || '';
    const phrases = [
        'Performing security verification',
        'Verifying you are human',
        'Checking your browser',
        'Just a moment',
        'Bir dakika lütfen',
        'Güvenlik doğrulaması',
        'Basılı Tutun',
        'Bağlantınız kontrol ediliyor',
        'Olağan dışı erişim',
        'Olağandışı erişim',
    ];
    for (const p of phrases) {
        if (bodyText.includes(p)) return true;
    }

    return false;
};

/** PerimeterX "press and hold" signatures (upstream `isPxHoldChallenge`). */
export function isPxHoldChallenge(html: string): boolean {
    return (
        html.includes('Basılı Tutun') ||
        html.includes('px-captcha') ||
        html.includes('_pxCaptcha') ||
        html.includes('PerimeterX') ||
        html.includes('Bağlantınız kontrol ediliyor') ||
        html.includes('human-challenge')
    );
}

function foldTr(text: string): string {
    return text
        .toLocaleLowerCase('tr')
        .replace(/ı/g, 'i')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/\s+/g, ' ');
}

/** Sahibinden "Olağan dışı erişim tespit ettik" interstitial — not a CF/PX hold. */
export function isUnusualAccessHtml(html: string): boolean {
    const folded = foldTr(html);
    const compact = folded.replace(/[-\s]/g, '');
    return (
        compact.includes('olagandisierisim') ||
        compact.includes('olagandisikullanim') ||
        folded.includes('unusual access')
    );
}

/**
 * Browser-context probe for the unusual-access interstitial.
 * False when listing/detail markup is already on screen.
 * Run via page.evaluate(unusualAccessVisible).
 */
export const unusualAccessVisible = (): boolean => {
    if (document.querySelectorAll('tr.searchResultsItem').length > 0) return false;
    if (document.querySelector('ul.classifiedInfoList')) return false;
    if (document.querySelector('table.searchResultsTable')) return false;
    if (document.querySelector('#classifiedTitle, .classifiedDetailTitle, .classifiedInfo')) return false;
    const bodyText = (document.body && document.body.innerText) || '';
    const folded = bodyText
        .toLocaleLowerCase('tr')
        .replace(/ı/g, 'i')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/\s+/g, ' ');
    const path = ((window.location && window.location.pathname) || '').toLowerCase();
    if (path.includes('/olagan-disi-kullanim') || path.includes('/olagan-disi-erisim')) return true;
    const compact = folded.replace(/[-\s]/g, '');
    return compact.includes('olagandisierisim') || compact.includes('olagandisikullanim') || folded.includes('unusual access');
};

/**
 * Classifies page HTML. Unusual-access is first (it is not a hold to solve).
 * PX is next (a PX hold page can also contain CF-ish strings). 'login-wall'
 * is URL-based and therefore detected by the caller, not here.
 */
export function detectChallengeKind(html: string): ChallengeKind {
    if (isUnusualAccessHtml(html)) return 'unusual-access';
    if (isPxHoldChallenge(html)) return 'perimeterx';
    if (isChallengedPage(html)) return 'cloudflare';
    return 'unknown-block';
}
