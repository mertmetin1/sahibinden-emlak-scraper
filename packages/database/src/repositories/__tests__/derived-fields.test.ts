/**
 * Pure derived-field tests — latestPriceChangePercent + priceChanged flag.
 * Input rows are changedAt-DESC (latest first), matching the repository's
 * `take: 2` include. No database involved.
 */
import { describe, expect, it } from 'vitest';
import { computeLatestPriceChangePercent, computePriceChanged } from '../derived.js';

const at = (iso: string): Date => new Date(iso);

describe('computeLatestPriceChangePercent', () => {
    it('two rows -> percent between latest and previous, rounded to 2dp', () => {
        const history = [
            { price: 110, changedAt: at('2026-09-14T00:00:00Z') },
            { price: 100, changedAt: at('2026-09-01T00:00:00Z') },
        ];
        expect(computeLatestPriceChangePercent(history)).toBe(10);
    });

    it('one row -> null (no computable delta)', () => {
        expect(computeLatestPriceChangePercent([{ price: 100, changedAt: at('2026-09-14T00:00:00Z') }])).toBeNull();
    });

    it('zero rows -> null', () => {
        expect(computeLatestPriceChangePercent([])).toBeNull();
    });

    it('price drop -> negative percent', () => {
        const history = [
            { price: 90, changedAt: at('2026-09-14T00:00:00Z') },
            { price: 100, changedAt: at('2026-09-01T00:00:00Z') },
        ];
        expect(computeLatestPriceChangePercent(history)).toBe(-10);
    });

    it('rounds to 2 decimal places', () => {
        const history = [
            { price: 1, changedAt: at('2026-09-14T00:00:00Z') },
            { price: 3, changedAt: at('2026-09-01T00:00:00Z') },
        ];
        expect(computeLatestPriceChangePercent(history)).toBe(-66.67);
    });

    it('previous price of 0 -> null (division guard)', () => {
        const history = [
            { price: 100, changedAt: at('2026-09-14T00:00:00Z') },
            { price: 0, changedAt: at('2026-09-01T00:00:00Z') },
        ];
        expect(computeLatestPriceChangePercent(history)).toBeNull();
    });

    it('only the two most recent rows matter', () => {
        const history = [
            { price: 200, changedAt: at('2026-09-14T00:00:00Z') },
            { price: 100, changedAt: at('2026-09-10T00:00:00Z') },
            { price: 50, changedAt: at('2026-09-01T00:00:00Z') },
        ];
        expect(computeLatestPriceChangePercent(history)).toBe(100);
    });
});

describe('computePriceChanged', () => {
    it('any history row -> true; none -> false', () => {
        expect(computePriceChanged(0)).toBe(false);
        expect(computePriceChanged(1)).toBe(true);
        expect(computePriceChanged(2)).toBe(true);
    });
});
