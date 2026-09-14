/**
 * Detail-parser fixture tests: run the REAL in-page extractor inside headless
 * Chrome (page.setContent of the sanitized fixtures) and the pure node-side
 * normalizer, pinning the ListingDetail contract per fixture type.
 *
 * Harness mirrors tests/regression/category-fixture-parse.test.ts:
 * - `channel: 'chrome'` (system Chrome; PUPPETEER_SKIP_DOWNLOAD env),
 * - a `<base href="https://www.sahibinden.com/">` injection so relative hrefs
 *   absolutize against the real origin (the page IS served from there in
 *   production; without it the page URL is about:blank).
 *
 * Phone expectation note: all fixtures are sanitized — the rendered "opened"
 * phone is the masked placeholder '0 (5XX) XXX XX XX'. The parser must surface
 * exactly that (never the '0 (5XX) *** ** XX' masked/encrypted rendering).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import type { CategoryListing, ListingDetail } from '@sahibindenbot/shared';
import {
    buildCssContentMap,
    extractDetailRawInPage,
    isUnavailableDetailHtml,
    normalizeDetail,
    resolveObfuscatedText,
    type RawDetailPage,
} from './index.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures/html');

const URLS = {
    sample1: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-t.basi_burgerking_civ_k.mutfak_d.gazli_genis_oturumlu_3-plus1-1340140183/detay',
    sample2: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-mavi-bulvar-da-kapali-mutfakli-kombili-kacmaz-firsat-1340134786/detay',
    sample3: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-satilik-mustakil-genis-oturumlu-ev-1340100069/detay',
    missingOptional: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-t.basi_burgerking_civ_k.mutfak_d.gazli_genis_oturumlu_3-plus1-1340140183/detay',
    malformed: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-t.basi_burgerking_civ_k.mutfak_d.gazli_genis_oturumlu_3-plus1-1340140183/detay',
    unavailable: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-removed-listing-1340199999/detay',
} as const;

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
        channel: 'chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
}, 60_000);

afterAll(async () => {
    await browser?.close();
});

/** Shared invariants for every non-unavailable detail fixture. */
function expectHealthyDetail(d: ListingDetail): void {
    expect(d.unavailable).toBe(false);
    expect(d.source).toBe('sahibinden.com');
    expect(d.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Object.keys(d.attributesRaw).length).toBeGreaterThan(0);
    expect(d.listingType).toBe('SALE'); // all fixtures are satılık
    expect(d.images.length).toBeGreaterThan(0);
    for (const [i, img] of d.images.entries()) {
        expect(img.position).toBe(i);
        expect(img.url).toMatch(/^https:\/\//);
    }
    expect(d.images.filter(i => i.isPrimary)).toHaveLength(1);
    expect(d.images[0]!.isPrimary).toBe(true);
}

// ---------------------------------------------------------------------------

describe('detail-sample-1 (real-estate office)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-sample-1.html', URLS.sample1);
    });

    it('extracts without crashing and satisfies the healthy invariants', () => {
        expectHealthyDetail(p.detail);
        expect(p.raw.attributes.length).toBeGreaterThan(15);
    });

    it('classifies the seller as REAL_ESTATE_OFFICE with selector evidence', () => {
        expect(p.detail.sellerType).toBe('REAL_ESTATE_OFFICE');
        expect(p.detail.officeName).toBe('TEST GAYRİMENKUL');
        expect(p.detail.sellerDisplayName).toBe('Test A.');
        expect(p.detail.sellerProfileUrl).toBe('https://testgayrimenkul.sahibinden.com');
        expect(p.detail.sellerTypeEvidence).toContain('.user-info-store-card');
        expect(p.detail.sellerTypeEvidence).toContain('TEST GAYRİMENKUL');
    });

    it('normalizes the core fields', () => {
        expect(p.detail.listingId).toBe('1340140183');
        expect(p.detail.canonicalUrl).toBe(URLS.sample1);
        expect(p.detail.title).toBe("T.BAŞI_BURGERKİNG_CİV_K.MUTFAK_D.GAZLI_GENİŞ_OTURUMLU_3+1...!");
        expect(p.detail.price).toBe(4575000);
        expect(p.detail.currency).toBe('TL');
        expect(p.detail.priceRaw).toBe('4.575.000 TL');
        expect(p.detail.description).toContain('DETAYLI BİLGİ');
    });

    it('maps the known Turkish attributes (raw values preserved)', () => {
        const d = p.detail;
        expect(d.grossAreaM2).toBe(175);
        expect(d.netAreaM2).toBe(120);
        expect(d.rooms).toBe('3+1');
        expect(d.buildingAge).toBe('6-10 arası');
        expect(d.floor).toBe('5');
        expect(d.totalFloors).toBe('7');
        expect(d.heating).toBe('Kombi (Doğalgaz)');
        expect(d.bathroomCount).toBe('1');
        expect(d.balcony).toBe('Var');
        expect(d.furnished).toBe('Hayır');
        expect(d.usageStatus).toBe('Boş');
        expect(d.insideSite).toBe('Hayır');
        expect(d.siteName).toBe('Belirtilmemiş');
        expect(d.dues).toBe('500'); // displayed label is 'Aidat (TL)'
        expect(d.creditEligible).toBe('Evet');
        expect(d.deedStatus).toBe('Kat Mülkiyetli');
        expect(d.exchangeEligible).toBe('Hayır');
    });

    it('keeps unmapped/unknown labels only in attributesRaw (lossless)', () => {
        expect(p.detail.attributesRaw['İlan No']).toBe('1340140183');
        expect(p.detail.attributesRaw['Emlak Tipi']).toBe('Satılık Daire');
        expect(p.detail.attributesRaw['Kimden']).toBe('Emlak Ofisinden');
        expect(p.detail.attributesRaw['Mutfak']).toBe('Kapalı');
        expect(p.detail.attributesRaw['Enerji Kimlik Belgesi']).toBe('C');
    });

    it('extracts the location hierarchy and dates', () => {
        expect(p.detail.province).toBe('Adana');
        expect(p.detail.district).toBe('Seyhan');
        expect(p.detail.neighborhood).toBe('Pınar Mh.');
        expect(p.detail.locationRaw).toBe('Adana / Seyhan / Pınar Mh.');
        expect(p.detail.listingDate).toBe('2026-09-14');
        expect(p.detail.listingDateRaw).toBe('14 Eylül 2026');
        expect(p.detail.updatedDate).toBeNull();
    });

    it('classifies property from the breadcrumb', () => {
        expect(p.detail.propertyCategory).toBe('Konut');
        expect(p.detail.propertySubtype).toBe('Daire');
    });

    it('surfaces the sanitized rendered phone (masked rejected)', () => {
        expect(p.detail.publicContactPhone).toBe('0 (5XX) XXX XX XX');
        // provenance: the sticky-header candidate carried both data-* forms
        const sticky = p.raw.phones.find(c => c.source === 'sticky-header-phone');
        expect(sticky?.dataEncrypted).toBe('0 (5XX) *** ** XX');
        expect(sticky?.dataOpened).toBe('0 (5XX) XXX XX XX');
    });

    it('collects the full gallery in order (59 photos, x5_ display size)', () => {
        expect(p.detail.images).toHaveLength(59);
        expect(p.detail.images[0]!.url).toBe('https://i0.shbdn.com/photos/14/01/83/x5_13401401838v0.jpg');
        expect(new Set(p.detail.images.map(i => i.url)).size).toBe(59);
    });

    it('has no video or virtual tour', () => {
        expect(p.detail.videoUrl).toBeNull();
        expect(p.detail.virtualTourUrl).toBeNull();
    });

    it('is not flagged unavailable', () => {
        expect(isUnavailableDetailHtml(p.html)).toBe(false);
        expect(p.raw.unavailable).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe('detail-sample-2 (real-estate office, full agent name)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-sample-2.html', URLS.sample2);
    });

    it('extracts without crashing and satisfies the healthy invariants', () => {
        expectHealthyDetail(p.detail);
    });

    it('classifies REAL_ESTATE_OFFICE with the full agent name', () => {
        expect(p.detail.sellerType).toBe('REAL_ESTATE_OFFICE');
        expect(p.detail.officeName).toBe('TEST SATICI GAYRİMENKUL');
        expect(p.detail.sellerDisplayName).toBe('Test Satıcı');
        expect(p.detail.sellerProfileUrl).toBe('https://testsatici.sahibinden.com');
        expect(p.detail.sellerTypeEvidence).toContain('TEST SATICI GAYRİMENKUL');
    });

    it('normalizes core + attribute fields', () => {
        expect(p.detail.listingId).toBe('1340134786');
        expect(p.detail.title).toBe("Mavi Bulvar'da Kapalı Mutfaklı Kombili KAÇMAZ FIRSAT");
        expect(p.detail.price).toBe(4150000);
        expect(p.detail.grossAreaM2).toBe(175);
        expect(p.detail.netAreaM2).toBe(125);
        expect(p.detail.floor).toBe('11');
        expect(p.detail.totalFloors).toBe('11');
        expect(p.detail.buildingAge).toBe('21-25 arası');
        expect(p.detail.neighborhood).toBe('Yeşilyurt Mh.');
        expect(p.detail.listingDate).toBe('2026-09-14');
    });

    it('phone: sticky data-opened wins over the visible landline (İş)', () => {
        // The main phone list renders a landline first ('0 (322) 201 09 09');
        // the contract picks the site's own opened contact-phone rendering.
        const mainList = p.raw.phones.filter(c => c.source === 'user-info-phones');
        expect(mainList.length).toBeGreaterThanOrEqual(2);
        expect(mainList[0]!.label).toBe('İş');
        expect(mainList[0]!.visibleText).toBe('0 (322) 201 09 09');
        expect(p.detail.publicContactPhone).toBe('0 (5XX) XXX XX XX');
    });

    it('collects the gallery (22 photos)', () => {
        expect(p.detail.images).toHaveLength(22);
        expect(p.detail.images[0]!.url).toBe('https://i0.shbdn.com/photos/13/47/86/x5_1340134786yjz.jpg');
    });

    it('is not flagged unavailable', () => {
        expect(isUnavailableDetailHtml(p.html)).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe('detail-sample-3 (individual owner, CSS-obfuscated name/phone)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-sample-3.html', URLS.sample3);
    });

    it('extracts without crashing and satisfies the healthy invariants', () => {
        expectHealthyDetail(p.detail);
    });

    it('resolves the CSS-obfuscated owner name and classifies OWNER', () => {
        expect(p.detail.sellerType).toBe('OWNER');
        expect(p.detail.sellerDisplayName).toBe('Test Y.'); // rendered only via CSS :before content
        expect(p.detail.officeName).toBeNull();
        expect(p.detail.sellerProfileUrl).toBeNull();
        expect(p.detail.sellerTypeEvidence).toContain('classified-owner-info');
        expect(p.detail.sellerTypeEvidence).toContain('Test Y.');
        // raw-level proof: the name was NOT a DOM text node
        expect(p.raw.seller.individualName).toBe('Test Y.');
        expect(p.detail.attributesRaw['Kimden']).toBe('Sahibinden');
    });

    it('resolves the obfuscated phone rendering (attr(data-content) variant)', () => {
        expect(p.detail.publicContactPhone).toBe('0 (5XX) XXX XX XX');
        // the masked rendering is kept as provenance, never surfaced
        const individual = p.raw.phones.find(c => c.source === 'phoneInfoPart');
        expect(individual?.dataEncrypted).toBe('0 (505) *** ** 50');
    });

    it('standalone obfuscation helpers agree with the in-page copies', () => {
        // Functional drift pin: run the EXPORTED helpers in-page via source
        // injection and assert the same fixture truths the extractor asserted.
        // (textual identity is impossible — esbuild renames shadowed bindings)
        expect(typeof buildCssContentMap).toBe('function');
        expect(typeof resolveObfuscatedText).toBe('function');
    });

    it('standalone helpers produce the fixture truths when injected in-page', async () => {
        const page = await browser.newPage();
        try {
            const withBase = p.html.replace(/<head>/i, '<head><base href="https://www.sahibinden.com/">');
            await page.setContent(withBase, { waitUntil: 'domcontentloaded' });
            // page.evaluate(string) resolves unknown — the map is a plain
            // serializable Record<string, string> by construction.
            const cssMap = (await page.evaluate(`(${buildCssContentMap.toString()})(document)`)) as Record<string, string>;
            expect(cssMap['cssb5dac265-388b-44f3-91db-c6483d816f18']).toBe('Test Y.');
            expect(cssMap['css2fb25844-155a-42c8-b534-83f6e5a1f2da']).toBe('attr(data-content)');

            const name = await page.evaluate(
                `(${resolveObfuscatedText.toString()})(document.querySelector('.username-info-area h5 span'), (${buildCssContentMap.toString()})(document))`,
            );
            expect(name).toBe('Test Y.');

            const phone = await page.evaluate(
                `(${resolveObfuscatedText.toString()})(document.querySelector('#phoneInfoPart .pretty-phone-part span'), (${buildCssContentMap.toString()})(document))`,
            );
            expect(phone).toBe('0 (5XX) XXX XX XX');
        } finally {
            await page.close();
        }
    });

    it('normalizes core fields and the Müstakil Ev subtype', () => {
        expect(p.detail.listingId).toBe('1340100069');
        expect(p.detail.title).toBe('SATİLİK MUSTAKİL GENİS OTURUMLU EV');
        expect(p.detail.price).toBe(21000000);
        expect(p.detail.grossAreaM2).toBe(170);
        expect(p.detail.netAreaM2).toBe(155);
        expect(p.detail.bathroomCount).toBe('2');
        expect(p.detail.propertyCategory).toBe('Konut');
        expect(p.detail.propertySubtype).toBe('Müstakil Ev');
        expect(p.detail.province).toBe('Adana');
        expect(p.detail.district).toBe('Seyhan');
        expect(p.detail.neighborhood).toBe('Barış Mh.');
    });

    it('extracts the video URL from JSON-LD VideoObject', () => {
        expect(p.detail.videoUrl).toBe(
            'https://sahibinden-vod2.mncdn.com/DSYaBF/sd/smil:1340100069_8jkkhy51475_hls.smil/playlist.m3u8',
        );
        expect(p.detail.virtualTourUrl).toBeNull();
    });

    it('collects the gallery (20 photos)', () => {
        expect(p.detail.images).toHaveLength(20);
        expect(p.detail.images[0]!.url).toBe('https://i0.shbdn.com/photos/10/00/69/x5_1340100069c02.jpg');
    });

    it('is not flagged unavailable', () => {
        expect(isUnavailableDetailHtml(p.html)).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe('detail-missing-optional (derived: 8 attribute rows + description removed)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-missing-optional.html', URLS.missingOptional);
    });

    it('does not crash and keeps the remaining attributesRaw intact', () => {
        expectHealthyDetail(p.detail);
        expect(p.detail.attributesRaw['Oda Sayısı']).toBe('3+1');
        expect(p.detail.attributesRaw['Isıtma']).toBe('Kombi (Doğalgaz)');
        expect(p.detail.attributesRaw['Kimden']).toBe('Emlak Ofisinden');
        expect(p.detail.attributesRaw['Balkon']).toBeUndefined();
        expect(p.detail.attributesRaw['Aidat (TL)']).toBeUndefined();
    });

    it('removed optional fields normalize to null', () => {
        const d = p.detail;
        expect(d.bathroomCount).toBeNull();
        expect(d.balcony).toBeNull();
        expect(d.furnished).toBeNull();
        expect(d.usageStatus).toBeNull();
        expect(d.dues).toBeNull();
        expect(d.creditEligible).toBeNull();
        expect(d.deedStatus).toBeNull();
        expect(d.exchangeEligible).toBeNull();
        expect(d.description).toBe('');
    });

    it('kept fields still normalize', () => {
        expect(p.detail.rooms).toBe('3+1');
        expect(p.detail.grossAreaM2).toBe(175);
        expect(p.detail.heating).toBe('Kombi (Doğalgaz)');
        expect(p.detail.price).toBe(4575000);
        expect(p.detail.sellerType).toBe('REAL_ESTATE_OFFICE'); // store card untouched
    });
});

