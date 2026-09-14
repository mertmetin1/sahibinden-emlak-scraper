/**
 * Shared contracts for the sahibinden-bot monorepo.
 *
 * These types are the integration boundary between the scraper engine,
 * the CLI/worker apps, and (later) persistence/queue packages.
 * Phase 1 scope: local CLI crawling without Apify.
 */

// ---------------------------------------------------------------------------
// Cookies (authorized, user-supplied)
// ---------------------------------------------------------------------------

export interface CookieParam {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    /** Unix seconds. Absent = session cookie. */
    expires?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
}

// ---------------------------------------------------------------------------
// Crawl configuration (typed replacement for Actor.getInput)
// ---------------------------------------------------------------------------

export type BrowserMode = 'managed' | 'cdp';

export interface BrowserConfig {
    mode: BrowserMode;
    /** CDP endpoint, e.g. http://127.0.0.1:9222 — required when mode = 'cdp'. */
    cdpUrl?: string;
    /** Managed mode only. Default true. */
    headless?: boolean;
}

export interface ProxyConfig {
    /** Conventional proxy URLs: protocol://[user:pass@]host:port */
    urls: string[];
}

export interface CrawlConfig {
    /** Human-readable name (used in logs/artifacts). */
    name?: string;
    startUrls: string[];
    maxItems: number | null;
    /** Hard cap on category pages. null = follow pagination to the end. */
    maxPages: number | null;
    /** When true, every discovered listing URL is enqueued as a DETAIL request. */
    includeDetails: boolean;
    maxConcurrency: number;
    navigationTimeoutSeconds: number;
    requestHandlerTimeoutSeconds: number;
    maxRequestRetries: number;
    delayMinMs: number;
    delayMaxMs: number;
    debugMode: boolean;
    /** Persist raw HTML of parsed pages via DebugArtifactStore. */
    storeRawHtml: boolean;
    browser: BrowserConfig;
    proxy: ProxyConfig | null;
    /**
     * Path (relative to cwd) to a JSON file containing an array of cookies.
     * Secrets stay out of the config file itself; the file must be gitignored.
     */
    sessionCookiesFile: string | null;
    /** SSRF guard: only these domains may be crawled. */
    allowedDomains: string[];
    /** Output directory for the local JSON dataset. */
    outputDir: string;
    /**
     * When the browser is visible (CDP / headed managed), pause and wait for
     * a HUMAN to solve an anti-bot challenge. Never solves automatically.
     */
    humanInTheLoop: boolean;
    /** Max seconds to wait for a human solve per challenge. */
    humanInTheLoopTimeoutSeconds: number;
}

// ---------------------------------------------------------------------------
// Listings — baseline output contract (see docs/BASELINE_CONTRACT.md)
// ---------------------------------------------------------------------------

/** Exact upstream category-page output shape. Do not rename/retype fields. */
export interface CategoryListing {
    id: string | null;
    url: string;
    title: string;
    price: number | null;
    price_currency: string;
    price_raw: string | null;
    price_per_sqm: string;
    area: string;
    location: string;
    date: string;
    image: string | null;
    scrapedAt: string;
    sourceUrl: string;
}

// ---------------------------------------------------------------------------
// Detail pages — normalized ListingDetail (Phase 2)
// ---------------------------------------------------------------------------

export type SellerType = 'OWNER' | 'REAL_ESTATE_OFFICE' | 'CONSTRUCTION_COMPANY' | 'OTHER' | 'UNKNOWN';

export interface ListingImage {
    url: string;
    position: number;
    isPrimary: boolean;
}

/**
 * Normalized detail-page record. Raw Turkish attribute values are preserved
 * as-is (lossless); `attributesRaw` keeps EVERY label/value pair so unknown
 * future fields are never lost.
 */
export interface ListingDetail {
    // identity & source
    listingId: string | null;
    canonicalUrl: string;
    source: string; // 'sahibinden.com'
    sourceUrl: string; // detail page URL
    scrapedAt: string;
    /** Category-row discovery data, carried through when the detail was reached via a category. */
    category?: CategoryListing;
    // core
    title: string;
    description: string;
    price: number | null;
    currency: string;
    priceRaw: string | null;
    pricePerSquareMeter: number | null;
    // classification
    listingType: 'SALE' | 'RENT' | 'UNKNOWN';
    propertyCategory: string | null;
    propertySubtype: string | null;
    // property attributes (normalized, raw Turkish values preserved)
    grossAreaM2: number | null;
    netAreaM2: number | null;
    rooms: string | null;
    buildingAge: string | null;
    floor: string | null;
    totalFloors: string | null;
    heating: string | null;
    bathroomCount: string | null;
    balcony: string | null;
    furnished: string | null;
    usageStatus: string | null;
    insideSite: string | null;
    siteName: string | null;
    dues: string | null;
    deposit: string | null;
    deedStatus: string | null;
    creditEligible: string | null;
    exchangeEligible: string | null;
    // location
    province: string | null;
    district: string | null;
    neighborhood: string | null;
    locationRaw: string;
    // dates (ISO when parseable + raw preserved)
    listingDate: string | null;
    listingDateRaw: string | null;
    updatedDate: string | null;
    updatedDateRaw: string | null;
    // seller
    sellerType: SellerType;
    /** What drove the classification (selector/attribute evidence). Null when UNKNOWN. */
    sellerTypeEvidence: string | null;
    sellerDisplayName: string | null;
    officeName: string | null;
    sellerProfileUrl: string | null;
    /** Only when already rendered in the normally authorized DOM. Never via reveal automation. */
    publicContactPhone: string | null;
    // media
    images: ListingImage[];
    videoUrl: string | null;
    virtualTourUrl: string | null;
    // raw survival
    attributesRaw: Record<string, string>;
    /** True when the page is an unavailable/removed listing notice. */
    unavailable: boolean;
}

