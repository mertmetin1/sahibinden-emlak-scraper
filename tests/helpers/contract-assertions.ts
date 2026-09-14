/**
 * Shared 13-field baseline-contract assertions for CategoryListing items
 * (docs/BASELINE_CONTRACT.md §1). Used by the baseline regression test, the
 * fixture parse test, and the offline e2e test so the contract is pinned
 * identically everywhere.
 *
 * NOTE on imports: the repo root package.json declares no @sahibindenbot/*
 * dependencies, so pnpm creates no workspace links in the root node_modules
 * and bare specifiers do not resolve from tests/. All test files therefore
 * import workspace sources via relative paths; transitive bare imports
 * resolve through each package's own node_modules symlink.
 */
import { expect } from 'vitest';
import type { CategoryListing, ListingDetail, SellerType } from '../../packages/shared/src/index.js';

/** The exact 13 contract fields, sorted (compare against Object.keys().sort()). */
export const CONTRACT_FIELDS: readonly string[] = [
    'area',
    'date',
    'id',
    'image',
    'location',
    'price',
    'price_currency',
    'price_per_sqm',
    'price_raw',
    'scrapedAt',
    'sourceUrl',
    'title',
    'url',
];

const ISO_8601_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export interface ContractAssertOptions {
    /** When given, every item's sourceUrl must start with this prefix. */
    sourceUrlPrefix?: string;
    /** When given, every item's url must start with this prefix (absolute URLs). */
    urlPrefix?: string;
}

/**
 * Asserts one parsed item satisfies the full 13-field output contract:
 * exact key set, per-field types, missing-value rules, ISO scrapedAt.
 * `ctx` labels assertion messages with the item's position for debugging.
 */
export function assertCategoryListingContract(
    item: unknown,
    ctx: string,
    opts: ContractAssertOptions = {},
): asserts item is CategoryListing {
    expect(typeof item, `${ctx}: item must be an object`).toBe('object');
    expect(item, `${ctx}: item must not be null`).not.toBeNull();

    const keys = Object.keys(item as Record<string, unknown>).sort();
    expect(keys, `${ctx}: exact 13-field key set`).toEqual([...CONTRACT_FIELDS]);

    const l = item as Record<string, unknown>;

    // id: string | null (data-id preferred, URL-regex fallback)
    expect(
        l.id === null || (typeof l.id === 'string' && l.id.length > 0),
        `${ctx}: id must be a non-empty string or null, got ${JSON.stringify(l.id)}`,
    ).toBe(true);

    // url: string, absolute detail URL (rows without url are skipped upstream)
    expect(typeof l.url, `${ctx}: url type`).toBe('string');
    expect((l.url as string).length, `${ctx}: url non-empty`).toBeGreaterThan(0);
    if (opts.urlPrefix) {
        expect((l.url as string).startsWith(opts.urlPrefix), `${ctx}: url prefix ${opts.urlPrefix}`).toBe(true);
    }

    // title: string (rows without title are skipped upstream)
    expect(typeof l.title, `${ctx}: title type`).toBe('string');
    expect((l.title as string).length, `${ctx}: title non-empty`).toBeGreaterThan(0);

    // price: number | null (Turkish thousands format parsed to a number)
    expect(
        l.price === null || (typeof l.price === 'number' && Number.isFinite(l.price)),
        `${ctx}: price must be a finite number or null, got ${JSON.stringify(l.price)}`,
    ).toBe(true);

    // price_currency: string, 'TL' default even when price is null
    expect(typeof l.price_currency, `${ctx}: price_currency type`).toBe('string');
    expect((l.price_currency as string).length, `${ctx}: price_currency non-empty`).toBeGreaterThan(0);

    // price_raw: string | null (raw cell text)
    expect(
        l.price_raw === null || typeof l.price_raw === 'string',
        `${ctx}: price_raw must be a string or null`,
    ).toBe(true);

    // price_per_sqm / area / location / date: string, '' allowed for missing
    for (const f of ['price_per_sqm', 'area', 'location', 'date'] as const) {
        expect(typeof l[f], `${ctx}: ${f} type`).toBe('string');
    }

    // image: string | null
    expect(
        l.image === null || (typeof l.image === 'string' && l.image.length > 0),
        `${ctx}: image must be a non-empty string or null`,
    ).toBe(true);

    // scrapedAt: ISO-8601 UTC, never null
    expect(typeof l.scrapedAt, `${ctx}: scrapedAt type`).toBe('string');
    expect(
        ISO_8601_PREFIX.test(l.scrapedAt as string) && !Number.isNaN(Date.parse(l.scrapedAt as string)),
        `${ctx}: scrapedAt must be ISO-8601 parseable, got ${JSON.stringify(l.scrapedAt)}`,
    ).toBe(true);

    // sourceUrl: string, never null — the category page URL
    expect(typeof l.sourceUrl, `${ctx}: sourceUrl type`).toBe('string');
    if (opts.sourceUrlPrefix) {
        expect(
            (l.sourceUrl as string).startsWith(opts.sourceUrlPrefix),
            `${ctx}: sourceUrl must start with ${opts.sourceUrlPrefix}`,
        ).toBe(true);
    }
}

