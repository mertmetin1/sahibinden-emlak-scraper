/**
 * @sahibindenbot/scraper-engine — public API.
 *
 * Local-first crawl runtime: Crawlee PuppeteerCrawler wiring, browser
 * acquisition (managed/CDP), category parsing, human-in-the-loop challenge
 * handling, typed errors, structured events. No Apify. No stealth. No
 * automated challenge solving (ADR-0002).
 */

// Entry point + SSRF guard
export { runCrawl, assertAllowedDomain } from './engine/run-crawl.js';

// Engine-local types (shared package is frozen this phase)
export type { CrawlDeps, ChallengeKind } from './types.js';

// Parser — split for fixture tests (in-page extractor + pure normalizer)
export {
    CATEGORY_ROW_SELECTOR,
    FALLBACK_ROW_SELECTORS,
    NEXT_PAGE_SELECTOR,
    extractCategoryRawInPage,
    normalizeCategoryItems,
} from './parser/category-page.js';
export type { RawCategoryRow } from './parser/category-page.js';

// Utils — exact upstream ports
export { formatPrice, extractCurrency, normalizeText, extractListingId, randomDelay } from './utils.js';

// Challenge detection (never solving)
export { isChallengedPage, isPxHoldChallenge, detectChallengeKind } from './engine/challenge.js';

// Error classification
export { crawlError, classifyError, classifyErrorMessages } from './engine/errors.js';

// Browser providers
export {
    type BrowserProvider,
    ManagedBrowserProvider,
    CdpBrowserProvider,
    createBrowserProvider,
} from './browser/browser-provider.js';

// Local adapters (replace Actor.* services)
export { JsonFileOutputRepository } from './adapters/json-output.js';
export { FsDebugArtifactStore } from './adapters/fs-debug-store.js';
export { StaticProxyProvider, NullProxyProvider, redactProxyUrl } from './adapters/proxy.js';
export { FileSessionProvider, StaticSessionProvider, normalizeCookieExport } from './adapters/session.js';
