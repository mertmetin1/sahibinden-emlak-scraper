/**
 * @sahibindenbot/parser-sahibinden — public API.
 *
 * Dedicated sahibinden.com parser package (Phase 2). Owns:
 *  - the versioned selector registry (selectors/, SELECTOR_VERSION);
 *  - the category-page parser (moved from @sahibindenbot/scraper-engine —
 *    behavior EXACTLY preserved per docs/BASELINE_CONTRACT.md §1);
 *  - the detail-page parser (new): in-browser raw extraction + pure node-side
 *    normalization onto the frozen ListingDetail contract;
 *  - the upstream text/number helpers (formatPrice/extractCurrency/
 *    normalizeText/extractListingId — moved; randomDelay stays in the engine).
 *
 * In-browser extractors (extractCategoryRawInPage / extractDetailRawInPage)
 * are fully self-contained for page.evaluate serialization; normalizers are
 * pure node-side functions. No Apify/Crawlee imports anywhere in this package.
 */

// Versioned selector registry
export {
    SELECTOR_VERSION,
    CATEGORY_SELECTORS,
    DETAIL_SELECTORS,
    CATEGORY_ROW_SELECTOR,
    FALLBACK_ROW_SELECTORS,
    NEXT_PAGE_SELECTOR,
    DETAIL_READY_SELECTOR,
    CSS_OBFUSCATION_CLASS_PREFIX,
    type SelectorChain,
} from './selectors/index.js';

// Category page (moved from the engine — identical signatures/behavior)
export {
    extractCategoryRawInPage,
    normalizeCategoryItems,
    type RawCategoryRow,
} from './category-page.js';

// Detail page — in-browser extraction + raw shapes
export {
    extractDetailRawInPage,
    isUnavailableDetailHtml,
    buildCssContentMap,
    resolveObfuscatedText,
    UNAVAILABLE_NOTICE_NEEDLES,
    type RawDetailPage,
    type RawDetailAttribute,
    type RawSellerInfo,
    type RawPhoneCandidate,
} from './detail-page.js';

// Detail page — node-side normalization
export {
    normalizeDetail,
    buildAttributesRaw,
    mapKnownAttributes,
    classifySeller,
    classifyListingType,
    classifyProperty,
    pickPublicContactPhone,
    type NormalizeDetailContext,
    type SellerClassification,
} from './detail-normalize.js';

// Turkish text/number/date helpers (pure node-side)
export { trLower, parseTurkishDate, parseTrNumber, TURKISH_MONTHS } from './tr-text.js';

// Upstream utils (exact ports — behavior frozen by the baseline contract)
export { formatPrice, extractCurrency, normalizeText, extractListingId } from './utils.js';
