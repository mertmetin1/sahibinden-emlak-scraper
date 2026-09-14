/**
 * Regression test: parse ALL six sanitized detail-page fixtures
 * (fixtures/html/detail-*.html, described in fixtures/html/README.md) with
 * the parser's real in-page extractor + node-side normalizer, pinning the
 * ListingDetail contract per fixture type.
 *
 * Harness mirrors tests/regression/category-fixture-parse.test.ts:
 * - ONE headless Chrome (channel 'chrome', system Chrome) for all fixtures;
 * - a `<base href="https://www.sahibinden.com/">` injection before setContent
 *   so relative hrefs absolutize against the real origin (the page IS served
 *   from there in production; without it the page URL is about:blank);
 * - extractDetailRawInPage runs INSIDE the page via page.evaluate — exactly
 *   how runCrawl invokes it (run-crawl.ts handleDetailPage).
 *
 * Sanitization note (README.md): phones/office/agent names are masked
 * placeholders — the rendered "opened" phone is literally '0 (5XX) XXX XX XX'
 * and the parser must surface exactly that (never the '*'-masked rendering).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import {
    buildCssContentMap,
    extractDetailRawInPage,
    isUnavailableDetailHtml,
    normalizeDetail,
    resolveObfuscatedText,
    type RawDetailPage,
} from '../../packages/parser-sahibinden/src/index.js';
import type { CategoryListing, ListingDetail } from '../../packages/shared/src/index.js';
import { assertListingDetailContract } from '../helpers/contract-assertions.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/html');

/** Canonical test URLs matching each fixture's real listing (README.md). */
const URLS = {
    sample1: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-t.basi_burgerking_civ_k.mutfak_d.gazli_genis_oturumlu_3-plus1-1340140183/detay',
    sample2: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-mavi-bulvar-da-kapali-mutfakli-kombili-kacmaz-firsat-1340134786/detay',
    sample3: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-satilik-mustakil-genis-oturumlu-ev-1340100069/detay',
    missingOptional:
        'https://www.sahibinden.com/ilan/emlak-konut-satilik-t.basi_burgerking_civ_k.mutfak_d.gazli_genis_oturumlu_3-plus1-1340140183/detay',
    malformed:
        'https://www.sahibinden.com/ilan/emlak-konut-satilik-t.basi_burgerking_civ_k.mutfak_d.gazli_genis_oturumlu_3-plus1-1340140183/detay',
    unavailable: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-removed-listing-1340199999/detay',
} as const;

/** The sanitized "opened" phone rendering shared by all three real fixtures. */
const SANITIZED_PHONE = '0 (5XX) XXX XX XX';

interface ParsedFixture {
    raw: RawDetailPage;
    detail: ListingDetail;
    html: string;
}

let browser: Browser;
const cache = new Map<string, ParsedFixture>();

async function parseFixture(file: string, url: string): Promise<ParsedFixture> {
    const cached = cache.get(file);
    if (cached) return cached;

    const html = readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
    const withBase = html.replace(/<head>/i, '<head><base href="https://www.sahibinden.com/">');
    expect(withBase).not.toBe(html); // guard: <head> must exist in the fixture

    const page = await browser.newPage();
    try {
        await page.setContent(withBase, { waitUntil: 'domcontentloaded' });
        const raw = await page.evaluate(extractDetailRawInPage);
        const detail = normalizeDetail(raw, { url });
        const parsed: ParsedFixture = { raw, detail, html };
        cache.set(file, parsed);
        return parsed;
    } finally {
        await page.close();
    }
}

