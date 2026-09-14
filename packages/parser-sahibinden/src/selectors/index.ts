/**
 * Versioned selector registry for sahibinden.com parsing.
 *
 * Every selector cites its evidence: upstream `src/main.js` line references
 * (commit a14740c, see docs/UPSTREAM_AUDIT.md §4) for category pages, and the
 * sanitized fixtures under fixtures/html/ for detail pages (captured
 * 2026-09-14, see docs/BASELINE_CONTRACT.md §5).
 *
 * Bump SELECTOR_VERSION whenever any selector changes so parse regressions
 * can be correlated with selector edits.
 */

/** Registry version: <date>.<revision-of-the-day>. */
export const SELECTOR_VERSION = '2026-09-14.1';

/** A primary selector plus ordered fallbacks (first non-empty match wins). */
export interface SelectorChain {
    readonly primary: string;
    readonly fallbacks: readonly string[];
    /** Where this selector was verified (fixture / upstream line). */
    readonly evidence: string;
}

// ---------------------------------------------------------------------------
// Category pages
// ---------------------------------------------------------------------------

export const CATEGORY_SELECTORS = {
    /**
     * Listing rows. Primary + 7 fallbacks ported 1:1 from upstream
     * main.js:652,676-682. Verified: fixtures/html/category-satilik-adana-seyhan.html
     * (52 rows match the primary: 50 organic + 1 promoted + 1 native-ad row
     * that normalizeCategoryItems silently skips).
     */
    row: {
        primary: 'tbody.searchResultsRowClass > tr.searchResultsItem',
        fallbacks: [
            'table.searchResultsTable tr.searchResultsItem',
            '.searchResultsRowClass .searchResultsItem',
            'tr.searchResultsItem',
            '.classified-list-item',
            '[data-id]', // intentionally broad upstream (audit §14.1) — parity preserved
            '.searchResults .result-item',
            'table tr[data-id]',
        ],
        evidence: 'upstream main.js:652,676-682; category-satilik-adana-seyhan.html (52 rows)',
    },
    /** Title anchor (text + absolute detail URL via a.href). upstream main.js:653. */
    title: 'td.searchResultsTitleValue a.classifiedTitle',
    /** Price cell text ("4.749.000 TL"). upstream main.js:654. */
    price: 'td.searchResultsPriceValue span',
    /** Price-per-m² cell — COLUMN-ORDER DEPENDENT (audit §14.2). upstream main.js:655. */
    pricePerSqm: 'td.searchResultsPriceValue:nth-of-type(2)',
    /** First attribute cell only (upstream quirk, audit §14.3). upstream main.js:656. */
    area: 'td.searchResultsAttributeValue',
    /** Date cell (innerText, newlines → ' '). upstream main.js:657. */
    date: 'td.searchResultsDateValue',
    /** Location cell (innerText, newlines → ' / '). upstream main.js:658. */
    location: 'td.searchResultsLocationValue',
    /** First row image: `src || dataset.src`. upstream main.js:754. */
    image: 'img',
    /**
     * Next-page link ("Sonraki" = Turkish "Next"); `.passive` = disabled.
     * upstream main.js:659,799. Locale/rename fragile (audit §14.8).
     */
    nextPage: 'a.prevNextBut[title="Sonraki"]:not(.passive)',
} as const;

/** Primary listing-row selector (upstream main.js:652). */
export const CATEGORY_ROW_SELECTOR = CATEGORY_SELECTORS.row.primary;

/** Fallback row selectors, tried in order, first non-empty wins. */
export const FALLBACK_ROW_SELECTORS: readonly string[] = CATEGORY_SELECTORS.row.fallbacks;

/** Next-page link ("Sonraki"); `.passive` means disabled. */
export const NEXT_PAGE_SELECTOR = CATEGORY_SELECTORS.nextPage;

// ---------------------------------------------------------------------------
// Detail pages (evidence: fixtures/html/detail-sample-{1,2,3}.html)
// ---------------------------------------------------------------------------

