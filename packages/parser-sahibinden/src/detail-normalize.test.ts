/**
 * Pure-node unit tests for the detail normalizer: attribute record building,
 * evidence-based seller classification, public-phone selection (masked
 * rejected), listing-type/property classification, category merge semantics,
 * the unavailable short-circuit, and never-throw robustness.
 *
 * Also pins the in-page extractor's self-containment: the inner helper copies
 * must stay identical to the exported standalones (page.evaluate serializes
 * the function source — a drift here would silently break in-browser runs).
 */
import { describe, expect, it } from 'vitest';
import type { CategoryListing } from '@sahibindenbot/shared';
import {
    buildCssContentMap,
    extractDetailRawInPage,
    resolveObfuscatedText,
    type RawDetailPage,
    type RawPhoneCandidate,
    type RawSellerInfo,
} from './detail-page.js';
import {
    buildAttributesRaw,
    classifyListingType,
    classifyProperty,
    classifySeller,
    normalizeDetail,
    pickPublicContactPhone,
} from './detail-normalize.js';

const DETAIL_URL = 'https://www.sahibinden.com/ilan/emlak-konut-satilik-test-1340140183/detay';

function emptySeller(overrides: Partial<RawSellerInfo> = {}): RawSellerInfo {
    return {
        officeName: null,
        officeProfileUrl: null,
        agentName: null,
        individualName: null,
        registrationText: null,
        hasStoreCard: false,
        hasIndividualBlock: false,
        evidenceSelectors: [],
        ...overrides,
    };
}

function makeRaw(overrides: Partial<RawDetailPage> = {}): RawDetailPage {
    return {
        pageUrl: DETAIL_URL,
        title: 'Test İlanı',
        priceText: '4.575.000 TL',
        descriptionText: 'Açıklama metni',
        listingId: '1340140183',
        canonicalUrl: DETAIL_URL,
        attributes: [
            { label: 'İlan No', value: '1340140183' },
            { label: 'İlan Tarihi', value: '14 Eylül 2026' },
            { label: 'Emlak Tipi', value: 'Satılık Daire' },
            { label: 'Oda Sayısı', value: '3+1' },
            { label: 'm² (Brüt)', value: '175' },
            { label: 'm² (Net)', value: '120' },
            { label: 'Aidat (TL)', value: '500' },
            { label: 'Mutfak', value: 'Kapalı' }, // unmapped — attributesRaw only
        ],
        breadcrumb: ['Emlak', 'Konut', 'Satılık', 'Daire', 'Adana', 'Seyhan', 'Pınar Mh.'],
        addressParts: ['Adana', 'Seyhan', 'Pınar Mh.'],
        seller: emptySeller(),
        phones: [],
        images: ['https://i0.shbdn.com/photos/14/01/83/x5_13401401838v0.jpg'],
        videoUrl: null,
        virtualTourUrl: null,
        unavailable: false,
        unavailableText: null,
        ...overrides,
    };
}

