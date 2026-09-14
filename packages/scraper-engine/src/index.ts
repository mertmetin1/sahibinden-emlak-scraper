/**
 * @sahibindenbot/scraper-engine — public API.
 *
 * Local-first crawl runtime: Crawlee PuppeteerCrawler wiring, browser
 * acquisition (managed/CDP), category + detail crawling, human-in-the-loop
 * challenge handling, typed errors, structured events. No Apify. No stealth.
 * No automated challenge solving (ADR-0002).
 *
 * Parsing itself is owned by `@sahibindenbot/parser-sahibinden` (Phase 2);
 * the parser symbols are re-exported here so Phase-1 consumers (tests/, CLI)
 * keep working unchanged.
 */

// Entry point + SSRF guard
export { runCrawl, assertAllowedDomain } from './engine/run-crawl.js';

// Engine-local types (shared package is frozen this phase)
export type { CrawlDeps, ChallengeKind, SessionPolicyConfig } from './types.js';

// Parser — owned by @sahibindenbot/parser-sahibinden, re-exported for
// backward compatibility with existing consumers.
export {
    CATEGORY_ROW_SELECTOR,
    FALLBACK_ROW_SELECTORS,
    NEXT_PAGE_SELECTOR,
    DETAIL_READY_SELECTOR,
    extractCategoryRawInPage,
    normalizeCategoryItems,
    extractDetailRawInPage,
    normalizeDetail,
    isUnavailableDetailHtml,
    formatPrice,
    extractCurrency,
    normalizeText,
    extractListingId,
} from '@sahibindenbot/parser-sahibinden';
export type { RawCategoryRow, RawDetailPage } from '@sahibindenbot/parser-sahibinden';

// Explicit request-label routing
export { routeLabel, type RequestLabel } from './engine/router.js';

// Engine-local utils
export { randomDelay } from './utils.js';

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
export {
    StaticProxyProvider,
    NullProxyProvider,
    ProfileProxyProvider,
    redactProxyUrl,
    buildProxyUrl,
    describeEndpoint,
    normalizeProxyProtocol,
} from './adapters/proxy.js';
export type { ProxyEndpointInput, ProxyRotationStrategy } from './adapters/proxy.js';
export { ProxyHealthChecker, classifyProxyError } from './adapters/proxy-health.js';
export type { ProxyCheckResult, ProxyCheckErrorKind, CheckEndpointOptions } from './adapters/proxy-health.js';
export { FileSessionProvider, StaticSessionProvider, normalizeCookieExport } from './adapters/session.js';

// ScanDefinition snapshot → CrawlConfig mapping (Phase 4 worker wiring)
export { crawlConfigFromSnapshot, SNAPSHOT_DEFAULTS } from './engine/config-from-snapshot.js';
export type { ScanDefinitionSnapshot } from './engine/config-from-snapshot.js';
