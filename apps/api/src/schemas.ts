/**
 * Zod request schemas shared by all routes. Bounds mirror
 * packages/config/src/schema.ts where the fields overlap; scan-field
 * refinements (cron, timezone, cdp-requires-cdpUrl, delay ordering) live here
 * so create and update share one source of truth.
 */
import { Cron } from 'croner';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Field-level validators
// ---------------------------------------------------------------------------

/** Accepts whatever croner (the worker's scheduler evaluator) can parse. */
export function isValidCronExpression(expr: string): boolean {
    try {
        // Constructor doubles as the validator — throws on bad expressions.
        void new Cron(expr);
        return true;
    } catch {
        return false;
    }
}

/** IANA timezone check via Intl (throws RangeError on unknown zones). */
export function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

const urlString = z.string().url();
const nullableId = z.string().trim().min(1).nullable();

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/**
 * Every definable scan field, all REQUIRED at this level so `.partial()`
 * (update) and `.partial().required(...)` (create) derive cleanly without
 * field-level defaults leaking into PATCH bodies.
 */
const scanFieldsSchema = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000),
    enabled: z.boolean(),
    startUrls: z.array(urlString).min(1),
    schedule: z
        .string()
        .trim()
        .min(1)
        .refine(isValidCronExpression, 'must be a valid cron expression')
        .nullable(),
    timezone: z.string().trim().refine(isValidTimezone, 'must be a valid IANA timezone'),
    maxItems: z.number().int().min(1).nullable(),
    maxPages: z.number().int().min(1).nullable(),
    includeDetails: z.boolean(),
    incrementalMode: z.boolean(),
    maxConcurrency: z.number().int().min(1).max(10),
    navigationTimeoutSeconds: z.number().int().min(5).max(300),
    requestHandlerTimeoutSeconds: z.number().int().min(30).max(600),
    maxRequestRetries: z.number().int().min(0).max(20),
    delayMinMs: z.number().int().min(0),
    delayMaxMs: z.number().int().min(0),
    browserMode: z.enum(['cdp', 'managed']),
    cdpUrl: urlString.nullable(),
    proxyProfileId: nullableId,
    cookieProfileId: nullableId,
    sessionPolicyId: nullableId,
    debugMode: z.boolean(),
    storeRawHtml: z.boolean(),
    storeScreenshotsOnFailure: z.boolean(),
    staleDetectionEnabled: z.boolean(),
    staleAfterSuccessfulRuns: z.number().int().min(1).max(20),
    allowedDomains: z.array(z.string().trim().min(1)).min(1),
    humanInTheLoop: z.boolean(),
});

/** DB defaults (schema.prisma) used for effective-value checks on create. */
const SCAN_DB_DEFAULTS = {
    browserMode: 'cdp',
    delayMinMs: 2000,
    delayMaxMs: 5000,
} as const;

/** cdp browser mode is unusable without a CDP endpoint URL. */
export function cdpRequiresUrl(v: { browserMode?: string | undefined; cdpUrl?: string | null | undefined }): boolean {
    const effectiveMode = v.browserMode ?? SCAN_DB_DEFAULTS.browserMode;
    return effectiveMode !== 'cdp' || (typeof v.cdpUrl === 'string' && v.cdpUrl.length > 0);
}

/** Polite-delay ordering, checked against effective (default-merged) values. */
export function delaysOrdered(v: { delayMinMs?: number | undefined; delayMaxMs?: number | undefined }): boolean {
    const min = v.delayMinMs ?? SCAN_DB_DEFAULTS.delayMinMs;
    const max = v.delayMaxMs ?? SCAN_DB_DEFAULTS.delayMaxMs;
    return max >= min;
}

export const scanCreateSchema = scanFieldsSchema
    .partial()
    .required({ name: true, startUrls: true })
    .extend({
        timezone: scanFieldsSchema.shape.timezone.default('Europe/Istanbul'),
        allowedDomains: scanFieldsSchema.shape.allowedDomains.default(['sahibinden.com', 'www.sahibinden.com']),
    })
    .refine(cdpRequiresUrl, {
        message: 'cdpUrl is required when browserMode is "cdp" (the default)',
        path: ['cdpUrl'],
    })
    .refine(delaysOrdered, {
        message: 'delayMaxMs must be >= delayMinMs',
        path: ['delayMaxMs'],
    });

