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
}