beforeAll(async () => {
    browser = await puppeteer.launch({
        headless: true,
        channel: 'chrome', // system Chrome (PUPPETEER_SKIP_DOWNLOAD env)
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
}, 60_000);

afterAll(async () => {
    await browser?.close();
});

// ---------------------------------------------------------------------------

describe('detail-sample-1 (real-estate office)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-sample-1.html', URLS.sample1);
    });

    it('satisfies the full ListingDetail contract', () => {
        assertListingDetailContract(p.detail, 'sample-1');
    });

    it('classifies the seller as REAL_ESTATE_OFFICE with the sanitized office name', () => {
        expect(p.detail.sellerType).toBe('REAL_ESTATE_OFFICE');
        expect(p.detail.officeName).toBe('TEST GAYRİMENKUL');
        expect(p.detail.sellerTypeEvidence).toContain('.user-info-store-card');
    });

    it('surfaces the sanitized rendered phone (masked "*"-rendering rejected)', () => {
        expect(p.detail.publicContactPhone).toBe(SANITIZED_PHONE);
    });

    it('keeps >15 raw attributes incl. Oda Sayısı, with normalized rooms/areas', () => {
        expect(Object.keys(p.detail.attributesRaw).length).toBeGreaterThan(15);
        expect(p.detail.attributesRaw['Oda Sayısı']).toBe('3+1');
        expect(p.detail.rooms).toBe('3+1');
        expect(p.detail.grossAreaM2).toBe(175);
        expect(p.detail.netAreaM2).toBe(120);
    });

    it('has a non-empty gallery with exactly one primary image', () => {
        expect(p.detail.images.length).toBeGreaterThan(0);
        expect(p.detail.images.filter(i => i.isPrimary)).toHaveLength(1);
        expect(p.detail.images[0]!.isPrimary).toBe(true);
    });

    it('parses the listing date to ISO', () => {
        expect(p.detail.listingDate).toBe('2026-09-14');
        expect(Number.isNaN(Date.parse(p.detail.listingDate as string))).toBe(false);
        expect(p.detail.listingDateRaw).toBe('14 Eylül 2026');
    });

    it('is not flagged unavailable', () => {
        expect(p.detail.unavailable).toBe(false);
        expect(isUnavailableDetailHtml(p.html)).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe('detail-sample-2 (real-estate office, full agent name)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-sample-2.html', URLS.sample2);
    });

    it('satisfies the full ListingDetail contract', () => {
        assertListingDetailContract(p.detail, 'sample-2');
    });

    it('classifies REAL_ESTATE_OFFICE with the full agent name resolved', () => {
        expect(p.detail.sellerType).toBe('REAL_ESTATE_OFFICE');
        expect(p.detail.officeName).toBe('TEST SATICI GAYRİMENKUL');
        // Fixture fact (detail-sample-2.html:4212): the agent name is a DIRECT
        // text node (<h3>Test Satıcı</h3>) — no CSS obfuscation on this one.
        expect(p.detail.sellerDisplayName).toBe('Test Satıcı');
        expect(p.raw.seller.agentName).toBe('Test Satıcı');
    });

    it('surfaces the sanitized phone (sticky data-opened wins over the landline)', () => {
        expect(p.detail.publicContactPhone).toBe(SANITIZED_PHONE);
    });

    it('is not flagged unavailable', () => {
        expect(p.detail.unavailable).toBe(false);
        expect(isUnavailableDetailHtml(p.html)).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe('detail-sample-3 (individual owner, CSS-obfuscated name/phone)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-sample-3.html', URLS.sample3);
    });

    it('satisfies the full ListingDetail contract', () => {
        assertListingDetailContract(p.detail, 'sample-3');
    });

    it('resolves the CSS-obfuscated owner name and classifies OWNER', () => {
        expect(p.detail.sellerType).toBe('OWNER');
        expect(p.detail.sellerDisplayName).toBe('Test Y.');
        expect(p.detail.officeName).toBeNull();
        expect(p.detail.sellerTypeEvidence).toContain('classified-owner-info');
        // Proof the name was NOT a DOM text node: the in-page extractor got it
        // from the css<uuid>:before content map.
        expect(p.raw.seller.individualName).toBe('Test Y.');
    });

    it('surfaces the sanitized phone; the masked rendering stays provenance-only', () => {
        expect(p.detail.publicContactPhone).toBe(SANITIZED_PHONE);
        const individual = p.raw.phones.find(c => c.source === 'phoneInfoPart');
        expect(individual?.dataEncrypted).toBe('0 (505) *** ** 50');
    });

    it('standalone buildCssContentMap/resolveObfuscatedText reproduce the fixture truths in-page', async () => {
        const page = await browser.newPage();
        try {
            const withBase = p.html.replace(/<head>/i, '<head><base href="https://www.sahibinden.com/">');
            await page.setContent(withBase, { waitUntil: 'domcontentloaded' });
            // page.evaluate(string) resolves unknown — the map is a plain
            // serializable Record<string, string> by construction.
            const cssMap = (await page.evaluate(`(${buildCssContentMap.toString()})(document)`)) as Record<
                string,
                string
            >;
            // Owner name: literal content variant (detail-sample-3.html:4099).
            expect(cssMap['cssb5dac265-388b-44f3-91db-c6483d816f18']).toBe('Test Y.');
            // Phone: attr(data-content) variant (detail-sample-3.html:4186).
            expect(cssMap['css2fb25844-155a-42c8-b534-83f6e5a1f2da']).toBe('attr(data-content)');

            const name = await page.evaluate(
                `(${resolveObfuscatedText.toString()})(document.querySelector('.username-info-area h5 span'), (${buildCssContentMap.toString()})(document))`,
            );
            expect(name).toBe('Test Y.');

            const phone = await page.evaluate(
                `(${resolveObfuscatedText.toString()})(document.querySelector('#phoneInfoPart .pretty-phone-part span'), (${buildCssContentMap.toString()})(document))`,
            );
            expect(phone).toBe(SANITIZED_PHONE);
        } finally {
            await page.close();
        }
    });

    it('is not flagged unavailable', () => {
        expect(p.detail.unavailable).toBe(false);
        expect(isUnavailableDetailHtml(p.html)).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe('detail-missing-optional (derived: 8 attribute rows + description removed)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-missing-optional.html', URLS.missingOptional);
    });

    it('does not throw and satisfies the full ListingDetail contract', () => {
        assertListingDetailContract(p.detail, 'missing-optional');
        expect(p.detail.unavailable).toBe(false);
    });

    it('omits the removed attributes from attributesRaw but keeps the rest intact', () => {
        const raw = p.detail.attributesRaw;
        // The 8 removed rows (README.md derivation recipe).
        for (const label of [
            'Banyo Sayısı',
            'Balkon',
            'Eşyalı',
            'Kullanım Durumu',
            'Aidat (TL)',
            'Krediye Uygun',
            'Tapu Durumu',
            'Takas',
        ]) {
            expect(raw[label], `attributesRaw must not contain removed label ${label}`).toBeUndefined();
        }
        // Remaining attributes survive untouched.
        expect(raw['Oda Sayısı']).toBe('3+1');
        expect(raw['Isıtma']).toBe('Kombi (Doğalgaz)');
        expect(raw['Kimden']).toBe('Emlak Ofisinden');
        expect(raw['İlan No']).toBe('1340140183');
    });

    it('normalizes the removed optional fields to null', () => {
        const d = p.detail;
        expect(d.bathroomCount).toBeNull();
        expect(d.balcony).toBeNull();
        expect(d.furnished).toBeNull();
        expect(d.usageStatus).toBeNull();
        expect(d.dues).toBeNull();
        expect(d.creditEligible).toBeNull();
        expect(d.deedStatus).toBeNull();
        expect(d.exchangeEligible).toBeNull();
        expect(d.description).toBe(''); // #classifiedDescription container removed
    });

    it('keeps the surviving normalized fields and the office classification', () => {
        expect(p.detail.rooms).toBe('3+1');
        expect(p.detail.grossAreaM2).toBe(175);
        expect(p.detail.price).toBe(4575000);
        expect(p.detail.sellerType).toBe('REAL_ESTATE_OFFICE');
    });
});

