/**
 * Regression test: the captured upstream actor output
 * (fixtures/baseline/upstream-category-output-istanbul-20.json, Apify run
 * bhCcU3D2JghRVdhwa) is the frozen behavioral reference. This pins that every
 * captured item satisfies the 13-field contract our refactor must reproduce
 * (docs/BASELINE_CONTRACT.md §1).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CategoryListing } from '../../packages/shared/src/index.js';
import { assertCategoryListingContract } from '../helpers/contract-assertions.js';

const BASELINE = path.resolve(
    __dirname,
    '../../fixtures/baseline/upstream-category-output-istanbul-20.json',
);

async function loadBaseline(): Promise<unknown> {
    return JSON.parse(await readFile(BASELINE, 'utf8')) as unknown;
}

describe('baseline contract (upstream capture, 20 items)', () => {
    it('is a 20-item JSON array', async () => {
        const data = await loadBaseline();
        expect(Array.isArray(data)).toBe(true);
        expect((data as unknown[]).length).toBe(20);
    });

    it('every item satisfies the exact 13-field contract', async () => {
        const data = (await loadBaseline()) as unknown[];
        for (const [i, item] of data.entries()) {
            assertCategoryListingContract(item, `item[${i}]`, {
                sourceUrlPrefix: 'https://www.sahibinden.com',
                urlPrefix: 'https://www.sahibinden.com/ilan/',
            });
        }
    });

    it('every url is an absolute /ilan/.../detay detail URL', async () => {
        const data = (await loadBaseline()) as CategoryListing[];
        for (const item of data) {
            expect(item.url).toContain('/ilan/');
            expect(item.url.endsWith('/detay')).toBe(true);
        }
    });

    it('has at least one price above 1.000.000 (TR thousands parsing sanity)', async () => {
        const data = (await loadBaseline()) as CategoryListing[];
        // Turkish format "4.749.000 TL" must parse to 4749000, not 4.749.
        expect(data.some(i => i.price !== null && i.price > 1_000_000)).toBe(true);
    });

    it('ids are unique non-empty digit strings in the captured run', async () => {
        const data = (await loadBaseline()) as CategoryListing[];
        const ids = data.map(i => i.id);
        expect(ids.every(id => id !== null && /^\d{8,12}$/.test(id))).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