// ---------------------------------------------------------------------------
// ListingDetail (Phase-2 detail-page contract — packages/shared/src/types.ts)
// ---------------------------------------------------------------------------

/**
 * The exact required ListingDetail fields, sorted (compare against
 * Object.keys().sort() minus the optional 'category'). 51 required keys;
 * `category` is optional and, when present, must itself satisfy the
 * 13-field category contract.
 */
export const DETAIL_CONTRACT_FIELDS: readonly string[] = [
    'attributesRaw',
    'balcony',
    'bathroomCount',
    'buildingAge',
    'canonicalUrl',
    'creditEligible',
    'currency',
    'deedStatus',
    'deposit',
    'description',
    'district',
    'dues',
    'exchangeEligible',
    'floor',
    'furnished',
    'grossAreaM2',
    'heating',
    'images',
    'insideSite',
    'listingDate',
    'listingDateRaw',
    'listingId',
    'listingType',
    'locationRaw',
    'neighborhood',
    'netAreaM2',
    'officeName',
    'price',
    'pricePerSquareMeter',
    'priceRaw',
    'propertyCategory',
    'propertySubtype',
    'province',
    'publicContactPhone',
    'rooms',
    'scrapedAt',
    'sellerDisplayName',
    'sellerProfileUrl',
    'sellerType',
    'sellerTypeEvidence',
    'siteName',
    'source',
    'sourceUrl',
    'title',
    'totalFloors',
    'unavailable',
    'updatedDate',
    'updatedDateRaw',
    'usageStatus',
    'videoUrl',
    'virtualTourUrl',
];

const SELLER_TYPES: readonly SellerType[] = ['OWNER', 'REAL_ESTATE_OFFICE', 'CONSTRUCTION_COMPANY', 'OTHER', 'UNKNOWN'];
const LISTING_TYPES: readonly ListingDetail['listingType'][] = ['SALE', 'RENT', 'UNKNOWN'];

/** string | null detail fields (raw Turkish values preserved as strings). */
const NULLABLE_STRING_FIELDS = [
    'listingId',
    'priceRaw',
    'propertyCategory',
    'propertySubtype',
    'rooms',
    'buildingAge',
    'floor',
    'totalFloors',
    'heating',
    'bathroomCount',
    'balcony',
    'furnished',
    'usageStatus',
    'insideSite',
    'siteName',
    'dues',
    'deposit',
    'deedStatus',
    'creditEligible',
    'exchangeEligible',
    'province',
    'district',
    'neighborhood',
    'listingDate',
    'listingDateRaw',
    'updatedDate',
    'updatedDateRaw',
    'sellerTypeEvidence',
    'sellerDisplayName',
    'officeName',
    'sellerProfileUrl',
    'publicContactPhone',
    'videoUrl',
    'virtualTourUrl',
] as const;

/** number | null detail fields. */
const NULLABLE_NUMBER_FIELDS = ['price', 'pricePerSquareMeter', 'grossAreaM2', 'netAreaM2'] as const;

