/**
 * Pure derived-field computation for listing list rows.
 *
 * The repository feeds the last N price-history rows (changedAt DESC) into
 * these functions; no raw SQL needed anywhere.
 */

/** One price-history observation. `changedAt` carried for ordering context. */
export interface PriceHistoryPoint {
    price: number;
    changedAt: Date;
}

/**
 * Percent change between the two most recent price-history rows, rounded to
 * 2 decimal places. Input must be ordered changedAt DESC (latest first).
 *
 * Returns null when fewer than 2 rows exist (no computable delta) or the
 * previous price is 0 (division guard). Negative for price drops.
 */
export function computeLatestPriceChangePercent(historyDesc: readonly PriceHistoryPoint[]): number | null {
    if (historyDesc.length < 2) return null;
    // Length checked above — indices 0 and 1 are present (noUncheckedIndexedAccess).
    const latest = historyDesc[0]!;
    const previous = historyDesc[1]!;
    if (previous.price === 0) return null;
    const percent = ((latest.price - previous.price) / previous.price) * 100;
    return Math.round(percent * 100) / 100;
}

/**
 * A listing "has price changes" when at least one price-history row exists —
 * rows are written exclusively on real price changes (see outcome.ts), so row
 * presence <=> change happened. (">= 2 rows OR any row" collapses to "any".)
 */
export function computePriceChanged(historyRowCount: number): boolean {
    return historyRowCount > 0;
}