// ---------------------------------------------------------------------------

describe('detail-malformed (derived: broken price markup + missing title)', () => {
    let p: ParsedFixture;
    beforeAll(async () => {
        p = await parseFixture('detail-malformed.html', URLS.malformed);
    });

    it('does not crash; null price, empty title, attributes survive', () => {
        expect(p.detail.unavailable).toBe(false);
        expect(p.detail.price).toBeNull();
        expect(p.detail.priceRaw).toBe('Fiyat bilgisi yok'); // raw preserved
        expect(p.detail.currency).toBe('TL'); // contract quirk: TL default
        expect(p.detail.title).toBe('');
        expect(Object.keys(p.detail.attributesRaw).length).toBeGreaterThan(15);
        expect(p.detail.images).toHaveLength(59); // gallery untouched
    });

    it('category ctx fills the gaps the broken page left', () => {
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

    it('the in-page extractor flags it unavailable', () => {
        expect(p.raw.unavailable).toBe(true);
        expect(p.raw.unavailableText).toBe('yayından kaldırıl');
        expect(p.raw.attributes).toEqual([]);
    });

    it('normalizeDetail short-circuits to the unavailable record', () => {
        const d = p.detail;
        expect(d.unavailable).toBe(true);
        expect(d.title).toBe('');
        expect(d.description).toBe('');
        expect(d.price).toBeNull();
        expect(d.attributesRaw).toEqual({});
        expect(d.images).toEqual([]);
        expect(d.sellerType).toBe('UNKNOWN');
        expect(d.sellerTypeEvidence).toBeNull();
        expect(d.publicContactPhone).toBeNull();
        // identity still recovered from the URL
        expect(d.listingId).toBe('1340199999');
        expect(d.listingType).toBe('SALE');
        expect(d.sourceUrl).toBe(URLS.unavailable);
    });
});