export const scanUpdateSchema = scanFieldsSchema.partial();

export type ScanCreateBody = z.infer<typeof scanCreateSchema>;
export type ScanUpdateBody = z.infer<typeof scanUpdateSchema>;

export const scanListQuerySchema = z.object({
    enabled: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
    q: z.string().trim().min(1).optional(),
});

export const toggleSchema = z.object({
    enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
    'QUEUED',
    'STARTING',
    'RUNNING',
    'CANCELLING',
    'CANCELLED',
    'SUCCEEDED',
    'PARTIAL',
    'FAILED',
] as const;

export const runListQuerySchema = z.object({
    scanId: z.string().trim().min(1).optional(),
    status: z.enum(RUN_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const runDetailQuerySchema = z.object({
    afterEventId: z
        .string()
        .trim()
        .regex(/^\d+$/, 'must be a decimal ScanRunEvent id')
        .optional(),
});

// ---------------------------------------------------------------------------
// Run events (replay endpoint + SSE stream)
// ---------------------------------------------------------------------------

export const runEventsQuerySchema = z.object({
    /** Decimal ScanRunEvent id — only events with id > afterId are returned. */
    afterId: z
        .string()
        .trim()
        .regex(/^\d+$/, 'must be a decimal ScanRunEvent id')
        .optional(),
});

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

/** API-facing sort fields (whitelisted). `area` maps to grossAreaM2 at the repo boundary. */
export const LISTING_SORT_FIELDS = ['price', 'firstSeenAt', 'lastSeenAt', 'title', 'area'] as const;
export type ListingSortParam = (typeof LISTING_SORT_FIELDS)[number];

export const SELLER_TYPES = ['OWNER', 'REAL_ESTATE_OFFICE', 'CONSTRUCTION_COMPANY', 'OTHER', 'UNKNOWN'] as const;
export const LISTING_STATUSES = ['ACTIVE', 'STALE', 'REMOVED'] as const;

/** Query-string boolean ('true'/'false' → boolean) — z.coerce.boolean() would map 'false' → true. */
const queryBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Every listings filter composes at the DB level via ListingRepository.listWithDerived. */
const listingFilterFields = {
    search: z.string().trim().min(1).max(200).optional(),
    province: z.string().trim().min(1).max(100).optional(),
    district: z.string().trim().min(1).max(100).optional(),
    neighborhood: z.string().trim().min(1).max(100).optional(),
    sellerType: z.enum(SELLER_TYPES).optional(),
    listingType: z.string().trim().min(1).max(50).optional(),
    propertyCategory: z.string().trim().min(1).max(100).optional(),
    priceMin: z.coerce.number().int().min(0).optional(),
    priceMax: z.coerce.number().int().min(0).optional(),
    /** m² filters apply to grossAreaM2 (site-advertised area). */
    m2Min: z.coerce.number().int().min(0).optional(),
    m2Max: z.coerce.number().int().min(0).optional(),
    rooms: z.string().trim().min(1).max(20).optional(),
    firstSeenFrom: z.coerce.date().optional(),
    lastSeenBefore: z.coerce.date().optional(),
    priceChanged: queryBoolean.optional(),
    scanId: z.string().trim().min(1).optional(),
    status: z.enum(LISTING_STATUSES).optional(),
};

export const listingListQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(LISTING_SORT_FIELDS).default('lastSeenAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    ...listingFilterFields,
});

/** CSV export: same filters as the list, no pagination (streamed, capped server-side). */
export const listingExportQuerySchema = z.object({
    sort: z.enum(LISTING_SORT_FIELDS).default('lastSeenAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    ...listingFilterFields,
});

export type ListingListQuery = z.infer<typeof listingListQuerySchema>;
export type ListingExportQuery = z.infer<typeof listingExportQuerySchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Editable AppSetting keys — settings are CODE-DEFINED, not free-form:
 * every key has a typed consumer (UI default page size, CSV export row cap,
 * worker scheduler toggle), so arbitrary keys would be silently dead config.
 * PATCH rejects unknown keys with 400 VALIDATION_ERROR.
 */
export const EDITABLE_SETTING_KEYS = ['ui.defaultPageSize', 'export.maxRows', 'scheduler.enabled'] as const;
export type EditableSettingKey = (typeof EDITABLE_SETTING_KEYS)[number];

/** Per-key value validation (typed consumers demand typed values). */
export const SETTING_VALUE_SCHEMAS: Record<EditableSettingKey, z.ZodType<number | boolean>> = {
    'ui.defaultPageSize': z.number().int().min(1).max(100),
    'export.maxRows': z.number().int().min(1).max(50_000),
    'scheduler.enabled': z.boolean(),
};

export const settingsPatchSchema = z
    .record(z.string(), z.unknown())
    .refine((obj) => Object.keys(obj).length > 0, 'at least one setting key is required');

// ---------------------------------------------------------------------------
// Proxy profiles & endpoints
// ---------------------------------------------------------------------------

export const proxyProfileCreateSchema = z.object({
    name: z.string().trim().min(1).max(200),
    strategy: z.enum(['ROUND_ROBIN', 'SESSION_STICKY']).optional(),
    enabled: z.boolean().optional(),
});

export const proxyProfileUpdateSchema = proxyProfileCreateSchema.partial();

export const proxyEndpointCreateSchema = z.object({
    name: z.string().trim().min(1).max(200).nullish(),
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['http', 'https', 'socks4', 'socks5']).optional(),
    /** Write-only credentials — encrypted before persist, never returned. */
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    weight: z.number().int().min(1).max(1000).optional(),
    country: z.string().trim().min(1).max(100).nullish(),
    notes: z.string().max(2000).optional(),
});

export const proxyEndpointUpdateSchema = z.object({
    name: z.string().trim().min(1).max(200).nullish(),
    host: z.string().trim().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(['http', 'https', 'socks4', 'socks5']).optional(),
    /** Tri-state: omitted = keep, null = clear, string = re-encrypt & store. */
    username: z.string().min(1).nullable().optional(),
    password: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    weight: z.number().int().min(1).max(1000).optional(),
    country: z.string().trim().min(1).max(100).nullish(),
    notes: z.string().max(2000).optional(),
});

export const proxyBulkImportSchema = z.object({
    text: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Cookie profiles
// ---------------------------------------------------------------------------

export const cookieProfileImportSchema = z.object({
    name: z.string().trim().min(1).max(200),
    /**
     * EditThisCookie / Cookie-Editor JSON array, { cookies: [...] } wrapper,
     * or a raw Cookie header string. Write-only — never returned by any route.
     */
    cookieJson: z.unknown(),
    notes: z.string().max(2000).optional(),
});

export const cookieProfileReplaceSchema = z.object({
    cookieJson: z.unknown(),
});

// ---------------------------------------------------------------------------
// Session policies
// ---------------------------------------------------------------------------

export const sessionPolicyCreateSchema = z.object({
    name: z.string().trim().min(1).max(200),
    poolSize: z.number().int().min(1).max(100).optional(),
    maxUsageCount: z.number().int().min(1).max(10000).optional(),
    maxAgeMinutes: z.number().int().min(1).max(1440).optional(),
    persistCookiesPerSession: z.boolean().optional(),
    proxyAffinity: z.boolean().optional(),
    retireOnNetworkFailures: z.boolean().optional(),
    failureThreshold: z.number().int().min(1).max(20).optional(),
});

export const sessionPolicyUpdateSchema = sessionPolicyCreateSchema.partial();

// ---------------------------------------------------------------------------
// Shared params
// ---------------------------------------------------------------------------

export const idParamSchema = z.object({
    id: z.string().trim().min(1),
});