export interface DetailContractAssertOptions {
    /** When given, detail.sourceUrl must start with this prefix. */
    sourceUrlPrefix?: string;
    /** When true, the optional category merge MUST be present and valid. */
    requireCategory?: boolean;
}

/**
 * Asserts one record satisfies the full ListingDetail contract: exact key
 * set (51 required + optional 'category'), per-field types, nullability
 * rules, seller evidence consistency (null iff UNKNOWN), image-record
 * invariants, and the phone legal boundary (masked '*'-values never surface).
 * `ctx` labels assertion messages for debugging.
 */
export function assertListingDetailContract(
    detail: unknown,
    ctx: string,
    opts: DetailContractAssertOptions = {},
): asserts detail is ListingDetail {
    expect(typeof detail, `${ctx}: detail must be an object`).toBe('object');
    expect(detail, `${ctx}: detail must not be null`).not.toBeNull();
    expect(Array.isArray(detail), `${ctx}: detail must not be an array`).toBe(false);

    const d = detail as Record<string, unknown>;
    const keys = Object.keys(d).sort();
    const expectedKeys = opts.requireCategory
        ? [...DETAIL_CONTRACT_FIELDS, 'category'].sort()
        : [...DETAIL_CONTRACT_FIELDS];
    if (opts.requireCategory) {
        expect(keys, `${ctx}: exact 52-field key set (category required)`).toEqual(expectedKeys);
    } else {
        // category is the only permitted extra key.
        expect(
            keys.every(k => expectedKeys.includes(k) || k === 'category'),
            `${ctx}: keys must be the 51 contract fields (+ optional category); got ${JSON.stringify(keys)}`,
        ).toBe(true);
        expect(
            expectedKeys.every(k => keys.includes(k)),
            `${ctx}: all 51 required fields present; missing ${JSON.stringify(expectedKeys.filter(k => !keys.includes(k)))}`,
        ).toBe(true);
    }

    // --- identity & source ---
    expect(
        d.listingId === null || (typeof d.listingId === 'string' && d.listingId.length > 0),
        `${ctx}: listingId must be a non-empty string or null`,
    ).toBe(true);
    for (const f of ['canonicalUrl', 'source', 'sourceUrl'] as const) {
        expect(typeof d[f], `${ctx}: ${f} type`).toBe('string');
        expect((d[f] as string).length, `${ctx}: ${f} non-empty`).toBeGreaterThan(0);
    }
    expect(d.source, `${ctx}: source is the sahibinden.com marker`).toBe('sahibinden.com');
    if (opts.sourceUrlPrefix) {
        expect(
            (d.sourceUrl as string).startsWith(opts.sourceUrlPrefix),
            `${ctx}: sourceUrl must start with ${opts.sourceUrlPrefix}`,
        ).toBe(true);
    }
    expect(typeof d.scrapedAt, `${ctx}: scrapedAt type`).toBe('string');
    expect(
        ISO_8601_PREFIX.test(d.scrapedAt as string) && !Number.isNaN(Date.parse(d.scrapedAt as string)),
        `${ctx}: scrapedAt must be ISO-8601 parseable`,
    ).toBe(true);

    // --- core ---
    expect(typeof d.title, `${ctx}: title type`).toBe('string');
    expect(typeof d.description, `${ctx}: description type`).toBe('string');
    expect(typeof d.currency, `${ctx}: currency type`).toBe('string');
    expect((d.currency as string).length, `${ctx}: currency non-empty`).toBeGreaterThan(0);

    // --- classification enums ---
    expect(
        LISTING_TYPES.includes(d.listingType as ListingDetail['listingType']),
        `${ctx}: listingType must be SALE|RENT|UNKNOWN, got ${JSON.stringify(d.listingType)}`,
    ).toBe(true);
    expect(
        SELLER_TYPES.includes(d.sellerType as SellerType),
        `${ctx}: sellerType must be a valid SellerType, got ${JSON.stringify(d.sellerType)}`,
    ).toBe(true);

    // --- nullable string / number fields ---
    for (const f of NULLABLE_STRING_FIELDS) {
        expect(
            d[f] === null || typeof d[f] === 'string',
            `${ctx}: ${f} must be a string or null, got ${JSON.stringify(d[f])}`,
        ).toBe(true);
    }
    for (const f of NULLABLE_NUMBER_FIELDS) {
        expect(
            d[f] === null || (typeof d[f] === 'number' && Number.isFinite(d[f])),
            `${ctx}: ${f} must be a finite number or null, got ${JSON.stringify(d[f])}`,
        ).toBe(true);
    }

    // ISO-parseable dates when present (raw variants stay free-form strings).
    // parseTurkishDate yields DATE-ONLY ISO ('2026-09-14'), so the full
    // ISO_8601_PREFIX datetime regex does not apply — Date.parse is the check.
    const ISO_DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
    for (const f of ['listingDate', 'updatedDate'] as const) {
        if (d[f] !== null) {
            expect(
                ISO_DATE_OR_DATETIME.test(d[f] as string) && !Number.isNaN(Date.parse(d[f] as string)),
                `${ctx}: ${f} must be ISO-8601 parseable when present, got ${JSON.stringify(d[f])}`,
            ).toBe(true);
        }
    }

    // --- seller evidence consistency: null iff UNKNOWN ---
    if (d.sellerType === 'UNKNOWN') {
        expect(d.sellerTypeEvidence, `${ctx}: sellerTypeEvidence must be null when sellerType UNKNOWN`).toBeNull();
    } else {
        expect(
            typeof d.sellerTypeEvidence === 'string' && (d.sellerTypeEvidence as string).length > 0,
            `${ctx}: sellerTypeEvidence must be a non-empty string when sellerType=${String(d.sellerType)}`,
        ).toBe(true);
    }

    // --- phone legal boundary: masked renderings never surface ---
    if (d.publicContactPhone !== null) {
        expect(
            (d.publicContactPhone as string).includes('*'),
            `${ctx}: publicContactPhone must never contain '*' (masked), got ${JSON.stringify(d.publicContactPhone)}`,
        ).toBe(false);
    }

    // --- images: records with sequential positions, exactly one primary ---
    expect(Array.isArray(d.images), `${ctx}: images must be an array`).toBe(true);
    const images = d.images as Array<Record<string, unknown>>;
    for (const [i, img] of images.entries()) {
        expect(typeof img.url, `${ctx}: images[${i}].url type`).toBe('string');
        expect((img.url as string).length, `${ctx}: images[${i}].url non-empty`).toBeGreaterThan(0);
        expect(img.position, `${ctx}: images[${i}].position sequential`).toBe(i);
        expect(typeof img.isPrimary, `${ctx}: images[${i}].isPrimary type`).toBe('boolean');
    }
    if (images.length > 0) {
        expect(
            images.filter(i => i.isPrimary === true).length,
            `${ctx}: exactly one primary image`,
        ).toBe(1);
    }

    // --- attributesRaw: lossless Record<string, string> ---
    expect(typeof d.attributesRaw, `${ctx}: attributesRaw type`).toBe('object');
    expect(d.attributesRaw, `${ctx}: attributesRaw not null`).not.toBeNull();
    expect(Array.isArray(d.attributesRaw), `${ctx}: attributesRaw must not be an array`).toBe(false);
    for (const [k, v] of Object.entries(d.attributesRaw as Record<string, unknown>)) {
        expect(typeof k, `${ctx}: attributesRaw key type`).toBe('string');
        expect(typeof v, `${ctx}: attributesRaw[${JSON.stringify(k)}] must be a string`).toBe('string');
    }

    // --- unavailable flag ---
    expect(typeof d.unavailable, `${ctx}: unavailable type`).toBe('boolean');

    // --- optional category merge: full 13-field contract when present ---
    if ('category' in d && d.category !== undefined) {
        assertCategoryListingContract(d.category, `${ctx}.category`);
    } else if (opts.requireCategory) {
        throw new Error(`${ctx}: category merge required but absent`);
    }
}
