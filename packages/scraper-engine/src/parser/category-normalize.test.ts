/**
 * Pins `normalizeCategoryItems` against the 13-field baseline contract
 * (docs/BASELINE_CONTRACT.md §1) using synthetic RawCategoryRow fixtures.
 */
import { describe, expect, it } from 'vitest';
import { normalizeCategoryItems, type RawCategoryRow } from './category-page.js';

const SOURCE_URL = 'https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc';

function fullRow(overrides: Partial<RawCategoryRow> = {}): RawCategoryRow {
    return {
        id: '1334491628',
        url: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-lux-proje-1334491628/detay',
        title: "OPERA'DAN BEYLİKDÜZÜNDE LÜX PROJE 1+1",
        priceText: '4.749.000 TL',
        pricePerSqmText: '59.363 TL/m²',
        areaText: '80',
        location: 'Beylikdüzü / Gürpınar',
        date: '14 Eylül 2026',
        image: 'https://i0.shbdn.com/photos/49/16/28/lthmb_13344916286fx.jpg',
        ...overrides,
    };
}

describe('normalizeCategoryItems', () => {
    it('maps a full row to the exact 13-field contract', () => {
        const [item] = normalizeCategoryItems([fullRow()], SOURCE_URL);
        expect(item).toBeDefined();
        expect(Object.keys(item!).sort()).toEqual(
            [
                'id',
                'url',
                'title',
                'price',
                'price_currency',
                'price_raw',
                'price_per_sqm',
                'area',
                'location',
                'date',
                'image',
                'scrapedAt',
                'sourceUrl',
            ].sort(),
        );
        expect(item).toMatchObject({
            id: '1334491628',
            url: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-lux-proje-1334491628/detay',
            title: "OPERA'DAN BEYLİKDÜZÜNDE LÜX PROJE 1+1",
            price: 4749000,
            price_currency: 'TL',
            price_raw: '4.749.000 TL',
            price_per_sqm: '59.363 TL/m²',
            area: '80',
            location: 'Beylikdüzü / Gürpınar',
            date: '14 Eylül 2026',
            image: 'https://i0.shbdn.com/photos/49/16/28/lthmb_13344916286fx.jpg',
            sourceUrl: SOURCE_URL,
        });
        expect(item!.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('skips rows without title or url (silent skip rule)', () => {
        const items = normalizeCategoryItems(
            [fullRow({ title: null }), fullRow({ url: null }), fullRow({ title: '' }), fullRow()],
            SOURCE_URL,
        );
        expect(items).toHaveLength(1);
    });

    it('null priceText → price null, price_raw null, but currency still TL', () => {
        const [item] = normalizeCategoryItems([fullRow({ priceText: null })], SOURCE_URL);
        expect(item!.price).toBeNull();
        expect(item!.price_raw).toBeNull();
        expect(item!.price_currency).toBe('TL'); // contract quirk: TL even when price is null
    });

    it('missing optional cells become empty strings (not null)', () => {
        const [item] = normalizeCategoryItems(
            [fullRow({ pricePerSqmText: null, areaText: null, location: null, date: null })],
            SOURCE_URL,
        );
        expect(item!.price_per_sqm).toBe('');
        expect(item!.area).toBe('');
        expect(item!.location).toBe('');
        expect(item!.date).toBe('');
    });

    it('missing image stays null', () => {
        const [item] = normalizeCategoryItems([fullRow({ image: null })], SOURCE_URL);
        expect(item!.image).toBeNull();
    });

    it('id falls back to the URL regex when data-id is absent', () => {
        const [item] = normalizeCategoryItems([fullRow({ id: null })], SOURCE_URL);
        expect(item!.id).toBe('1334491628');
    });

    it('id is null when neither data-id nor URL regex match', () => {
        const [item] = normalizeCategoryItems(
            [fullRow({ id: null, url: 'https://www.sahibinden.com/ilan/no-digits-here/detay' })],
            SOURCE_URL,
        );
        expect(item!.id).toBeNull();
    });

    it('detects foreign currency from the raw price text', () => {
        const [item] = normalizeCategoryItems([fullRow({ priceText: '250.000 EUR' })], SOURCE_URL);
        expect(item!.price_currency).toBe('EUR');
        expect(item!.price).toBe(250000);
    });

    it('applies normalizeText (whitespace collapse + mojibake fix) to text fields', () => {
        const [item] = normalizeCategoryItems(
            [fullRow({ title: '  Satılık   Daire ', location: 'KadÄ±kÃ¶y / Moda' })],
            SOURCE_URL,
        );
        expect(item!.title).toBe('Satılık Daire');
        expect(item!.location).toBe('Kadıköy / Moda');
    });

    it('stamps every item with the given sourceUrl', () => {
        const items = normalizeCategoryItems([fullRow(), fullRow({ id: '9998887771' })], SOURCE_URL);
        expect(items.map(i => i.sourceUrl)).toEqual([SOURCE_URL, SOURCE_URL]);
    });
});