// ---------------------------------------------------------------------------
// Errors — typed classification (replaces upstream's stringly errors)
// ---------------------------------------------------------------------------

export type CrawlErrorCode =
    | 'NETWORK'
    | 'TIMEOUT'
    | 'AUTH_REQUIRED'
    | 'INVALID_PAGE'
    | 'PARSER_CHANGED'
    | 'PROXY_ERROR'
    | 'RATE_LIMIT'
    | 'DATABASE'
    | 'CANCELLED'
    | 'UNSUPPORTED_LABEL'
    | 'UNKNOWN';

export class CrawlError extends Error {
    constructor(
        public readonly code: CrawlErrorCode,
        message: string,
        public override readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'CrawlError';
    }
}

// ---------------------------------------------------------------------------
// Events (structured; SSE-streamable later)
// ---------------------------------------------------------------------------

export type CrawlEventType =
    | 'RUN_STARTED'
    | 'CATEGORY_STARTED'
    | 'CATEGORY_PARSED'
    | 'LISTING_DISCOVERED'
    | 'DETAIL_STARTED'
    | 'DETAIL_PARSED'
    | 'DETAIL_UNAVAILABLE'
    | 'REQUEST_RETRY'
    | 'REQUEST_FAILED'
    | 'SESSION_RETIRED'
    | 'PROXY_FAILURE'
    | 'CHALLENGE_DETECTED'
    | 'HUMAN_SOLVE_REQUESTED'
    | 'HUMAN_SOLVE_RESOLVED'
    | 'RUN_COMPLETED'
    | 'RUN_FAILED';

export interface CrawlEvent {
    type: CrawlEventType;
    at: string; // ISO
    /** Redacted payload — MUST never contain cookies, proxy credentials, headers. */
    data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dependency ports (replace Actor.* / Apify services)
// ---------------------------------------------------------------------------

/** Replaces Actor.pushData — batch sink for parsed listings. */
export interface OutputRepository {
    upsertListings(items: CategoryListing[]): Promise<void>;
    /** Detail records (category data already merged by the engine). */
    upsertDetails(items: ListingDetail[]): Promise<void>;
    finalize(): Promise<void>;
}

/** Replaces Actor.setValue for debug artifacts. NEVER receives cookies. */
export interface DebugArtifactStore {
    saveHtml(label: string, html: string): Promise<void>;
    saveScreenshot(label: string, png: Uint8Array): Promise<void>;
}

/** Provides a Crawlee ProxyConfiguration (or null = direct). */
export interface ProxyProvider {
    /** Crawlee ProxyConfiguration instance or null. Typed as unknown here to
     *  keep shared/ free of crawlee imports; engine casts at the boundary. */
    getProxyConfiguration(): Promise<unknown | null>;
}

/** Supplies authorized cookies for session establishment. */
export interface SessionProvider {
    getCookies(): Promise<CookieParam[]>;
}

/** Structured logger (pino-backed). */
export interface RuntimeLogger {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    debug(msg: string, data?: Record<string, unknown>): void;
}

export interface EventSink {
    emit(event: CrawlEvent): void;
}

/** Cooperative cancellation. */
export interface CancellationToken {
    readonly isCancelled: boolean;
}

// ---------------------------------------------------------------------------
// Queue contracts (Phase 4) — Postgres is run-state truth; BullMQ is transport
// ---------------------------------------------------------------------------

/** BullMQ crawl job payload. The run row (with configurationSnapshot) is created
 *  BEFORE enqueue; the worker rehydrates from the DB — the job carries only the id. */
export interface CrawlJobData {
    runId: string;
}

export const CRAWL_QUEUE = 'crawl-queue';
export const MAINTENANCE_QUEUE = 'maintenance-queue';

/** Redis key/channel helpers (single source for both api and worker). */
export const RedisKeys = {
    cancelKey: (runId: string) => `sahbot:cancel:${runId}`,
    scanLockKey: (scanDefinitionId: string) => `sahbot:lock:scan:${scanDefinitionId}`,
    runEventsChannel: (runId: string) => `run-events:${runId}`,
} as const;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type CrawlRunStatus = 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

export interface CrawlResult {
    status: CrawlRunStatus;
    itemsDiscovered: number;
    itemsWritten: number;
    categoryPagesVisited: number;
    failedRequests: number;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    errors: Array<{ code: CrawlErrorCode; message: string; url?: string }>;
    /** Detail pages handled (parsed or confirmed unavailable). Present only when includeDetails. */
    detailPagesVisited?: number;
    /** Detail records written to the output repository. Present only when includeDetails. */
    detailsWritten?: number;
}
