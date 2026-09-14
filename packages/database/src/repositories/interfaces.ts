/**
 * Repository port interfaces + DTOs for the persistence layer.
 *
 * BOUNDARY RULE: this file must NEVER import from '@prisma/client'. Engine,
 * worker and api depend on these types only; the Prisma implementations live
 * beside this file and are the only code allowed to touch @prisma/client.
 *
 * Enum-like string unions mirror the Prisma enums 1:1 (same string values) so
 * consumers never need the generated client types.
 */
import type { CategoryListing, ListingDetail } from '@sahibindenbot/shared';

// ---------------------------------------------------------------------------
// Enum mirrors (string values identical to prisma/schema.prisma)
// ---------------------------------------------------------------------------

export type ListingStatusValue = 'ACTIVE' | 'STALE' | 'REMOVED';
export type SellerTypeValue = 'OWNER' | 'REAL_ESTATE_OFFICE' | 'CONSTRUCTION_COMPANY' | 'OTHER' | 'UNKNOWN';
export type ScanRunStatusValue =
    | 'QUEUED'
    | 'STARTING'
    | 'RUNNING'
    | 'CANCELLING'
    | 'CANCELLED'
    | 'SUCCEEDED'
    | 'PARTIAL'
    | 'FAILED';
export type ScanTriggerValue = 'MANUAL' | 'SCHEDULE' | 'TEST' | 'RETRY';
export type ListingOutcome = 'INSERTED' | 'UPDATED' | 'PRICE_CHANGED' | 'UNCHANGED';

// ---------------------------------------------------------------------------
// Upsert results
// ---------------------------------------------------------------------------

export interface UpsertSuccess {
    sourceListingId: string;
    listingId: string;
    outcome: ListingOutcome;
}

/**
 * Per-item failure, collected instead of thrown by batch entry points.
 * `code` is always 'DATABASE': every failure crossing this boundary is a
 * persistence-layer failure by definition (shared's CrawlErrorCode taxonomy).
 */
export interface UpsertItemError {
    sourceListingId: string | null;
    code: 'DATABASE';
    message: string;
}

export interface OutcomeCounts {
    inserted: number;
    updated: number;
    priceChanged: number;
    unchanged: number;
}

export interface BatchUpsertResult {
    results: UpsertSuccess[];
    errors: UpsertItemError[];
    counts: OutcomeCounts;
}

// ---------------------------------------------------------------------------
// Listing DTOs
// ---------------------------------------------------------------------------

