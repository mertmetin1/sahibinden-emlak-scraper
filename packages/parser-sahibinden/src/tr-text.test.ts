/**
 * Pure-node unit tests for the Turkish text/number/date helpers.
 * Edge cases pinned: all 12 months, leap-year validation, dotless-ı folding,
 * TR thousands/decimal formats, unparseable input → null (never throws).
 */
import { describe, expect, it } from 'vitest';
import { TURKISH_MONTHS, parseTrNumber, parseTurkishDate, trLower } from './tr-text.js';

describe('trLower', () => {
    it('folds dotted İ and dotless I correctly', () => {
        expect(trLower('İNŞAAT')).toBe('inşaat');
        expect(trLower('IĞDIR')).toBe('ığdır');
        expect(trLower('Satılık')).toBe('satılık');
    });

    it('leaves already-lowercase text untouched', () => {
        expect(trLower('yayından kaldırılmıştır')).toBe('yayından kaldırılmıştır');
    });
});

describe('parseTurkishDate', () => {
    it('parses every Turkish month', () => {
        const cases: Array<[string, string]> = [
            ['5 Ocak 2026', '2026-01-05'],
            ['12 Şubat 2026', '2026-02-12'],
            ['3 Mart 2026', '2026-03-03'],
            ['30 Nisan 2026', '2026-04-30'],
            ['15 Mayıs 2026', '2026-05-15'],
            ['9 Haziran 2026', '2026-06-09'],
            ['21 Temmuz 2026', '2026-07-21'],
            ['8 Ağustos 2026', '2026-08-08'],
            ['14 Eylül 2026', '2026-09-14'],
            ['1 Ekim 2026', '2026-10-01'],
            ['19 Kasım 2026', '2026-11-19'],
            ['31 Aralık 2026', '2026-12-31'],
        ];
        for (const [raw, iso] of cases) {
            expect(parseTurkishDate(raw), raw).toBe(iso);
        }
    });

    it('is case-insensitive via Turkish folding', () => {
        expect(parseTurkishDate('14 EYLÜL 2026')).toBe('2026-09-14');
        expect(parseTurkishDate('14 eylül 2026')).toBe('2026-09-14');
    });

    it('tolerates surrounding whitespace and a trailing time', () => {
        expect(parseTurkishDate('  14 Eylül 2026  ')).toBe('2026-09-14');
        expect(parseTurkishDate('14 Eylül 2026 15:30')).toBe('2026-09-14');
    });

    it('validates calendar reality (leap years)', () => {
        expect(parseTurkishDate('29 Şubat 2028')).toBe('2028-02-29'); // leap
        expect(parseTurkishDate('29 Şubat 2026')).toBeNull(); // not leap
        expect(parseTurkishDate('31 Nisan 2026')).toBeNull(); // April has 30 days
    });

    it('returns null for garbage/empty/null', () => {
        expect(parseTurkishDate(null)).toBeNull();
        expect(parseTurkishDate(undefined)).toBeNull();
        expect(parseTurkishDate('')).toBeNull();
        expect(parseTurkishDate('yesterday')).toBeNull();
        expect(parseTurkishDate('14 Foo 2026')).toBeNull();
        expect(parseTurkishDate('32 Ocak 2026')).toBeNull();
    });

    it('month map has exactly the 12 Turkish months', () => {
        expect(Object.keys(TURKISH_MONTHS)).toHaveLength(12);
    });
});

describe('parseTrNumber', () => {
    it('parses plain and thousands-separated integers', () => {
        expect(parseTrNumber('175')).toBe(175);
        expect(parseTrNumber('1.500')).toBe(1500);
        expect(parseTrNumber('4.500.000')).toBe(4500000);
    });

    it('parses TR decimal comma', () => {
        expect(parseTrNumber('1.500.000,50')).toBe(1500000.5);
    });

    it('parses zero', () => {
        expect(parseTrNumber('0')).toBe(0);
    });

    it('returns null for empty/null/unparseable (never throws)', () => {
        expect(parseTrNumber(null)).toBeNull();
        expect(parseTrNumber(undefined)).toBeNull();
        expect(parseTrNumber('')).toBeNull();
        expect(parseTrNumber('Belirtilmemiş')).toBeNull();
    });

    it('strips surrounding non-numeric text (m², TL)', () => {
        expect(parseTrNumber('175 m²')).toBe(175);
        expect(parseTrNumber('59.363 TL/m²')).toBe(59363);
    });

    // Same upstream quirk as formatPrice (shared implementation, documented).
    it('documents the US-format edge (upstream quirk)', () => {
        expect(parseTrNumber('1,500,000')).toBe(1.5);
    });
});
