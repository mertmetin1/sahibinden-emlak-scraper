/**
 * Category-page parser, split in two for fixture testability:
 *
 *   (a) `extractCategoryRawInPage` — runs INSIDE the browser via
 *       `page.evaluate` (uses innerText/textContent exactly like upstream).
 *       Must stay fully self-contained: page.evaluate serializes the function
 *       source, so it cannot reference module-scope constants or imports.
 *
 *   (b) `normalizeCategoryItems` — pure Node-side function applying
 *       formatPrice / extractCurrency / normalizeText / id-fallback.
 *       This is the function fixture tests pin against the 13-field contract.
 *
 * Selectors and fallback chain are ported 1:1 from upstream `src/main.js`
 * (commit a14740c, lines 652-682) — see docs/BASELINE_CONTRACT.md §1.
 */
import type { CategoryListing } from '@sahibindenbot/shared';
import { extractCurrency, extractListingId, formatPrice, normalizeText } from '../utils.js';

/** Primary listing-row selector (upstream main.js:652). */
export const CATEGORY_ROW_SELECTOR = 'tbody.searchResultsRowClass > tr.searchResultsItem';

/**
 * Fallback row selectors, tried in order, first non-empty wins
 * (upstream main.js:676-682). `[data-id]` is intentionally broad upstream;
 * preserved for parity.
 */
export const FALLBACK_ROW_SELECTORS: readonly string[] = [
    'table.searchResultsTable tr.searchResultsItem',
    '.searchResultsRowClass .searchResultsItem',
    'tr.searchResultsItem',
    '.classified-list-item',
    '[data-id]',
    '.searchResults .result-item',
    'table tr[data-id]',
];

/** Next-page link ("Sonraki" = Turkish "Next"); `.passive` means disabled. */
export const NEXT_PAGE_SELECTOR = 'a.prevNextBut[title="Sonraki"]:not(.passive)';

/**
 * Raw per-row data as scraped inside the browser, before normalization.
 * Every field is nullable: upstream's per-cell `$eval(...).catch(() => null)`
 * semantics are preserved (missing cell → null, never a thrown row).
 */
export interface RawCategoryRow {
    /** Row `data-id` attribute (null when absent). */
    id: string | null;
    /** Absolute detail URL from the title anchor (`a.href` property). */
    url: string | null;
    /** Title anchor text, trimmed. */
    title: string | null;
    /** Raw price cell text, e.g. "4.749.000 TL". */
    priceText: string | null;
    /** `:nth-of-type(2)` price cell (price per m²) — column-order dependent. */
    pricePerSqmText: string | null;
    /** First `searchResultsAttributeValue` cell only (upstream quirk). */
    areaText: string | null;
    /** Location cell innerText, newlines → ' / '. */
    location: string | null;
    /** Date cell innerText, newlines → ' '. */
    date: string | null;
    /** First row image: `src || dataset.src`. */
    image: string | null;
}

/**
 * Extracts raw listing rows from a category page. EXECUTED INSIDE THE BROWSER
 * via `page.evaluate(extractCategoryRawInPage, rowSelector)` — do not reference
 * anything outside this function's body.
 *
 * @param rowSelector the winning row selector (primary or a fallback).
 */
export function extractCategoryRawInPage(rowSelector: string): RawCategoryRow[] {
    // Field selectors inlined (upstream main.js:653-658) — module constants are
    // unreachable after page.evaluate serialization.
    const TITLE_LINK = 'td.searchResultsTitleValue a.classifiedTitle';
    const PRICE = 'td.searchResultsPriceValue span';
    const PRICE_PER_SQM = 'td.searchResultsPriceValue:nth-of-type(2)';
    const AREA = 'td.searchResultsAttributeValue';
    const DATE = 'td.searchResultsDateValue';
    const LOCATION = 'td.searchResultsLocationValue';

    const rows = Array.from(document.querySelectorAll(rowSelector));
    const out: RawCategoryRow[] = [];

    for (const row of rows) {
        try {
            const titleEl = row.querySelector(TITLE_LINK);
            const title = titleEl?.textContent?.trim() ?? null;
            // a.href property (not getAttribute) — upstream used el.href, which absolutizes.
            const url = titleEl ? (titleEl as HTMLAnchorElement).href || null : null;

            const priceText = row.querySelector(PRICE)?.textContent?.trim() ?? null;
            const pricePerSqmText = row.querySelector(PRICE_PER_SQM)?.textContent?.trim() ?? null;
            const areaText = row.querySelector(AREA)?.textContent?.trim() ?? null;

            const locationEl = row.querySelector(LOCATION) as HTMLElement | null;
            const location = locationEl?.innerText?.trim().replace(/\n/g, ' / ') ?? null;

            const dateEl = row.querySelector(DATE) as HTMLElement | null;
            const date = dateEl?.innerText?.trim().replace(/\n/g, ' ') ?? null;

            const imgEl = row.querySelector('img') as HTMLImageElement | null;
            const image = imgEl ? imgEl.src || imgEl.dataset.src || null : null;

            const id = row.getAttribute('data-id');

            out.push({ id, url, title, priceText, pricePerSqmText, areaText, location, date, image });
        } catch {
            // Isolated per-row failure: skip the row, keep the page (baseline contract §3).
        }
    }

    return out;
}

/**
 * Applies the exact 13-field baseline contract to raw rows.
 * Pure and Node-side — fixture tests pin this function.
 *
 * Contract rules (docs/BASELINE_CONTRACT.md §1):
 * - rows without title or url are silently skipped;
 * - `id` prefers the row's data-id, falls back to the URL regex;
 * - `price`/`price_raw`/`image` are null-able; `price_per_sqm`/`area`/
 *   `location`/`date` use '' for missing; `price_currency` defaults to 'TL'
 *   even when the price is null.
 */
export function normalizeCategoryItems(rows: RawCategoryRow[], sourceUrl: string): CategoryListing[] {
    const items: CategoryListing[] = [];

    for (const row of rows) {
        if (!row.title || !row.url) {
            continue; // silent skip — upstream main.js:744-746
        }

        items.push({
            id: row.id ?? extractListingId(row.url),
            url: row.url,
            title: normalizeText(row.title),
            price: formatPrice(row.priceText),
            price_currency: extractCurrency(row.priceText),
            price_raw: row.priceText,
            price_per_sqm: normalizeText(row.pricePerSqmText),
            area: normalizeText(row.areaText),
            location: normalizeText(row.location),
            date: normalizeText(row.date),
            image: row.image ?? null,
            scrapedAt: new Date().toISOString(),
            sourceUrl,
        });
    }

    return items;
}
