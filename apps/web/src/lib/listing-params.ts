/**
 * URL-addressable listings query state. The listings page is server-rendered
 * from searchParams; this module is the single parser/serializer so the
 * table, filter drawer, pagination and CSV export link all agree on keys.
 *
 * Keys mirror the API query schema (apps/api/src/schemas.ts
 * listingListQuerySchema) 1:1.
 */

export const LISTING_SORT_FIELDS = ['price', 'firstSeenAt', 'lastSeenAt', 'title', 'area'] as const;
export type ListingSortField = (typeof LISTING_SORT_FIELDS)[number];

export const LISTING_FILTER_KEYS = [
    'search',
    'province',
    'district',
    'neighborhood',
    'sellerType',
    'listingType',
    'propertyCategory',
    'priceMin',
    'priceMax',
    'm2Min',
    'm2Max',
    'rooms',
    'firstSeenFrom',
    'lastSeenBefore',
    'priceChanged',
    'scanId',
    'status',
] as const;
export type ListingFilterKey = (typeof LISTING_FILTER_KEYS)[number];

export interface ListingQuery {
    page: number;
    pageSize: number;
    sort: ListingSortField;
    order: 'asc' | 'desc';
    filters: Partial<Record<ListingFilterKey, string>>;
}

const DEFAULTS: ListingQuery = {
    page: 1,
    pageSize: 25,
    sort: 'lastSeenAt',
    order: 'desc',
    filters: {},
};

type SearchParamsInput = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return fallback;
    return Math.min(n, max);
}

export function parseListingSearchParams(sp: SearchParamsInput): ListingQuery {
    const sort = first(sp.sort);
    const order = first(sp.order);
    const filters: Partial<Record<ListingFilterKey, string>> = {};
    for (const key of LISTING_FILTER_KEYS) {
        const value = first(sp[key]);
        if (value !== undefined && value.trim() !== '') filters[key] = value;
    }
    return {
        page: parsePositiveInt(first(sp.page), DEFAULTS.page, Number.MAX_SAFE_INTEGER),
        pageSize: parsePositiveInt(first(sp.pageSize), DEFAULTS.pageSize, 100),
        sort: (LISTING_SORT_FIELDS as readonly string[]).includes(sort ?? '') ? (sort as ListingSortField) : DEFAULTS.sort,
        order: order === 'asc' ? 'asc' : 'desc',
        filters,
    };
}

/** Query string for the API / page URLs — only set values, stable order. */
export function listingQueryString(query: ListingQuery, opts: { paginate?: boolean } = {}): string {
    const params = new URLSearchParams();
    const paginate = opts.paginate ?? true;
    if (paginate) {
        params.set('page', String(query.page));
        params.set('pageSize', String(query.pageSize));
    }
    params.set('sort', query.sort);
    params.set('order', query.order);
    for (const key of LISTING_FILTER_KEYS) {
        const value = query.filters[key];
        if (value !== undefined && value !== '') params.set(key, value);
    }
    return params.toString();
}

export function activeFilterCount(query: ListingQuery): number {
    return Object.values(query.filters).filter((v) => v !== undefined && v !== '').length;
}
