/**
 * Pure outcome-classification logic for listing upserts.
 *
 * Extracted from the Prisma repository so the decision matrix is unit-testable
 * without a database. No I/O, no imports beyond types.
 */
import type { ListingOutcome } from './interfaces.js';

/** Normalized price point used for change detection (TL unless noted). */
export interface PricePoint {
    price: number | null;
    currency: string;
}

/**
 * The ONLY price transition that earns a ListingPriceHistory row and the
 * PRICE_CHANGED outcome: both sides non-null and different.
 *
 * - null  -> value : first price observation, not a *change* (no baseline)
 * - value -> null  : price disappeared from the page — ordinary field update,
 *                    never a history row (history rows require an Int price)
 * - value -> same  : unchanged
 * - value -> other : PRICE_CHANGED
 *
 * Currency moves with an identical price are NOT price changes (they surface
 * as ordinary UPDATED via mutable-field comparison).
 */
export function isPriceChange(existing: PricePoint, incoming: PricePoint): boolean {
    return existing.price !== null && incoming.price !== null && existing.price !== incoming.price;
}

/**
 * Maps (existing snapshot, incoming snapshot, did-any-mutable-field-change)
 * to the per-observation outcome journal value.
 *
 * @param existing             null when the listing has never been seen
 * @param incoming             normalized incoming price point
 * @param mutableFieldsChanged result of the repository's field-by-field compare
 *                             (price itself counts as a mutable field)
 */
export function decideOutcome(
    existing: PricePoint | null,
    incoming: PricePoint,
    mutableFieldsChanged: boolean,
): ListingOutcome {
    if (existing === null) return 'INSERTED';
    if (isPriceChange(existing, incoming)) return 'PRICE_CHANGED';
    return mutableFieldsChanged ? 'UPDATED' : 'UNCHANGED';
}
