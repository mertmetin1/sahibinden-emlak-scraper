/**
 * Regression test: parse the sanitized real category-page fixture
 * (fixtures/html/category-satilik-adana-seyhan.html) with the engine's actual
 * in-page extractor + normalizer, and pin the output to the 13-field contract.
 *
 * Harness notes:
 * - Runs the engine's `extractCategoryRawInPage` inside headless Chrome via
 *   page.evaluate — exactly how runCrawl invokes it (run-crawl.ts).
 * - A `<base href="https://www.sahibinden.com/">` tag is injected before
 *   setContent so relative `/ilan/...` hrefs absolutize against the origin,
 *   mirroring production (where the page IS served from sahibinden.com).
 *   Without it the page URL is about:blank and `a.href` stays root-relative.
 *
 * FIXTURE FACT (deviation from the task brief, verified by inspection):
 * the fixture contains 52 rows matching the primary selector, not 50 —
 *   * 50 organic listing rows (pagingSize=50),
 *   * 1 promoted listing row (`searchResultsPromoSuper`, data-id 846758673)
 *     with full title/url/price — upstream's identical selector chain also
 *     extracts it, so contract-faithful parsing yields it too,
 *   * 1 native-ad row (`searchResultsItem nativeAd`, no title/url) which
 *     normalizeCategoryItems silently skips per the contract.
 * => extractCategoryRawInPage returns 52 raw rows; normalizeCategoryItems
 *    returns 51 items. The "50 listing rows" description in the fixture
 *    inventory counts only organic rows.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import {
    CATEGORY_ROW_SELECTOR,
    extractCategoryRawInPage,
    normalizeCategoryItems,
    type RawCategoryRow,
} from '../../packages/scraper-engine/src/index.js';
import type { CategoryListing } from '../../packages/shared/src/index.js';
import { assertCategoryListingContract } from '../helpers/contract-assertions.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/html/category-satilik-adana-seyhan.html');
const SOURCE_URL = 'https://www.sahibinden.com/satilik/adana-seyhan?sorting=date_desc&pagingSize=50';

/** Organic rows (50) + promoted listing row (1); native-ad row is skipped. */
const EXPECTED_ITEM_COUNT = 51;
/** All rows matching the primary selector, including the native-ad row. */
const EXPECTED_RAW_ROW_COUNT = 52;

let browser: Browser;
let rawRows: RawCategoryRow[];
let items: CategoryListing[];

beforeAll(async () => {
    const html = readFileSync(FIXTURE, 'utf8');
    // Emulate the page's real origin so el.href absolutizes (see header note).
    const withBase = html.replace(
        /<head>/i,
        '<head><base href="https://www.sahibinden.com/">',
    );
    expect(withBase).not.toBe(html); // guard: <head> must exist in the fixture

    browser = await puppeteer.launch({
        headless: true,
        channel: 'chrome', // system Chrome (PUPPETEER_SKIP_DOWNLOAD env)
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(withBase, { waitUntil: 'domcontentloaded' });
    rawRows = await page.evaluate(extractCategoryRawInPage, CATEGORY_ROW_SELECTOR);
    items = normalizeCategoryItems(rawRows, SOURCE_URL);
    await page.close();
}, 60_000);

afterAll(async () => {
    await browser?.close();
});

describe('category fixture parse (sanitized real page)', () => {
    it('extracts every selector-matching row in-page', () => {
        expect(rawRows.length).toBe(EXPECTED_RAW_ROW_COUNT);
    });

    it('normalizes to exactly the listing rows (native-ad row skipped)', () => {
        expect(items.length).toBe(EXPECTED_ITEM_COUNT);
        // The skipped row is the native ad: no title anchor, no detail URL.
        const skipped = rawRows.filter(r => !r.title || !r.url);
        expect(skipped.length).toBe(EXPECTED_RAW_ROW_COUNT - EXPECTED_ITEM_COUNT);
    });

    it('every item satisfies the exact 13-field contract', () => {
        for (const [i, item] of items.entries()) {
            assertCategoryListingContract(item, `item[${i}]`, {
                sourceUrlPrefix: 'https://www.sahibinden.com',
                urlPrefix: 'https://www.sahibinden.com/ilan/',
            });
        }
    });

    it('has no duplicate ids', () => {
        const ids = items.map(i => i.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every url is an absolute /ilan/.../detay detail URL', () => {
        for (const item of items) {
            expect(item.url).toContain('/ilan/');
            expect(item.url.endsWith('/detay')).toBe(true);
        }
    });

    it('every price is null or positive', () => {
        for (const item of items) {
            expect(item.price === null || item.price > 0).toBe(true);
        }
        // Sanity: TR thousands parsing must produce million-scale prices here.
        expect(items.some(i => i.price !== null && i.price > 1_000_000)).toBe(true);
    });

    it('titles are non-empty after normalizeText', () => {
        for (const item of items) {
            expect(item.title.length).toBeGreaterThan(0);
            expect(item.title).toBe(item.title.trim());
        }
    });

    it('location is non-empty (multi-level rows use " / ")', () => {
        for (const item of items) {
            expect(item.location.length).toBeGreaterThan(0);
        }
        // The fixture has both single-level ("Esenyurt"-style) and multi-level
        // ("İlçe / Mahalle") locations; at least one of each must survive.
        expect(items.some(i => i.location.includes(' / '))).toBe(true);
    });

    it('first row id is the 10-digit string from data-id', () => {
        expect(items[0]).toBeDefined();
        expect(items[0]!.id).toMatch(/^\d{10}$/);
        expect(items[0]!.id).toBe('1331532951');
    });

    it('sourceUrl is stamped identically on every item', () => {
        for (const item of items) {
            expect(item.sourceUrl).toBe(SOURCE_URL);
        }
    });
});