function makeCategory(overrides: Partial<CategoryListing> = {}): CategoryListing {
    return {
        id: '1340140183',
        url: DETAIL_URL,
        title: 'Kategori Başlığı',
        price: 9999999,
        price_currency: 'TL',
        price_raw: '9.999.999 TL',
        price_per_sqm: '59.363 TL/m²',
        area: '80',
        location: 'Seyhan / Pınar',
        date: '10 Eylül 2026',
        image: 'https://i0.shbdn.com/photos/49/16/28/lthmb_13401401836fx.jpg',
        scrapedAt: '2026-09-14T15:03:26.477Z',
        sourceUrl: 'https://www.sahibinden.com/satilik/adana-seyhan',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------

describe('buildAttributesRaw', () => {
    it('keeps every pair in display order and suffixes duplicates', () => {
        const raw = buildAttributesRaw([
            { label: 'Oda Sayısı', value: '3+1' },
            { label: 'Balkon', value: 'Var' },
            { label: 'Oda Sayısı', value: '4+1' },
            { label: 'Oda Sayısı', value: '5+1' },
        ]);
        expect(raw).toEqual({
            'Oda Sayısı': '3+1',
            'Balkon': 'Var',
            'Oda Sayısı (2)': '4+1',
            'Oda Sayısı (3)': '5+1',
        });
    });

    it('skips empty labels but keeps empty values', () => {
        const raw = buildAttributesRaw([
            { label: '', value: 'orphan' },
            { label: 'Balkon', value: '' },
        ]);
        expect(raw).toEqual({ Balkon: '' });
    });
});

// ---------------------------------------------------------------------------

describe('classifySeller (evidence-based)', () => {
    it('store block + office name → REAL_ESTATE_OFFICE with selector+name evidence', () => {
        const r = classifySeller(
            emptySeller({
                hasStoreCard: true,
                officeName: 'TEST GAYRİMENKUL',
                evidenceSelectors: ['.user-info-store-card'],
            }),
            { 'Kimden': 'Emlak Ofisinden' },
        );
        expect(r.sellerType).toBe('REAL_ESTATE_OFFICE');
        expect(r.evidence).toContain('.user-info-store-card');
        expect(r.evidence).toContain('TEST GAYRİMENKUL');
        expect(r.evidence).toContain('Emlak Ofisinden');
    });

    it("office name containing 'İnşaat' → CONSTRUCTION_COMPANY with explicit evidence", () => {
        const r = classifySeller(
            emptySeller({
                hasStoreCard: true,
                officeName: 'TEST İNŞAAT GAYRİMENKUL',
                evidenceSelectors: ['.user-info-store-card'],
            }),
            {},
        );
        expect(r.sellerType).toBe('CONSTRUCTION_COMPANY');
        expect(r.evidence).toContain('İnşaat');
    });

    it('individual block → OWNER with evidence', () => {
        const r = classifySeller(
            emptySeller({
                hasIndividualBlock: true,
                individualName: 'Test Y.',
                evidenceSelectors: ['.classifiedUserBox.classified-owner-info', '.sticky-header-indivudial-name'],
            }),
            { 'Kimden': 'Sahibinden' },
        );
        expect(r.sellerType).toBe('OWNER');
        expect(r.evidence).toContain('classified-owner-info');
        expect(r.evidence).toContain('Test Y.');
    });

    it("Kimden='Sahibinden' alone → OWNER (attribute evidence)", () => {
        const r = classifySeller(emptySeller(), { 'Kimden': 'Sahibinden' });
        expect(r.sellerType).toBe('OWNER');
        expect(r.evidence).toBe('attribute Kimden="Sahibinden"');
    });

    it("Kimden='Emlak Ofisinden' alone → REAL_ESTATE_OFFICE (attribute evidence)", () => {
        const r = classifySeller(emptySeller(), { 'Kimden': 'Emlak Ofisinden' });
        expect(r.sellerType).toBe('REAL_ESTATE_OFFICE');
        expect(r.evidence).toBe('attribute Kimden="Emlak Ofisinden"');
    });

    it("Kimden mentioning inşaat alone → CONSTRUCTION_COMPANY (attribute evidence)", () => {
        const r = classifySeller(emptySeller(), { 'Kimden': 'İnşaat Firmasından' });
        expect(r.sellerType).toBe('CONSTRUCTION_COMPANY');
    });

    it('no signals → UNKNOWN with null evidence (never guesses)', () => {
        const r = classifySeller(emptySeller(), {});
        expect(r.sellerType).toBe('UNKNOWN');
        expect(r.evidence).toBeNull();
    });
});

// ---------------------------------------------------------------------------

describe('pickPublicContactPhone', () => {
    const sticky: RawPhoneCandidate = {
        source: 'sticky-header-phone',
        label: null,
        visibleText: '0 (5XX) XXX XX XX',
        dataOpened: '0 (5XX) XXX XX XX',
        dataEncrypted: '0 (5XX) *** ** XX',
    };

    it('prefers the sticky-header data-opened rendering', () => {
        const phones: RawPhoneCandidate[] = [
            { source: 'user-info-phones', label: 'İş', visibleText: '0 (322) 201 09 09', dataOpened: null, dataEncrypted: null },
            sticky,
        ];
        expect(pickPublicContactPhone(phones)).toBe('0 (5XX) XXX XX XX');
    });

    it("prefers the 'Cep'-labeled entry within the main phone list", () => {
        const phones: RawPhoneCandidate[] = [
            { source: 'user-info-phones', label: 'İş', visibleText: '0 (322) 201 09 09', dataOpened: null, dataEncrypted: null },
            { source: 'user-info-phones', label: 'Cep', visibleText: '0 (5XX) XXX XX XX', dataOpened: null, dataEncrypted: null },
        ];
        expect(pickPublicContactPhone(phones)).toBe('0 (5XX) XXX XX XX');
    });

    it('masked-only candidates (data-encrypted, no data-opened) → null', () => {
        const phones: RawPhoneCandidate[] = [
            { source: 'sticky-header-phone', label: null, visibleText: null, dataOpened: null, dataEncrypted: '0 (5XX) *** ** XX' },
        ];
        expect(pickPublicContactPhone(phones)).toBeNull();
    });

    it("rejects '*'-containing visible text (masked rendering)", () => {
        const phones: RawPhoneCandidate[] = [
            { source: 'phoneInfoPart', label: 'Cep', visibleText: '0 (505) *** ** 50', dataOpened: null, dataEncrypted: null },
        ];
        expect(pickPublicContactPhone(phones)).toBeNull();
    });

    it('returns null for an empty candidate list', () => {
        expect(pickPublicContactPhone([])).toBeNull();
    });
});

// ---------------------------------------------------------------------------

describe('classifyListingType', () => {
    it("URL containing 'satilik' → SALE, 'kiralik' → RENT", () => {
        expect(classifyListingType('https://www.sahibinden.com/ilan/emlak-konut-satilik-x-12345678/detay', [])).toBe('SALE');
        expect(classifyListingType('https://www.sahibinden.com/ilan/emlak-konut-kiralik-x-12345678/detay', [])).toBe('RENT');
    });

    it('falls back to the breadcrumb marker when the URL is uninformative', () => {
        expect(classifyListingType('https://example.com/detail', ['Emlak', 'Konut', 'Kiralık', 'Daire'])).toBe('RENT');
    });

    it('no signal → UNKNOWN', () => {
        expect(classifyListingType('https://example.com/detail', [])).toBe('UNKNOWN');
        expect(classifyListingType(null, [])).toBe('UNKNOWN');
    });
});

describe('classifyProperty', () => {
    it("breadcrumb 'Emlak > Konut > Satılık > Daire > …' → Konut / Daire", () => {
        const r = classifyProperty(['Emlak', 'Konut', 'Satılık', 'Daire', 'Adana'], null);
        expect(r.propertyCategory).toBe('Konut');
        expect(r.propertySubtype).toBe('Daire');
    });

    it("falls back to 'Emlak Tipi' attribute for the subtype", () => {
        const r = classifyProperty([], 'Satılık Müstakil Ev');
        expect(r.propertyCategory).toBeNull();
        expect(r.propertySubtype).toBe('Müstakil Ev');
    });

    it('non-Emlak breadcrumb → nulls', () => {
        const r = classifyProperty(['Vasıta', 'Otomobil'], null);
        expect(r.propertyCategory).toBeNull();
        expect(r.propertySubtype).toBeNull();
    });
});

// ---------------------------------------------------------------------------

describe('normalizeDetail', () => {
    it('maps a full raw payload onto the ListingDetail contract', () => {
        const d = normalizeDetail(makeRaw(), { url: DETAIL_URL });
        expect(d.listingId).toBe('1340140183');
        expect(d.canonicalUrl).toBe(DETAIL_URL);
        expect(d.source).toBe('sahibinden.com');
        expect(d.sourceUrl).toBe(DETAIL_URL);
        expect(d.title).toBe('Test İlanı');
        expect(d.description).toBe('Açıklama metni');
        expect(d.price).toBe(4575000);
        expect(d.currency).toBe('TL');
        expect(d.priceRaw).toBe('4.575.000 TL');
        expect(d.listingType).toBe('SALE');
        expect(d.propertyCategory).toBe('Konut');
        expect(d.propertySubtype).toBe('Daire');
        expect(d.grossAreaM2).toBe(175);
        expect(d.netAreaM2).toBe(120);
        expect(d.rooms).toBe('3+1');
        expect(d.dues).toBe('500'); // 'Aidat (TL)' label maps to dues
        expect(d.province).toBe('Adana');
        expect(d.district).toBe('Seyhan');
        expect(d.neighborhood).toBe('Pınar Mh.');
        expect(d.locationRaw).toBe('Adana / Seyhan / Pınar Mh.');
        expect(d.listingDate).toBe('2026-09-14');
        expect(d.listingDateRaw).toBe('14 Eylül 2026');
        expect(d.updatedDate).toBeNull();
        expect(d.sellerType).toBe('UNKNOWN'); // no seller signals in makeRaw
        expect(d.sellerTypeEvidence).toBeNull();
        expect(d.images).toEqual([
            { url: 'https://i0.shbdn.com/photos/14/01/83/x5_13401401838v0.jpg', position: 0, isPrimary: true },
        ]);
        expect(d.unavailable).toBe(false);
        // unknown labels survive ONLY in attributesRaw
        expect(d.attributesRaw['Mutfak']).toBe('Kapalı');
        expect(d.attributesRaw['İlan No']).toBe('1340140183');
        expect(Object.keys(d)).not.toContain('Mutfak');
    });

    it('derives pricePerSquareMeter from price/grossAreaM2 when not displayed', () => {
        const d = normalizeDetail(makeRaw(), { url: DETAIL_URL });
        expect(d.pricePerSquareMeter).toBe(Math.round(4575000 / 175));
    });

    it('merge: category fills gaps when the detail page lacks values', () => {
        const raw = makeRaw({
            title: null,
            priceText: null,
            addressParts: [],
            images: [],
            attributes: [], // no 'İlan Tarihi' either → category date fills
        });
        const d = normalizeDetail(raw, { url: DETAIL_URL, category: makeCategory() });
        expect(d.title).toBe('Kategori Başlığı');
        expect(d.price).toBe(9999999);
        expect(d.priceRaw).toBe('9.999.999 TL');
        expect(d.locationRaw).toBe('Seyhan / Pınar');
        expect(d.listingDateRaw).toBe('10 Eylül 2026');
        expect(d.listingDate).toBe('2026-09-10');
        expect(d.images).toEqual([
            { url: 'https://i0.shbdn.com/photos/49/16/28/lthmb_13401401836fx.jpg', position: 0, isPrimary: true },
        ]);
        expect(d.category).toBeDefined();
        expect(d.category!.id).toBe('1340140183');
        // category's displayed price_per_sqm is used when present
        expect(d.pricePerSquareMeter).toBe(59363);
    });

    it('merge: detail values WIN on conflict with the category row', () => {
        const d = normalizeDetail(makeRaw(), { url: DETAIL_URL, category: makeCategory() });
        expect(d.price).toBe(4575000); // detail price, not category's 9999999
        expect(d.title).toBe('Test İlanı');
    });

    it('unavailable raw → minimal record with unavailable=true', () => {
        const d = normalizeDetail(
            makeRaw({ unavailable: true, unavailableText: 'yayından kaldırıl' }),
            { url: DETAIL_URL, category: makeCategory() },
        );
        expect(d.unavailable).toBe(true);
        expect(d.title).toBe('');
        expect(d.price).toBeNull();
        expect(d.attributesRaw).toEqual({});
        expect(d.images).toEqual([]);
        expect(d.sellerType).toBe('UNKNOWN');
        expect(d.sellerTypeEvidence).toBeNull();
        expect(d.listingId).toBe('1340140183'); // identity still extracted
        expect(d.listingType).toBe('SALE'); // from the URL
        expect(d.category).toBeDefined();
    });

    it('seller fields populate per classification', () => {
        const office = normalizeDetail(
            makeRaw({
                seller: emptySeller({
                    hasStoreCard: true,
                    officeName: 'TEST GAYRİMENKUL',
                    officeProfileUrl: 'https://testgayrimenkul.sahibinden.com',
                    agentName: 'Test A.',
                    evidenceSelectors: ['.user-info-store-card'],
                }),
            }),
            { url: DETAIL_URL },
        );
        expect(office.sellerType).toBe('REAL_ESTATE_OFFICE');
        expect(office.sellerDisplayName).toBe('Test A.');
        expect(office.officeName).toBe('TEST GAYRİMENKUL');
        expect(office.sellerProfileUrl).toBe('https://testgayrimenkul.sahibinden.com');

        const owner = normalizeDetail(
            makeRaw({
                seller: emptySeller({
                    hasIndividualBlock: true,
                    individualName: 'Test Y.',
                    evidenceSelectors: ['.classifiedUserBox.classified-owner-info'],
                }),
            }),
            { url: DETAIL_URL },
        );
        expect(owner.sellerType).toBe('OWNER');
        expect(owner.sellerDisplayName).toBe('Test Y.');
        expect(owner.officeName).toBeNull();
        expect(owner.sellerProfileUrl).toBeNull();
    });

    it('never throws on a gutted/malformed raw payload', () => {
        // Deliberately broken payload: arrays/objects replaced by garbage.
        // Justified cast: robustness test simulates a corrupted evaluate result.
        const garbage = {
            attributes: null,
            breadcrumb: undefined,
            addressParts: 'not-an-array',
            phones: [null, { source: 42 }],
            images: null,
            seller: undefined,
        } as unknown as RawDetailPage;
        const d = normalizeDetail(garbage, { url: DETAIL_URL });
        expect(d.unavailable).toBe(false);
        expect(d.attributesRaw).toEqual({});
        expect(d.images).toEqual([]);
        expect(d.listingId).toBe('1340140183'); // URL regex fallback
        expect(d.sellerType).toBe('UNKNOWN');
    });
});

// ---------------------------------------------------------------------------

describe('in-page extractor self-containment', () => {
    // NOTE: extractDetailRawInPage carries INNER copies of the exported
    // buildCssContentMap/resolveObfuscatedText (page.evaluate serialization
    // makes module-scope functions unreachable in the browser). A textual
    // identity test is impossible — esbuild renames shadowing identifiers —
    // so drift is pinned FUNCTIONALLY instead: detail-fixtures.test.ts runs
    // the standalones in-browser (via source injection) and asserts the same
    // fixture truths the extractor path asserts. Here we pin that the inner
    // obfuscation machinery exists at all (distinctive regex + attr support).
    it('extractor source embeds the CSS-obfuscation machinery', () => {
        const src = extractDetailRawInPage.toString();
        expect(src).toContain('before');
        expect(src).toContain('content');
        expect(src).toContain('attr\\('); // regex-escaped in the content-rule pattern
        expect(src).toMatch(/css\[/); // the css-class regex fragment
        expect(buildCssContentMap.toString()).toMatch(/css\[/);
        expect(resolveObfuscatedText.toString()).toContain('attr\\(');
    });
});