export const DETAIL_SELECTORS = {
    /**
     * Element whose presence marks a detail page as fully rendered. The
     * attribute list is the page's data core and is present in all three
     * sanitized fixtures (detail-sample-1.html:4493, -2:4001, -3:3932).
     * Absent on removed-listing notice pages → drives the unavailable path.
     */
    ready: {
        primary: 'ul.classifiedInfoList',
        fallbacks: ['.classifiedDetailTitle h1', '#classifiedDescription', '.classifiedInfo'],
        evidence: 'detail-sample-1.html:4493, detail-sample-2.html:4001, detail-sample-3.html:3932',
    },
    /** Listing title. detail-sample-1.html:2973-2974 (`<div class="classifiedDetailTitle"><h1>…`). */
    title: {
        primary: '.classifiedDetailTitle h1',
        fallbacks: ['h1'],
        evidence: 'detail-sample-1.html:2973, detail-sample-2.html:2971, detail-sample-3.html:2982',
    },
    /**
     * Price text, e.g. " 4.575.000 TL" (note leading space — trimmed later).
     * Fallback: the hidden #favoriteClassifiedPrice input mirrors the price
     * (detail-sample-1.html:4482) — used only when the visible span is gone.
     */
    price: {
        primary: '.classifiedInfo h3 span.classified-price-wrapper',
        fallbacks: ['span.classified-price-wrapper'],
        evidence: 'detail-sample-1.html:4393, detail-sample-2.html:3901, detail-sample-3.html:3832',
    },
    /** Hidden input mirroring the displayed price (fallback source only). */
    priceFallbackInput: '#favoriteClassifiedPrice',
    /**
     * Property info list: EVERY <li> is <strong>label</strong>&nbsp;<span>value</span>.
     * detail-sample-1.html:4493-4641 (24 pairs), detail-sample-3.html:3932-4061.
     */
    attributeList: {
        primary: 'ul.classifiedInfoList li',
        fallbacks: ['.classifiedInfoList li'],
        evidence: 'detail-sample-1.html:4493, detail-sample-2.html:4001, detail-sample-3.html:3932',
    },
    attributeLabel: 'strong',
    attributeValue: 'span',
    /**
     * Description block. `#classifiedDescription` is the id; the class
     * `.classifiedDescription` is ALSO used by the #classifiedProperties
     * feature list (detail-sample-1.html:5030) — never select by class alone.
     */
    description: {
        primary: '#classifiedDescription',
        fallbacks: ['.uiBoxContainer#classifiedDescription'],
        evidence: 'detail-sample-1.html:5017, detail-sample-3.html:4429',
    },
    /**
     * Category breadcrumb: Emlak > Konut > Satılık > Daire > Adana > …
     * Each li.bc-item also embeds a .bc-tooltip with sibling-category links —
     * take only the DIRECT child anchor (`:scope > a span`), never all anchors.
     * detail-sample-1.html:2597-2832.
     */
    breadcrumb: {
        primary: '.search-result-bc li.bc-item',
        fallbacks: ['.classifiedBreadCrumbBackground ~ .search-result-bc li.bc-item'],
        evidence: 'detail-sample-1.html:2597-2832 (8 items: Emlak/Konut/Satılık/Daire/Adana/Seyhan/…)',
    },
    /**
     * Address breadcrumb (province / district / neighborhood), inside
     * `.classifiedInfo` right before the attribute list.
     * detail-sample-1.html:4484-4492 (Adana / Seyhan / Pınar Mh.).
     */
    address: {
        primary: '.classifiedInfo h2 a[data-click-label^="Adres Breadcrumb"]',
        fallbacks: ['a[data-click-label^="Adres Breadcrumb"]'],
        evidence: 'detail-sample-1.html:4484-4492, detail-sample-3.html:3924-3931',
    },
    /** Listing id: <span class="classifiedId" data-classifiedid="1340140183">. */
    listingId: {
        primary: 'span.classifiedId[data-classifiedid]',
        fallbacks: ['#classifiedId'],
        evidence: 'detail-sample-1.html:4497, detail-sample-3.html:3936',
    },
    /** Canonical URL link tag (og:url meta as fallback). */
    canonical: {
        primary: 'link[rel="canonical"]',
        fallbacks: ['meta[property="og:url"]'],
        evidence: 'detail-sample-1.html (canonical link), detail-sample-3.html:81',
    },
    /**
     * Seller — store/office block (REAL_ESTATE_OFFICE evidence).
     * `.user-info-store-card` sits inside `.user-info-module` in the main
     * content (detail-sample-1.html:4686-4696, detail-sample-2.html:4194-4204);
     * `.sticky-header-store-name` is the sticky-header mirror
     * (detail-sample-1.html:5730-5733); `.store-info-group` is the
     * "office's other listings" card (detail-sample-1.html:5682-5687).
     */
    sellerStoreCard: '.user-info-store-card',
    sellerStoreName: '.user-info-store-name a',
    sellerStoreInfoGroup: '.store-info-group .store-name-wrapper h5',
    sellerStickyStoreName: '.sticky-header-store-name a',
    /**
     * Seller — agent name within a store block (detail-sample-1.html:4704
     * "Test A.", detail-sample-2.html:4212 "Test Satıcı"; sticky mirror at
     * detail-sample-1.html:5734-5735).
     */
    sellerAgentName: '.user-info-agent h3',
    sellerStickyAgentName: '.sticky-header-name',
    /**
     * Seller — individual owner block (OWNER evidence).
     * `.classifiedUserBox.classified-owner-info` wraps `.username-info-area`
     * whose h5 span is CSS-OBFUSCATED (detail-sample-3.html:4094-4101).
     * NOTE: `sticky-header-indivudial-name` is the upstream's own misspelling
     * ("indivudial") — keep the typo, it is the real class
     * (detail-sample-3.html:5438-5441).
     */
    sellerIndividualBox: '.classifiedUserBox.classified-owner-info',
    sellerIndividualName: '.classifiedUserBox.classified-owner-info .username-info-area',
    sellerStickyIndividualName: '.sticky-header-indivudial-name', // [sic] upstream typo
    sellerRegistrationDate: '.userRegistrationDate, .sticky-header-registration-date',
    /**
     * Phone candidates, in preference order:
     * 1. `.sticky-header-phone span[data-opened]` — the site's own "opened"
     *    rendering of the contact phone (detail-sample-1.html:5736-5739,
     *    detail-sample-3.html:5445-5450 — CSS-obfuscated text + data-opened).
     * 2. `.user-info-phones .dl-group` — main-content phone list, dt=label
     *    ("Cep"/"İş"), dd=visible number (detail-sample-1.html:4721-4728,
     *    detail-sample-2.html:4229-4240).
     * 3. `#phoneInfoPart li` — individual-seller phone: `.pretty-phone-part`
     *    renders via `content: attr(data-content)`, `.encrypted-phone-part`
     *    renders the MASKED number via CSS content (detail-sample-3.html:4182-4192).
     * LEGAL BOUNDARY: only already-rendered DOM text / data-opened attributes
     * are read. No reveal interaction is ever triggered.
     */
    phoneSticky: '.sticky-header-phone [data-opened], .sticky-header-phone [data-encrypted]',
    phoneMainList: '.user-info-phones .dl-group',
    phoneIndividual: '#phoneInfoPart li',
    /**
     * Gallery: `.classifiedDetailMainPhoto` holds one <label> per photo in
     * display order; most imgs are <label><picture><img>, some are direct
     * <label><img> children (detail-sample-1.html:3451) — hence `label img`.
     * The first <img> has a real `src`, lazy ones carry the URL in `data-src`
     * with a blank-placeholder `src` (detail-sample-1.html:3255-3285).
     * URLs are https://i0.shbdn.com/photos/…/x5_<id><hash>.jpg (528×396 display
     * size). `.classifiedDetailThumbList` holds thmb_ thumbnails of the SAME
     * photos (detail-sample-3.html:3400-3408) — fallback only.
     */
    galleryMain: '.classifiedDetailPhotos .classifiedDetailMainPhoto label img',
    galleryThumbs: '.classifiedDetailThumbList img',
    galleryOgImage: 'meta[property="og:image"]',
    /**
     * Video: JSON-LD <script type="application/ld+json"> with
     * @type=VideoObject carries embedUrl (detail-sample-3.html:83-92).
     */
    videoJsonLd: 'script[type="application/ld+json"]',
    /**
     * Virtual tour link. `passive` class = unavailable (all three fixtures);
     * only an active link yields a URL.
     */
    virtualTour: 'a#virtual-tour:not(.passive)',
} as const;

/** Element whose presence marks a fully rendered detail page. */
export const DETAIL_READY_SELECTOR = DETAIL_SELECTORS.ready.primary;

/**
 * CSS-obfuscation pattern (docs/BASELINE_CONTRACT.md §4): seller name/phone
 * render as `<style>.css<uuid>:before{content:'…'}</style><span class="css<uuid>"></span>`.
 * Also seen with `content: attr(data-content)` (detail-sample-3.html:4186-4188).
 * The extractors build a class→content map from all <style> tags and resolve
 * these spans generically — see detail-page.ts.
 */
export const CSS_OBFUSCATION_CLASS_PREFIX = 'css';
