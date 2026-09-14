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
import type { CategoryListing } from '../../packages/shared/src/index.js';

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
