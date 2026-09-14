/**
 * Detail-page parser — pure Node-side normalization half.
 *
 * `normalizeDetail(raw, ctx)` maps the in-browser RawDetailPage payload onto
 * the FROZEN ListingDetail contract (packages/shared/src/types.ts). It is
 * pure and deterministic except `scrapedAt` (extraction timestamp).
 *
 * Design rules (task contract):
 * - attributesRaw keeps EVERY displayed label/value pair (lossless); known
 *   Turkish labels are ADDITIONALLY mapped onto typed fields; unknown labels
 *   remain ONLY in attributesRaw.
 * - Seller classification is evidence-based: a matched selector / attribute
 *   is recorded in sellerTypeEvidence; without evidence → UNKNOWN + null.
 * - publicContactPhone comes ONLY from already-rendered DOM text or
 *   data-opened attributes; masked ('*'-containing) values are rejected.
 * - Category-row data (ctx.category) fills gaps; detail values win conflicts.
 * - Missing/malformed optional fields NEVER throw — worst case null/empty.
 */
import type { CategoryListing, ListingDetail, ListingImage, SellerType } from '@sahibindenbot/shared';
import type { RawDetailAttribute, RawDetailPage, RawPhoneCandidate } from './detail-page.js';
import { parseTrNumber, parseTurkishDate, trLower } from './tr-text.js';
import { extractCurrency, extractListingId, formatPrice, normalizeText } from './utils.js';

/** Context for normalization: the detail page URL + optional category-row data. */
export interface NormalizeDetailContext {
    /** The detail page URL (request URL — authoritative source identity). */
    url: string;
    /** Category-row discovery data when the detail was reached via a category. */
    category?: CategoryListing;
}

// ---------------------------------------------------------------------------
// Known Turkish attribute labels → ListingDetail fields
// ---------------------------------------------------------------------------

/**
 * Exact displayed labels (whitespace-normalized) → ListingDetail field.
 * Only labels verified in the sanitized fixtures or named in the task
 * contract are mapped; everything else stays exclusively in attributesRaw.
 * 'Aidat (TL)' is the fixture-observed rendering of the 'Aidat' label
 * (detail-sample-1.html:4607) — both keys map to `dues`.
 */
const KNOWN_ATTRIBUTE_MAP = {
    'Oda Sayısı': 'rooms',
    'm² (Brüt)': 'grossAreaM2',
    'm² (Net)': 'netAreaM2',
    'Bina Yaşı': 'buildingAge',
    'Bulunduğu Kat': 'floor',
    'Kat Sayısı': 'totalFloors',
    'Isıtma': 'heating',
    'Banyo Sayısı': 'bathroomCount',
    'Balkon': 'balcony',
    'Eşyalı': 'furnished',
    'Kullanım Durumu': 'usageStatus',
    'Site İçerisinde': 'insideSite',
    'Site Adı': 'siteName',
    'Aidat': 'dues',
    'Aidat (TL)': 'dues',
    'Depozito': 'deposit',
    'Tapu Durumu': 'deedStatus',
    'Krediye Uygun': 'creditEligible',
    'Takas': 'exchangeEligible',
    'İlan Tarihi': 'listingDateRaw',
    'Güncelleme Tarihi': 'updatedDateRaw',
    'Son Güncelleme': 'updatedDateRaw',
} as const satisfies Record<string, keyof ListingDetail>;

type KnownLabel = keyof typeof KNOWN_ATTRIBUTE_MAP;

/** Fields that parse to numbers (TR formats); everything else stays a string. */
const NUMERIC_ATTRIBUTE_FIELDS: ReadonlySet<string> = new Set(['grossAreaM2', 'netAreaM2']);

/**
 * Maps known Turkish labels onto ListingDetail fields (single source of
 * truth: KNOWN_ATTRIBUTE_MAP). Unknown labels are never mapped — they remain
 * exclusively in attributesRaw. When two labels alias the same field
 * ('Aidat'/'Aidat (TL)', 'Güncelleme Tarihi'/'Son Güncelleme'), the earlier
 * map entry wins. Empty rendered values map to "absent" (null downstream).
 */
