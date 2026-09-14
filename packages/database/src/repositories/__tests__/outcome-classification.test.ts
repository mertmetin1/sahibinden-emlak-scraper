/**
 * Pure outcome-classification tests — the price-change decision matrix and
 * outcome mapping. No database involved.
 */
import { describe, expect, it } from 'vitest';
import { decideOutcome, isPriceChange } from '../outcome.js';

describe('isPriceChange — decision matrix', () => {
    it('null -> value is NOT a price change (no baseline)', () => {
        expect(isPriceChange({ price: null, currency: 'TL' }, { price: 4_749_000, currency: 'TL' })).toBe(false);
    });

    it('value -> same value is NOT a price change', () => {
        expect(isPriceChange({ price: 4_749_000, currency: 'TL' }, { price: 4_749_000, currency: 'TL' })).toBe(false);
    });

    it('value -> different value IS a price change', () => {
        expect(isPriceChange({ price: 4_750_000, currency: 'TL' }, { price: 4_749_000, currency: 'TL' })).toBe(true);
    });

    it('value -> null is NOT a price change (price vanished; no history row possible)', () => {
        expect(isPriceChange({ price: 4_749_000, currency: 'TL' }, { price: null, currency: 'TL' })).toBe(false);
    });

    it('null -> null is NOT a price change', () => {
        expect(isPriceChange({ price: null, currency: 'TL' }, { price: null, currency: 'TL' })).toBe(false);
    });

    it('currency move with identical price is NOT a price change', () => {
        expect(isPriceChange({ price: 250_000, currency: 'USD' }, { price: 250_000, currency: 'TL' })).toBe(false);
    });
});

describe('decideOutcome — outcome mapping', () => {
    it('no existing row -> INSERTED (regardless of incoming price)', () => {
        expect(decideOutcome(null, { price: 100, currency: 'TL' }, false)).toBe('INSERTED');
        expect(decideOutcome(null, { price: null, currency: 'TL' }, false)).toBe('INSERTED');
    });

    it('existing + real price change -> PRICE_CHANGED (even when other fields also changed)', () => {
        expect(
            decideOutcome({ price: 100, currency: 'TL' }, { price: 120, currency: 'TL' }, true),
        ).toBe('PRICE_CHANGED');
        expect(
            decideOutcome({ price: 100, currency: 'TL' }, { price: 120, currency: 'TL' }, false),
        ).toBe('PRICE_CHANGED');
    });

    it('null -> value maps to UPDATED when the field compare flagged it, else UNCHANGED', () => {
        expect(decideOutcome({ price: null, currency: 'TL' }, { price: 100, currency: 'TL' }, true)).toBe('UPDATED');
        expect(decideOutcome({ price: null, currency: 'TL' }, { price: 100, currency: 'TL' }, false)).toBe(
            'UNCHANGED',
        );
    });

    it('value -> same with no other change -> UNCHANGED', () => {
        expect(decideOutcome({ price: 100, currency: 'TL' }, { price: 100, currency: 'TL' }, false)).toBe(
            'UNCHANGED',
        );
    });

    it('value -> same with another field changed -> UPDATED', () => {
        expect(decideOutcome({ price: 100, currency: 'TL' }, { price: 100, currency: 'TL' }, true)).toBe('UPDATED');
    });

    it('value -> null maps to UPDATED when flagged, never PRICE_CHANGED', () => {
        expect(decideOutcome({ price: 100, currency: 'TL' }, { price: null, currency: 'TL' }, true)).toBe('UPDATED');
        expect(decideOutcome({ price: 100, currency: 'TL' }, { price: null, currency: 'TL' }, false)).toBe(
            'UNCHANGED',
        );
    });
});
