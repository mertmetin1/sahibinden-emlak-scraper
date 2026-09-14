/**
 * Helpers ported 1:1 from upstream `src/utils.js` (commit a14740c).
 * Behavior parity is a hard requirement — see docs/BASELINE_CONTRACT.md.
 *
 * MOVED here from `@sahibindenbot/scraper-engine` (Phase 2 — parser owns all
 * extraction helpers). `randomDelay` intentionally STAYS in the engine (it is
 * pacing, not parsing).
 *
 * INTENTIONALLY DROPPED (ADR-0002 legal boundary / dead code):
 * - `randomUserAgent()` — UA rotation exists to defeat bot detection; the
 *   CDP-attached real browser needs no UA forging.
 * - `generateSessionId()` — dead code upstream (never imported).
 * - `parseYesNo()` — dead code upstream (orphaned detail-page helper).
 */

/**
 * Formats a price string to a numeric value.
 * Exact port of upstream `formatPrice`, including its known quirk:
 * Turkish format `4.500.000 TL` → 4500000 (dots stripped as thousands
 * separators, comma → decimal point), but a US-formatted `1,500,000`
 * collapses to 1.5. Sahibinden serves TR-formatted prices, so the quirk is
 * preserved for baseline parity rather than fixed.
 */
export function formatPrice(priceStr: string | null | undefined): number | null {
    if (!priceStr) return null;

    // Remove all non-numeric characters except separators
    const numericStr = priceStr
        .replace(/[^0-9,.]/g, '')
        .replace(/\./g, '') // Remove thousands separator (.)
        .replace(/,/g, '.'); // Replace comma with decimal point

    const price = parseFloat(numericStr);
    return isNaN(price) ? null : price;
}

/**
 * Extracts currency from a price string. Defaults to 'TL' — even when the
 * input is null (baseline contract quirk, preserved on purpose).
 * Exact port of upstream `extractCurrency`.
 */
export function extractCurrency(priceStr: string | null | undefined): string {
    if (!priceStr) return 'TL';
    if (priceStr.includes('EUR') || priceStr.includes('€')) return 'EUR';
    if (priceStr.includes('USD') || priceStr.includes('$')) return 'USD';
    if (priceStr.includes('GBP') || priceStr.includes('£')) return 'GBP';
    return 'TL';
}

/**
 * Normalizes text: collapses whitespace, then repairs UTF-8-as-Latin-1
 * mojibake (e.g. "Ã¼" → "ü", common with Turkish characters).
 * Exact port of upstream `normalizeText`, including the deprecated
 * `escape()` hack: already-correct Unicode throws inside decodeURIComponent
 * and is returned as-is. Fragile but behavior-frozen by the baseline contract.
 */
export function normalizeText(text: string | null | undefined): string {
    if (!text) return '';
    let result = text.replace(/\s+/g, ' ').trim();
    try {
        result = decodeURIComponent(escape(result));
    } catch {
        // Correct Unicode input throws here and is returned as-is.
    }
    return result;
}

/**
 * Extracts a listing ID from a sahibinden.com URL.
 * Exact port of upstream `extractListingId`: the ID is the first 8-12 digit
 * run immediately followed by `/` or end-of-string. Callers prefer the row's
 * `data-id` attribute and use this only as fallback.
 */
export function extractListingId(url: string | null | undefined): string | null {
    if (!url) return null;
    const match = url.match(/(\d{8,12})(?:\/|$)/);
    return match?.[1] ?? null;
}
