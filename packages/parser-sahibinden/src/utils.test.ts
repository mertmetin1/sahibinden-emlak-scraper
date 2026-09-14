import { describe, expect, it } from 'vitest';
import { extractCurrency, extractListingId, formatPrice, normalizeText } from './utils.js';

describe('formatPrice', () => {
    it('parses Turkish format with dot thousands separators', () => {
        expect(formatPrice('4.500.000 TL')).toBe(4500000);
        expect(formatPrice('4.749.000 TL')).toBe(4749000);
    });

    it('returns null for null/undefined/empty', () => {
        expect(formatPrice(null)).toBeNull();
        expect(formatPrice(undefined)).toBeNull();
        expect(formatPrice('')).toBeNull();
    });

    it('parses mixed TR decimal comma', () => {
        expect(formatPrice('1.500.000,50')).toBe(1500000.5);
    });

    it('returns null for non-numeric input', () => {
        expect(formatPrice('Fiyat için arayınız')).toBeNull();
    });

    // KNOWN UPSTREAM QUIRK (documented, preserved for baseline parity):
    // US-formatted "1,500,000" → commas become decimal points → parseFloat
    // stops at the second dot → 1.5. Sahibinden serves TR-formatted prices.
    it('documents the US-format edge (upstream quirk)', () => {
        expect(formatPrice('1,500,000')).toBe(1.5);
    });
});

describe('extractCurrency', () => {
    it('detects EUR via code and symbol', () => {
        expect(extractCurrency('250.000 EUR')).toBe('EUR');
        expect(extractCurrency('€ 250.000')).toBe('EUR');
    });

    it('detects USD via code and symbol', () => {
        expect(extractCurrency('250.000 USD')).toBe('USD');
        expect(extractCurrency('$ 250,000')).toBe('USD');
    });

    it('detects GBP via code and symbol', () => {
        expect(extractCurrency('500.000 GBP')).toBe('GBP');
        expect(extractCurrency('£ 500.000')).toBe('GBP');
    });

    it('defaults to TL — even for null (contract quirk)', () => {
        expect(extractCurrency('4.500.000 TL')).toBe('TL');
        expect(extractCurrency(null)).toBe('TL');
        expect(extractCurrency(undefined)).toBe('TL');
    });
});

describe('normalizeText', () => {
    it('collapses whitespace and trims', () => {
        expect(normalizeText('  İstanbul   Kadıköy \n ')).toBe('İstanbul Kadıköy');
        expect(normalizeText('a\t\tb')).toBe('a b');
    });

    it('returns empty string for null/undefined/empty', () => {
        expect(normalizeText(null)).toBe('');
        expect(normalizeText(undefined)).toBe('');
        expect(normalizeText('')).toBe('');
    });

    it('fixes UTF-8-as-Latin-1 mojibake', () => {
        expect(normalizeText('Ã¼')).toBe('ü');
        expect(normalizeText('KadÄ±kÃ¶y')).toBe('Kadıköy');
    });

    it('leaves correct Unicode untouched (escape() hack falls through)', () => {
        expect(normalizeText('Beylikdüzü / Gürpınar')).toBe('Beylikdüzü / Gürpınar');
    });
});

describe('extractListingId', () => {
    it('extracts the id from a /detay URL', () => {
        expect(
            extractListingId('https://www.sahibinden.com/ilan/emlak-konut-satilik-3plus1-1234567890/detay'),
        ).toBe('1234567890');
    });

    it('extracts an id at end of string', () => {
        expect(extractListingId('https://www.sahibinden.com/ilan/foo-12345678')).toBe('12345678');
    });

    it('returns null for null/empty', () => {
        expect(extractListingId(null)).toBeNull();
        expect(extractListingId('')).toBeNull();
    });

    it('returns null when no 8-12 digit run exists', () => {
        expect(extractListingId('https://www.sahibinden.com/satilik-daire/istanbul')).toBeNull();
        expect(extractListingId('https://www.sahibinden.com/ilan/foo-1234567/detay')).toBeNull(); // 7 digits
    });
});
