/**
 * API DTO types — hand-written mirrors of the Fastify route responses in
 * apps/api/src/routes/* and the repository DTOs in
 * packages/database/src/repositories/interfaces.ts. Dates arrive as ISO
 * strings over JSON. Trust the route code, not docs/ARCHITECTURE.md.
 */

// ---------------------------------------------------------------------------
// Enum mirrors (string values identical to the API)
// ---------------------------------------------------------------------------

export type SellerType = 'OWNER' | 'REAL_ESTATE_OFFICE' | 'CONSTRUCTION_COMPANY' | 'OTHER' | 'UNKNOWN';
export type ListingStatus = 'ACTIVE' | 'STALE' | 'REMOVED';
export type RunStatus =
    | 'QUEUED'
    | 'STARTING'
    | 'RUNNING'
    | 'CANCELLING'
    | 'CANCELLED'
    | 'SUCCEEDED'
    | 'PARTIAL'
    | 'FAILED';
export type RunTrigger = 'MANUAL' | 'SCHEDULE' | 'TEST' | 'RETRY';
export type ProxyStrategy = 'ROUND_ROBIN' | 'SESSION_STICKY';
export type ProxyHealth = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'DISABLED';
export type CookieValidationStatus = 'UNKNOWN' | 'VALID' | 'EXPIRED' | 'INVALID';
export type ListingOutcome = 'INSERTED' | 'UPDATED' | 'PRICE_CHANGED' | 'UNCHANGED';
export type BrowserMode = 'cdp' | 'managed';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['QUEUED', 'STARTING', 'RUNNING', 'CANCELLING'];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'];

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export interface SellerDto {
    id: string;
    source: string;
    type: SellerType;
    typeEvidence: string | null;
    displayName: string | null;
    officeName: string | null;
    profileUrl: string | null;
    publicContactPhone: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    createdAt: string;
    updatedAt: string;
}