// ---------------------------------------------------------------------------

describe('detail-malformed (derived: broken price markup + missing title)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-malformed.html', URLS.malformed);
    });

    it('does not throw and satisfies the full ListingDetail contract', () => {
        assertListingDetailContract(p.detail, 'malformed');
        expect(p.detail.unavailable).toBe(false);
    });

    it('yields null price + empty title while attributesRaw survives as an object', () => {
        expect(p.detail.price).toBeNull();
        expect(p.detail.priceRaw).toBe('Fiyat bilgisi yok'); // raw text preserved
        expect(p.detail.currency).toBe('TL'); // contract quirk: TL default
        expect(p.detail.title).toBe('');
        expect(typeof p.detail.attributesRaw).toBe('object');
        expect(Object.keys(p.detail.attributesRaw).length).toBeGreaterThan(15);
    });

    it('fills gaps from the category context when provided (detail wins on conflict)', () => {
        const category: CategoryListing = {
            id: '1340140183',
            url: URLS.malformed,
            title: 'Kategori Başlığı',
            price: 4600000,
            price_currency: 'TL',
            price_raw: '4.600.000 TL',
            price_per_sqm: '',
            area: '175',
            location: 'Seyhan / Pınar',
            date: '14 Eylül 2026',
            image: null,
            scrapedAt: '2026-09-14T15:03:26.477Z',
            sourceUrl: 'https://www.sahibinden.com/satilik/adana-seyhan',
        };
        const d = normalizeDetail(p.raw, { url: URLS.malformed, category });
        assertListingDetailContract(d, 'malformed+category', { requireCategory: true });
        expect(d.price).toBe(4600000); // gap filled from category
        expect(d.title).toBe('Kategori Başlığı');
        expect(d.category?.id).toBe('1340140183');
    });
});