export interface ListingRecord {
    id: string;
    source: string;
    sourceListingId: string;
    canonicalUrl: string;
    title: string;
    description: string;
    status: ListingStatusValue;
    price: number | null;
    currency: string;
    pricePerSquareMeter: number | null;
    listingType: string | null;
    propertyCategory: string | null;
    propertySubtype: string | null;
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
    province: string | null;
    district: string | null;
    neighborhood: string | null;
    locationRaw: string;
    listingDate: Date | null;
    listingDateRaw: string | null;
    updatedDate: Date | null;
    updatedDateRaw: string | null;
    publicContactPhone: string | null;
    videoUrl: string | null;
    virtualTourUrl: string | null;
    sellerId: string | null;
    /** DENORMALIZED mirror of Seller.type — filterable without a join. */
    sellerType: string | null;
    missedRunCount: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
    firstSeenRunId: string | null;
    lastSeenRunId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface SellerRecord {
    id: string;
    source: string;
    type: SellerTypeValue;
    typeEvidence: string | null;
    displayName: string | null;
    officeName: string | null;
    /** Null when the seller has no profile URL (DB stores the '' sentinel). */
    profileUrl: string | null;
    publicContactPhone: string | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

export interface ListingImageRecord {
    id: string;
    url: string;
    position: number;
    isPrimary: boolean;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

export interface ListingAttributeRecord {
    id: string;
    key: string;
    value: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

export interface ListingPriceHistoryRecord {
    id: string;
    price: number;
    currency: string;
    pricePerSquareMeter: number | null;
    runId: string | null;
    changedAt: Date;
}

export interface ListingSeenRecord {
    id: string;
    runId: string;
    seenAt: Date;
}

export interface ListingRunLinkRecord {
    runId: string;
    outcome: ListingOutcome;
    run: {
        id: string;
        scanDefinitionId: string;
        status: ScanRunStatusValue;
        createdAt: Date;
    };
}

/** List row: full listing scalar snapshot + derived fields for the UI. */
export interface ListingListRow extends ListingRecord {
    seller: SellerRecord | null;
    /** True when at least one price-history row exists (rows are change-only). */
    priceChanged: boolean;
    /** Percent change between the last two price rows, 2dp; null when < 2 rows. */
    latestPriceChangePercent: number | null;
}

export interface ListingDetailRecord extends ListingRecord {
    seller: SellerRecord | null;
    images: ListingImageRecord[];
    attributes: ListingAttributeRecord[];
    priceHistory: ListingPriceHistoryRecord[];
    seenHistory: ListingSeenRecord[];
    runLinks: ListingRunLinkRecord[];
}

// ---------------------------------------------------------------------------
// Listing queries
// ---------------------------------------------------------------------------

export interface ListingFilters {
    status?: ListingStatusValue;
    province?: string;
    district?: string;
    neighborhood?: string;
    sellerType?: string;
    listingType?: string;
    propertyCategory?: string;
    priceMin?: number;
    priceMax?: number;
    /** m² filters apply to grossAreaM2 (the site-advertised area). */
    m2Min?: number;
    m2Max?: number;
    rooms?: string;
    firstSeenFrom?: Date;
    lastSeenBefore?: Date;
    /** True = only listings with at least one price-history row. */
    priceChanged?: boolean;
    /** Only listings observed by runs of this scan definition. */
    scanId?: string;
    /** Case-insensitive substring over sourceListingId, title, description, seller names. */
    search?: string;
}

export type ListingSortField = 'price' | 'pricePerSquareMeter' | 'firstSeenAt' | 'lastSeenAt' | 'listingDate';

export interface ListingSort {
    field: ListingSortField;
    direction: 'asc' | 'desc';
}

export interface ListingListResult {
    rows: ListingListRow[];
    total: number;
    page: number;
    pageSize: number;
}

// ---------------------------------------------------------------------------
// Run DTOs
// ---------------------------------------------------------------------------

export interface RunCounters {
    pagesVisited: number;
    categoryPagesVisited: number;
    detailPagesVisited: number;
    itemsDiscovered: number;
    itemsInserted: number;
    itemsUpdated: number;
    pricesChanged: number;
    failedRequests: number;
    retryCount: number;
}

/** Counter field names match ScanRun column names exactly (incrementCounter). */
export type RunCounterField = keyof RunCounters;

export interface RunRecord {
    id: string;
    scanDefinitionId: string;
    status: ScanRunStatusValue;
    trigger: ScanTriggerValue;
    configurationSnapshot: unknown;
    counters: RunCounters;
    errorSummary: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    durationMs: number | null;
    heartbeatAt: Date | null;
    createdAt: Date;
}

export interface RunEventRecord {
    /** Decimal string of the BigInt autoincrement id — JSON-safe, doubles as SSE Last-Event-ID. */
    id: string;
    runId: string;
    type: string;
    data: unknown;
    createdAt: Date;
}

// ---------------------------------------------------------------------------
// Scan DTOs
// ---------------------------------------------------------------------------

export interface ScanRecord {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    startUrls: string[];
    schedule: string | null;
    timezone: string;
    maxItems: number | null;
    maxPages: number | null;
    includeDetails: boolean;
    incrementalMode: boolean;
    maxConcurrency: number;
    navigationTimeoutSeconds: number;
    requestHandlerTimeoutSeconds: number;
    maxRequestRetries: number;
    delayMinMs: number;
    delayMaxMs: number;
    browserMode: string;
    cdpUrl: string | null;
    proxyProfileId: string | null;
    cookieProfileId: string | null;
    sessionPolicyId: string | null;
    debugMode: boolean;
    storeRawHtml: boolean;
    storeScreenshotsOnFailure: boolean;
    staleDetectionEnabled: boolean;
    staleAfterSuccessfulRuns: number;
    allowedDomains: string[];
    humanInTheLoop: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface ScanCreateInput {
    name: string;
    startUrls: string[];
    description?: string;
    enabled?: boolean;
    schedule?: string | null;
    timezone?: string;
    maxItems?: number | null;
    maxPages?: number | null;
    includeDetails?: boolean;
    incrementalMode?: boolean;
    maxConcurrency?: number;
    navigationTimeoutSeconds?: number;
    requestHandlerTimeoutSeconds?: number;
    maxRequestRetries?: number;
    delayMinMs?: number;
    delayMaxMs?: number;
    browserMode?: string;
    cdpUrl?: string | null;
    proxyProfileId?: string | null;
    cookieProfileId?: string | null;
    sessionPolicyId?: string | null;
    debugMode?: boolean;
    storeRawHtml?: boolean;
    storeScreenshotsOnFailure?: boolean;
    staleDetectionEnabled?: boolean;
    staleAfterSuccessfulRuns?: number;
    allowedDomains?: string[];
    humanInTheLoop?: boolean;
}

export type ScanUpdateInput = Partial<ScanCreateInput>;

// ---------------------------------------------------------------------------
// Repository ports
// ---------------------------------------------------------------------------

export interface ListingRepository {
    /**
     * Upserts ONE category observation in a single transaction:
     * identity = (source='sahibinden.com', sourceListingId=item.id).
     * Always refreshes lastSeenAt/lastSeenRunId, resets missedRunCount and
     * resurrects status to ACTIVE; writes ListingSeenHistory + ScanRunListing
     * on every observation; writes ListingPriceHistory only on a real price
     * change (both prices non-null and different). Throws CrawlError on failure.
     */
    upsertCategoryListing(item: CategoryListing, runId: string): Promise<UpsertSuccess>;
    /** Batch variant: per-item try/catch — one failing item never poisons the batch. */
    upsertCategoryListings(items: CategoryListing[], runId: string): Promise<BatchUpsertResult>;
    /**
     * Upserts ONE detail observation: same identity/seen rules as category,
     * plus seller resolution (sentinel '' profileUrl), image replace-refresh,
     * attribute refresh, and category-field merge for null detail fields.
     * detail.unavailable === true marks the listing REMOVED immediately.
     */
    upsertDetailListing(detail: ListingDetail, runId: string): Promise<UpsertSuccess>;
    upsertDetailListings(details: ListingDetail[], runId: string): Promise<BatchUpsertResult>;
    /** Bulk observation journal writer (alternative to per-item upsert side effects). */
    markRunObservations(runId: string, pairs: Array<{ listingId: string; outcome: ListingOutcome }>): Promise<void>;
    /** Explicit site signal only ("yayından kaldırıldı"). Never called for absence. */
    markRemoved(listingId: string): Promise<boolean>;
    /**
     * Staleness evaluation after a non-incremental SUCCEEDED run:
     * listings expected (seen by previous successful non-incremental runs of
     * this scan) but absent here get missedRunCount+1; at the scan's
     * staleAfterSuccessfulRuns threshold they become STALE. Present listings
     * are resurrected (missedRunCount=0, ACTIVE). No-op for incremental,
     * non-SUCCEEDED, or stale-detection-disabled scans. A single absence
     * NEVER marks stale (threshold default is 3).
     */
    applySuccessfulRunStaleness(
        scanDefinitionId: string,
        runId: string,
    ): Promise<{ staleMarked: number; resurrected: number }>;
    listWithDerived(
        filters: ListingFilters,
        page: number,
        pageSize: number,
        sort?: ListingSort,
    ): Promise<ListingListResult>;
    getById(id: string): Promise<ListingDetailRecord | null>;
}

export interface RunRepository {
    createRun(
        scanDefinitionId: string,
        trigger: ScanTriggerValue,
        configurationSnapshot: unknown,
    ): Promise<RunRecord>;
    updateStatus(
        runId: string,
        status: ScanRunStatusValue,
        timestamps?: { startedAt?: Date; finishedAt?: Date; durationMs?: number },
    ): Promise<void>;
    heartbeat(runId: string): Promise<void>;
    addEvent(runId: string, type: string, data?: unknown): Promise<RunEventRecord>;
    incrementCounter(runId: string, field: RunCounterField, by?: number): Promise<void>;
    /** Terminal write: status + absolute counters + finishedAt; durationMs derived from startedAt. */
    finishRun(
        runId: string,
        status: ScanRunStatusValue,
        counters: Partial<RunCounters>,
        errorSummary?: string | null,
    ): Promise<void>;
    listRuns(
        scanId?: string,
        status?: ScanRunStatusValue,
        page?: number,
        pageSize?: number,
    ): Promise<{ rows: RunRecord[]; total: number }>;
    /** Run + events with id > afterEventId (SSE replay via Last-Event-ID). */
    getRunWithEvents(
        runId: string,
        afterEventId?: string | number | bigint,
    ): Promise<{ run: RunRecord; events: RunEventRecord[] } | null>;
    /** STARTING/RUNNING/CANCELLING runs whose heartbeat (or creation) is older than olderThanMs — sweeper input. */
    findStaleRunningRuns(olderThanMs: number): Promise<RunRecord[]>;
}

export interface ScanRepository {
    create(data: ScanCreateInput): Promise<ScanRecord>;
    getById(id: string): Promise<ScanRecord | null>;
    update(id: string, patch: ScanUpdateInput): Promise<ScanRecord>;
    delete(id: string): Promise<void>;
    list(
        filters?: { enabled?: boolean; q?: string },
        page?: number,
        pageSize?: number,
    ): Promise<{ rows: ScanRecord[]; total: number }>;
    /** Copies the definition with ' (kopya)' name suffix and enabled=false. */
    duplicate(id: string): Promise<ScanRecord>;
    listWithLatestRun(): Promise<Array<{ scan: ScanRecord; latestRun: RunRecord | null }>>;
}