export function mapKnownAttributes(attributesRaw: Record<string, string>): Partial<ListingDetail> {
    const out: Partial<ListingDetail> = {};
    for (const [label, field] of Object.entries(KNOWN_ATTRIBUTE_MAP) as Array<[KnownLabel, keyof ListingDetail]>) {
        const value = attributesRaw[label];
        if (value === undefined || value === '') continue;
        if (out[field] !== undefined && out[field] !== null) continue; // first label wins
        // Writing via a string key loses the per-field type; the map's
        // `satisfies Record<string, keyof ListingDetail>` already constrains
        // WHICH keys are writable, and NUMERIC_ATTRIBUTE_FIELDS decides the
        // value type. Justified cast — the public result stays fully typed.
        const target = out as Record<string, unknown>;
        target[field] = NUMERIC_ATTRIBUTE_FIELDS.has(field) ? parseTrNumber(value) : value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// attributesRaw
// ---------------------------------------------------------------------------

/**
 * Builds the lossless attributesRaw record from ordered pairs. Duplicate
 * labels are suffixed ' (2)', ' (3)', … so nothing displayed is lost.
 */
export function buildAttributesRaw(attributes: readonly RawDetailAttribute[]): Record<string, string> {
    const out: Record<string, string> = {};
    const seen = new Map<string, number>();
    for (const { label, value } of attributes) {
        if (!label) continue;
        const count = (seen.get(label) ?? 0) + 1;
        seen.set(label, count);
        out[count === 1 ? label : `${label} (${count})`] = value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Seller classification (evidence-based; never guesses)
// ---------------------------------------------------------------------------

export interface SellerClassification {
    sellerType: SellerType;
    /** Human-readable evidence (selector/attribute that drove the decision). */
    evidence: string | null;
}

/**
 * Classifies the seller from raw page signals. Precedence:
 *   1. store/office block rendered → REAL_ESTATE_OFFICE
 *      (office name containing 'İnşaat' → CONSTRUCTION_COMPANY, explicit evidence);
 *   2. individual-owner block rendered → OWNER;
 *   3. 'Kimden' attribute alone → OWNER / REAL_ESTATE_OFFICE / CONSTRUCTION_COMPANY;
 *   4. otherwise UNKNOWN with null evidence.
 */
export function classifySeller(raw: RawDetailPage['seller'], attributesRaw: Record<string, string>): SellerClassification {
    const kimden = attributesRaw['Kimden'] ?? null;
    const kimdenSuffix = kimden !== null ? `; Kimden="${kimden}"` : '';

    if (raw.hasStoreCard) {
        const where = raw.evidenceSelectors.join(', ');
        const office = raw.officeName ?? '';
        if (office !== '' && trLower(office).includes('inşaat')) {
            return {
                sellerType: 'CONSTRUCTION_COMPANY',
                evidence: `store block (${where}) → office "${office}" contains 'İnşaat'${kimdenSuffix}`,
            };
        }
        return {
            sellerType: 'REAL_ESTATE_OFFICE',
            evidence: `store block (${where})${office !== '' ? ` → office "${office}"` : ''}${kimdenSuffix}`,
        };
    }

    if (raw.hasIndividualBlock) {
        const where = raw.evidenceSelectors.join(', ');
        return {
            sellerType: 'OWNER',
            evidence: `individual block (${where})${raw.individualName ? ` → "${raw.individualName}"` : ''}${kimdenSuffix}`,
        };
    }

    if (kimden !== null && kimden !== '') {
        const k = trLower(kimden);
        if (k.includes('inşaat')) {
            return { sellerType: 'CONSTRUCTION_COMPANY', evidence: `attribute Kimden="${kimden}"` };
        }
        if (k === 'sahibinden' || k.includes('sahibinden')) {
            return { sellerType: 'OWNER', evidence: `attribute Kimden="${kimden}"` };
        }
        if (k.includes('ofis')) {
            return { sellerType: 'REAL_ESTATE_OFFICE', evidence: `attribute Kimden="${kimden}"` };
        }
    }

    return { sellerType: 'UNKNOWN', evidence: null };
}

// ---------------------------------------------------------------------------
// publicContactPhone — rendered DOM only, masked values rejected
// ---------------------------------------------------------------------------

/** A usable public phone: non-empty and NOT masked ('*' marks masked renderings). */
function usablePhone(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.trim() !== '' && !value.includes('*');
}

/**
 * Picks the public contact phone from candidates in provenance order:
 *   1. sticky-header phone (the site's own "opened" rendering: data-opened,
 *      then its visible text);
 *   2. main-content phone list ('Cep'/mobile-labeled first, then others;
 *      visible text, then data-opened);
 *   3. individual phone block (#phoneInfoPart: visible pretty-phone rendering,
 *      then data-opened).
 * Masked-only candidates (data-encrypted without data-opened, '*' text) are
 * never selected → null. No reveal interaction is ever involved.
 */
export function pickPublicContactPhone(phones: readonly RawPhoneCandidate[]): string | null {
    // Defensive: the payload crosses page.evaluate's structured clone.
    const candidates = phones.filter(
        (p): p is RawPhoneCandidate => p !== null && typeof p === 'object',
    );
    const isCep = (p: RawPhoneCandidate): boolean => typeof p.label === 'string' && trLower(p.label) === 'cep';
    const pick = (c: RawPhoneCandidate): string | null => {
        if (usablePhone(c.dataOpened)) return c.dataOpened.trim();
        if (usablePhone(c.visibleText)) return c.visibleText.trim();
        return null;
    };

    const sticky = candidates.find(p => p.source === 'sticky-header-phone');
    if (sticky) {
        const v = pick(sticky);
        if (v) return v;
    }

    const mainList = candidates.filter(p => p.source === 'user-info-phones');
    const ordered = [...mainList.filter(isCep), ...mainList.filter(p => !isCep(p))];
    for (const c of ordered) {
        const v = pick(c);
        if (v) return v;
    }

    for (const c of candidates.filter(p => p.source === 'phoneInfoPart')) {
        const v = pick(c);
        if (v) return v;
    }

    return null;
}

// ---------------------------------------------------------------------------
// listingType / propertyCategory / propertySubtype
// ---------------------------------------------------------------------------

type ListingType = ListingDetail['listingType'];

/** URL/path contains 'satilik' → SALE, 'kiralik' → RENT, else UNKNOWN. */
export function classifyListingType(url: string | null | undefined, breadcrumb: readonly string[]): ListingType {
    const folded = trLower(url ?? '');
    if (folded.includes('satilik') || folded.includes('satılık')) return 'SALE';
    if (folded.includes('kiralik') || folded.includes('kiralık')) return 'RENT';
    // Breadcrumb fallback (e.g. 'Satılık'/'Kiralık' crumb) — same rule, display text.
    const crumbs = breadcrumb.map(trLower);
    if (crumbs.some(c => c === 'satılık' || c.includes('satılık'))) return 'SALE';
    if (crumbs.some(c => c === 'kiralık' || c.includes('kiralık'))) return 'RENT';
    return 'UNKNOWN';
}

/** Breadcrumb markers that separate property type from location crumbs. */
const LISTING_TYPE_CRUMBS = new Set(['satılık', 'kiralık', 'turistik günlük kiralık', 'devren satılık konut', 'devren kiralık']);

/**
 * 'Emlak > Konut > Satılık > Daire > Adana > …' → category 'Konut',
 * subtype 'Daire' (first crumb after the sale/rent marker). Best-effort:
 * falls back to the 'Emlak Tipi' attribute ('Satılık Daire' → 'Daire').
 */
export function classifyProperty(
    breadcrumb: readonly string[],
    emlakTipi: string | null,
): { propertyCategory: string | null; propertySubtype: string | null } {
    let propertyCategory: string | null = null;
    let propertySubtype: string | null = null;

    if (breadcrumb.length >= 2 && trLower(breadcrumb[0] ?? '') === 'emlak') {
        propertyCategory = breadcrumb[1] ?? null;
        const markerIdx = breadcrumb.findIndex(c => LISTING_TYPE_CRUMBS.has(trLower(c)));
        if (markerIdx >= 1 && markerIdx + 1 < breadcrumb.length) {
            propertySubtype = breadcrumb[markerIdx + 1] ?? null;
        }
    }

    if (propertySubtype === null && emlakTipi) {
        // 'Satılık Daire' / 'Kiralık Müstakil Ev' → strip the leading type word.
        const stripped = emlakTipi.replace(/^(Devren Satılık|Devren Kiralık|Satılık|Kiralık)\s+/i, '').trim();
        if (stripped !== '') propertySubtype = stripped;
    }

    return { propertyCategory, propertySubtype };
}

// ---------------------------------------------------------------------------
// normalizeDetail
// ---------------------------------------------------------------------------

/**
 * Maps a RawDetailPage onto the ListingDetail contract. Never throws:
 * every field is individually guarded; malformed input degrades to
 * null/empty fields with raw attributes preserved.
 */
export function normalizeDetail(raw: RawDetailPage, ctx: NormalizeDetailContext): ListingDetail {
    const cat = ctx.category;
    const scrapedAt = new Date().toISOString();

    // Defensive copies — `raw` crosses page.evaluate's structured clone and
    // may be partially missing on a broken page.
    const attributes: readonly RawDetailAttribute[] = Array.isArray(raw?.attributes) ? raw.attributes : [];
    const breadcrumb: readonly string[] = Array.isArray(raw?.breadcrumb) ? raw.breadcrumb : [];
    const addressParts: readonly string[] = Array.isArray(raw?.addressParts) ? raw.addressParts : [];
    const phones: readonly RawPhoneCandidate[] = Array.isArray(raw?.phones) ? raw.phones : [];
    const rawImages: readonly string[] = Array.isArray(raw?.images) ? raw.images : [];
    const seller = raw?.seller ?? {
        officeName: null,
        officeProfileUrl: null,
        agentName: null,
        individualName: null,
        registrationText: null,
        hasStoreCard: false,
        hasIndividualBlock: false,
        evidenceSelectors: [],
    };

    const attributesRaw = buildAttributesRaw(attributes);

    const listingType = classifyListingType(ctx.url || raw?.canonicalUrl || raw?.pageUrl, breadcrumb);
    const listingId = raw?.listingId ?? extractListingId(ctx.url) ?? cat?.id ?? null;
    const canonicalUrl = raw?.canonicalUrl ?? ctx.url;

    // --- unavailable short-circuit: nullable fields null/empty (contract j) ---
    if (raw?.unavailable === true) {
        return {
            listingId,
            canonicalUrl,
            source: 'sahibinden.com',
            sourceUrl: ctx.url,
            scrapedAt,
            ...(cat ? { category: cat } : {}),
            title: '',
            description: '',
            price: null,
            currency: 'TL',
            priceRaw: null,
            pricePerSquareMeter: null,
            listingType,
            propertyCategory: null,
            propertySubtype: null,
            grossAreaM2: null,
            netAreaM2: null,
            rooms: null,
            buildingAge: null,
            floor: null,
            totalFloors: null,
            heating: null,
            bathroomCount: null,
            balcony: null,
            furnished: null,
            usageStatus: null,
            insideSite: null,
            siteName: null,
            dues: null,
            deposit: null,
            deedStatus: null,
            creditEligible: null,
            exchangeEligible: null,
            province: null,
            district: null,
            neighborhood: null,
            locationRaw: '',
            listingDate: null,
            listingDateRaw: null,
            updatedDate: null,
            updatedDateRaw: null,
            sellerType: 'UNKNOWN',
            sellerTypeEvidence: null,
            sellerDisplayName: null,
            officeName: null,
            sellerProfileUrl: null,
            publicContactPhone: null,
            images: [],
            videoUrl: null,
            virtualTourUrl: null,
            attributesRaw: {},
            unavailable: true,
        };
    }

    // --- known-field mapping (raw Turkish values preserved as strings) ---
    const mapped = mapKnownAttributes(attributesRaw);
    const grossAreaM2 = mapped.grossAreaM2 ?? null;
    const netAreaM2 = mapped.netAreaM2 ?? null;

    // --- core fields with category gap-fill (detail wins on conflict) ---
    const title = normalizeText(raw?.title) || cat?.title || '';
    const description = (raw?.descriptionText ?? '').trim();
    const price = formatPrice(raw?.priceText) ?? cat?.price ?? null;
    const currency = raw?.priceText ? extractCurrency(raw.priceText) : (cat?.price_currency ?? 'TL');
    const priceRaw = raw?.priceText ?? cat?.price_raw ?? null;

    // pricePerSquareMeter: the category row's displayed value when available;
    // otherwise DERIVED as price / grossAreaM2 (documented derivation —
    // sahibinden detail pages do not render a dedicated m²-price field).
    let pricePerSquareMeter: number | null = cat?.price_per_sqm ? formatPrice(cat.price_per_sqm) : null;
    if (pricePerSquareMeter === null && price !== null && grossAreaM2 !== null && grossAreaM2 > 0) {
        pricePerSquareMeter = Math.round(price / grossAreaM2);
    }

    // 'Emlak Tipi' is not a mapped field (stays in attributesRaw) but feeds
    // the propertySubtype fallback ('Satılık Daire' → 'Daire').
    const emlakTipi = attributesRaw['Emlak Tipi'] ?? null;
    const { propertyCategory, propertySubtype } = classifyProperty(breadcrumb, emlakTipi);

    // --- location (address breadcrumb; category location as raw fallback) ---
    const province = addressParts[0] ?? null;
    const district = addressParts[1] ?? null;
    const neighborhood = addressParts.length > 2 ? addressParts.slice(2).join(' / ') : null;
    const locationRaw = addressParts.join(' / ') || cat?.location || '';

    // --- dates (ISO + raw preserved; category date fills a missing listing date) ---
    const listingDateRaw = mapped.listingDateRaw ?? (cat?.date ? cat.date : null);
    const updatedDateRaw = mapped.updatedDateRaw ?? null;
    const listingDate = parseTurkishDate(listingDateRaw);
    const updatedDate = parseTurkishDate(updatedDateRaw);

    // --- seller (evidence-based classification) ---
    const { sellerType, evidence } = classifySeller(seller, attributesRaw);
    const sellerDisplayName =
        sellerType === 'OWNER'
            ? (seller.individualName ?? seller.agentName ?? null)
            : sellerType === 'REAL_ESTATE_OFFICE' || sellerType === 'CONSTRUCTION_COMPANY'
              ? (seller.agentName ?? seller.officeName ?? null)
              : (seller.agentName ?? seller.individualName ?? seller.officeName ?? null);
    const officeName =
        sellerType === 'REAL_ESTATE_OFFICE' || sellerType === 'CONSTRUCTION_COMPANY' ? (seller.officeName ?? null) : null;
    const sellerProfileUrl = officeName !== null ? (seller.officeProfileUrl ?? null) : null;

    // --- phone (rendered DOM only; masked rejected) ---
    const publicContactPhone = pickPublicContactPhone(phones);

    // --- images (positions + exactly one primary; category image fills an empty gallery) ---
    const images: ListingImage[] = rawImages.map((url, i) => ({ url, position: i, isPrimary: i === 0 }));
    if (images.length === 0 && cat?.image) {
        images.push({ url: cat.image, position: 0, isPrimary: true });
    }

    return {
        listingId,
        canonicalUrl,
        source: 'sahibinden.com',
        sourceUrl: ctx.url,
        scrapedAt,
        ...(cat ? { category: cat } : {}),
        title,
        description,
        price,
        currency,
        priceRaw,
        pricePerSquareMeter,
        listingType,
        propertyCategory,
        propertySubtype,
        grossAreaM2,
        netAreaM2,
        rooms: mapped.rooms ?? null,
        buildingAge: mapped.buildingAge ?? null,
        floor: mapped.floor ?? null,
        totalFloors: mapped.totalFloors ?? null,
        heating: mapped.heating ?? null,
        bathroomCount: mapped.bathroomCount ?? null,
        balcony: mapped.balcony ?? null,
        furnished: mapped.furnished ?? null,
        usageStatus: mapped.usageStatus ?? null,
        insideSite: mapped.insideSite ?? null,
        siteName: mapped.siteName ?? null,
        dues: mapped.dues ?? null,
        deposit: mapped.deposit ?? null,
        deedStatus: mapped.deedStatus ?? null,
        creditEligible: mapped.creditEligible ?? null,
        exchangeEligible: mapped.exchangeEligible ?? null,
        province,
        district,
        neighborhood,
        locationRaw,
        listingDate,
        listingDateRaw,
        updatedDate,
        updatedDateRaw,
        sellerType,
        sellerTypeEvidence: evidence,
        sellerDisplayName,
        officeName,
        sellerProfileUrl,
        publicContactPhone,
        images,
        videoUrl: raw?.videoUrl ?? null,
        virtualTourUrl: raw?.virtualTourUrl ?? null,
        attributesRaw,
        unavailable: false,
    };
}
