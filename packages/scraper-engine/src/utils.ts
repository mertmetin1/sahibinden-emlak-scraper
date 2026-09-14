/**
 * Engine-local helpers.
 *
 * `formatPrice` / `extractCurrency` / `normalizeText` / `extractListingId`
 * moved to `@sahibindenbot/parser-sahibinden` in Phase 2 (parser ownership);
 * they are re-exported from this package's `index.ts` so existing consumers
 * keep working unchanged.
 */

/**
 * Adds delay between actions to keep request pacing polite.
 * Exact port of upstream `randomDelay` (inclusive integer range).
 */
export function randomDelay(min = 1000, max = 5000): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}
