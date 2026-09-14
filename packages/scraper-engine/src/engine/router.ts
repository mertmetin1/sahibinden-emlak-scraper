/**
 * Explicit request-label routing (Phase 2).
 *
 * Every request the engine enqueues carries `userData.label`:
 *   'CATEGORY' → category list page (rows + pagination)
 *   'DETAIL'   → single listing detail page
 *
 * The routing decision is a pure function so it can be unit-tested without
 * booting a crawler (see router.test.ts): a DETAIL request must NEVER fall
 * through to category parsing logic, and unknown labels must fail loudly
 * (upstream's DETAIL route was vestigial and silently unreachable).
 */
import { crawlError } from './errors.js';

/** Request labels the engine knows how to handle. */
export type RequestLabel = 'CATEGORY' | 'DETAIL';

/**
 * Maps `request.userData.label` to a handler label.
 * Throws CrawlError('UNSUPPORTED_LABEL') for anything else — including a
 * missing label (all engine-enqueued requests are always labeled).
 */
export function routeLabel(label: unknown): RequestLabel {
    if (label === 'CATEGORY') return 'CATEGORY';
    if (label === 'DETAIL') return 'DETAIL';
    throw crawlError('UNSUPPORTED_LABEL', `Unsupported request label: ${String(label)}`);
}