// ---------------------------------------------------------------------------

describe('detail-unavailable (synthesized removed-listing notice)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-unavailable.html', URLS.unavailable);
    });

    it('isUnavailableDetailHtml detects the notice page', () => {
        expect(isUnavailableDetailHtml(p.html)).toBe(true);
    });

    it('the in-page extractor flags it unavailable without attributes', () => {
        expect(p.raw.unavailable).toBe(true);
        expect(p.raw.attributes).toEqual([]);
    });

    it('normalizeDetail short-circuits to an unavailable record that still satisfies the contract', () => {
        const d = p.detail;
        assertListingDetailContract(d, 'unavailable');
        expect(d.unavailable).toBe(true);
        expect(d.title).toBe('');
        expect(d.price).toBeNull();
        expect(d.attributesRaw).toEqual({});
        expect(d.images).toEqual([]);
        expect(d.sellerType).toBe('UNKNOWN');
        expect(d.sellerTypeEvidence).toBeNull();
        expect(d.publicContactPhone).toBeNull();
        // Identity is still recovered from the URL.
        expect(d.listingId).toBe('1340199999');
        expect(d.sourceUrl).toBe(URLS.unavailable);
    });
});

// ---------------------------------------------------------------------------

describe('all detail fixtures (cross-cutting invariants)', () => {
    const ALL: Array<[string, string]> = [
        ['detail-sample-1.html', URLS.sample1],
        ['detail-sample-2.html', URLS.sample2],
        ['detail-sample-3.html', URLS.sample3],
        ['detail-missing-optional.html', URLS.missingOptional],
        ['detail-malformed.html', URLS.malformed],
        ['detail-unavailable.html', URLS.unavailable],
    ];

    it('every fixture extracts and normalizes without throwing, contract-valid', async () => {
        for (const [file, url] of ALL) {
            const p = await parseFixture(file, url);
            assertListingDetailContract(p.detail, file);
        }
    });

    it('attributesRaw is always a Record<string, string> (lossless raw survival)', async () => {
        for (const [file, url] of ALL) {
            const p = await parseFixture(file, url);
            expect(typeof p.detail.attributesRaw, `${file}: attributesRaw type`).toBe('object');
            for (const [k, v] of Object.entries(p.detail.attributesRaw)) {
                expect(typeof k, `${file}: key type`).toBe('string');
                expect(typeof v, `${file}: value type for ${k}`).toBe('string');
            }
        }
    });

    it('sellerTypeEvidence is consistent with sellerType (null iff UNKNOWN)', async () => {
        for (const [file, url] of ALL) {
            const p = await parseFixture(file, url);
            if (p.detail.sellerType === 'UNKNOWN') {
                expect(p.detail.sellerTypeEvidence, `${file}: evidence null when UNKNOWN`).toBeNull();
            } else {
                expect(p.detail.sellerTypeEvidence, `${file}: evidence present when classified`).not.toBeNull();
            }
        }
    });

    it('seller types across the fixture set cover OFFICE and OWNER', async () => {
        const types = new Set<string>();
        for (const [file, url] of ALL) {
            types.add((await parseFixture(file, url)).detail.sellerType);
        }
        expect(types.has('REAL_ESTATE_OFFICE')).toBe(true);
        expect(types.has('OWNER')).toBe(true);
        expect(types.has('UNKNOWN')).toBe(true); // the unavailable notice page
    });
});