/** Listing scalar snapshot (ListingRecord in the database package). */
export interface ListingBaseDto {
    id: string;
    source: string;
    sourceListingId: string;
    canonicalUrl: string;
    title: string;
    description: string;
    status: ListingStatus;
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
    listingDate: string | null;
    listingDateRaw: string | null;
    updatedDate: string | null;
    updatedDateRaw: string | null;
    publicContactPhone: string | null;
    videoUrl: string | null;
    virtualTourUrl: string | null;
    sellerId: string | null;
    sellerType: string | null;
    missedRunCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    firstSeenRunId: string | null;
    lastSeenRunId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ListingListRow extends ListingBaseDto {
    seller: SellerDto | null;
    priceChanged: boolean;
    latestPriceChangePercent: number | null;
    thumbnailUrl: string | null;
}

export interface ListingImageDto {
    id: string;
    url: string;
    position: number;
    isPrimary: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
}

export interface ListingAttributeDto {
    id: string;
    key: string;
    value: string;
    firstSeenAt: string;
    lastSeenAt: string;
}

export interface ListingPriceHistoryDto {
    id: string;
    price: number;
    currency: string;
    pricePerSquareMeter: number | null;
    runId: string | null;
    changedAt: string;
}

export interface ListingSeenDto {
    id: string;
    runId: string;
    seenAt: string;
}

export interface ListingRunLinkDto {
    runId: string;
    outcome: ListingOutcome;
    run: {
        id: string;
        scanDefinitionId: string;
        status: RunStatus;
        createdAt: string;
    };
}

export interface ListingDetailDto extends ListingBaseDto {
    seller: SellerDto | null;
    images: ListingImageDto[];
    attributes: ListingAttributeDto[];
    /** Newest first. */
    priceHistory: ListingPriceHistoryDto[];
    /** Newest first, last 50. */
    seenHistory: ListingSeenDto[];
    runLinks: ListingRunLinkDto[];
}

export interface ListingListResponse {
    rows: ListingListRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface ListingFacetsDto {
    province: string[];
    district: string[];
    neighborhood: string[];
    listingType: string[];
    propertyCategory: string[];
    propertySubtype: string[];
    rooms: string[];
    heating: string[];
    buildingAge: string[];
    floor: string[];
    bathroomCount: string[];
    balcony: string[];
    furnished: string[];
    usageStatus: string[];
    insideSite: string[];
    creditEligible: string[];
    exchangeEligible: string[];
}

export const EMPTY_LISTING_FACETS: ListingFacetsDto = {
    province: [],
    district: [],
    neighborhood: [],
    listingType: [],
    propertyCategory: [],
    propertySubtype: [],
    rooms: [],
    heating: [],
    buildingAge: [],
    floor: [],
    bathroomCount: [],
    balcony: [],
    furnished: [],
    usageStatus: [],
    insideSite: [],
    creditEligible: [],
    exchangeEligible: [],
};

export interface PriceHistoryResponse {
    /** Ascending by changedAt. */
    points: Array<{
        price: number;
        currency: string;
        pricePerSquareMeter: number | null;
        changedAt: string;
        runId: string | null;
    }>;
    summary: {
        firstPrice: number | null;
        latestPrice: number | null;
        totalChangePercent: number | null;
        changeCount: number;
    };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface ProxyHealthCounts {
    healthy: number;
    degraded: number;
    unhealthy: number;
    unknown: number;
    disabled: number;
}

export interface DashboardSummary {
    totalListings: number;
    newListingsToday: number;
    updatedListingsToday: number;
    priceChangesToday: number;
    ownerListings: number;
    officeListings: number;
    activeScans: number;
    runningRuns: number;
    failedRuns24h: number;
    staleListings: number;
    proxyHealthSummary: ProxyHealthCounts;
    recentRuns: Array<{
        id: string;
        scanName: string;
        status: RunStatus;
        startedAt: string | null;
        durationMs: number | null;
        itemsInserted: number;
    }>;
}

// ---------------------------------------------------------------------------
// Scans & runs
// ---------------------------------------------------------------------------

export interface ScanDto {
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
    browserMode: BrowserMode;
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
    createdAt: string;
    updatedAt: string;
}

export interface ScanWithLatestRun extends ScanDto {
    latestRun: RunDto | null;
}

export interface ScanListResponse {
    rows: ScanWithLatestRun[];
    total: number;
}

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

export interface RunDto {
    id: string;
    scanDefinitionId: string;
    status: RunStatus;
    trigger: RunTrigger;
    configurationSnapshot: unknown;
    counters: RunCounters;
    errorSummary: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    heartbeatAt: string | null;
    createdAt: string;
}

export interface RunListResponse {
    rows: RunDto[];
    total: number;
    page: number;
    pageSize: number;
}

export interface RunEventDto {
    /** Decimal string (BigInt id) — doubles as the SSE Last-Event-ID cursor. */
    id: string;
    runId: string;
    type: string;
    data: unknown;
    createdAt: string;
}

export interface RunDetailDto extends RunDto {
    events: RunEventDto[];
}

/** SSE wire payload (apps/api/src/routes/run-events.ts RunEventMessage). */
export interface RunEventMessage {
    seq: string;
    runId: string;
    scanDefinitionId: string;
    type: string;
    at: string;
    data: unknown;
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

export interface ProxyProfileSummaryDto {
    id: string;
    name: string;
    strategy: ProxyStrategy;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
    endpointCount: number;
    enabledEndpointCount: number;
    healthSummary: {
        unknown: number;
        healthy: number;
        degraded: number;
        unhealthy: number;
        disabled: number;
    };
}

export interface ProxyEndpointDto {
    id: string;
    profileId: string;
    name: string | null;
    host: string;
    port: number;
    protocol: string;
    hasUsername: boolean;
    hasPassword: boolean;
    enabled: boolean;
    weight: number;
    country: string | null;
    notes: string;
    lastCheckedAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    successCount: number;
    /** Current consecutive-failure streak (API-side schema gap note). */
    failureCount: number;
    latencyMs: number | null;
    healthStatus: ProxyHealth;
    quarantinedUntil: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ProxyProfileDetailDto {
    id: string;
    name: string;
    strategy: ProxyStrategy;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
    endpoints: ProxyEndpointDto[];
}

export interface ProxyProfileListResponse {
    rows: ProxyProfileSummaryDto[];
    total: number;
}

export interface ProxyImportResultDto {
    imported: number;
    failed: Array<{ line: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Cookie profiles & session policies (metadata only — values never returned)
// ---------------------------------------------------------------------------

export interface CookieProfileDto {
    id: string;
    name: string;
    enabled: boolean;
    cookieCount: number;
    domainSummary: string;
    expirySummary: string;
    validationStatus: CookieValidationStatus;
    lastValidatedAt: string | null;
    notes: string;
    assignedScanCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface CookieProfileListResponse {
    rows: CookieProfileDto[];
    total: number;
}

export interface CookieImportResultDto {
    profile: CookieProfileDto;
    /** Indexed, secret-free normalization problems. */
    issues: string[];
}

export interface SessionPolicyDto {
    id: string;
    name: string;
    poolSize: number;
    maxUsageCount: number;
    maxAgeMinutes: number;
    persistCookiesPerSession: boolean;
    proxyAffinity: boolean;
    retireOnNetworkFailures: boolean;
    failureThreshold: number;
    assignedScanCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface SessionPolicyListResponse {
    rows: SessionPolicyDto[];
    total: number;
}

// ---------------------------------------------------------------------------
// Settings & health
// ---------------------------------------------------------------------------

/** Flat key→value map; editable keys are whitelisted API-side. */
export type SettingsMap = Record<string, unknown>;

export interface HealthResponse {
    status: 'ok' | 'degraded';
    db: 'up' | 'down';
    redis: 'up' | 'down';
    worker: 'up' | 'down';
}

export interface StackStatusResponse {
    worker: 'up' | 'down';
    workerHeartbeat: string | null;
    desktopStack: boolean;
    lanUrls: string[];
    apiPort: number;
}
