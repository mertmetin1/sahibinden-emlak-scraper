/**
 * Maps a ScanDefinition-shaped plain object (the execution-relevant fields
 * of a `ScanRun.configurationSnapshot`, ARCHITECTURE.md §4.2) to a shared
 * `CrawlConfig`.
 *
 * Pure and DB-agnostic: no I/O, no Prisma import, no validation. Input
 * validation is the API layer's job (packages/config zod schema); runtime
 * guards (allowed domains, label routing) live in runCrawl. A `cdp` browser
 * mode without `cdpUrl` is passed through as-is — the API layer rejects it,
 * the engine's CdpBrowserProvider fails loudly if it ever slips through.
 *
 * Defaults mirror packages/config/src/schema.ts exactly. DB-style `null`
 * optionals are treated as "unset" (Prisma represents absent values as
 * null), except `maxItems`/`maxPages` where null IS the meaningful value
 * (unlimited) in CrawlConfig.
 */
import type { BrowserMode, CrawlConfig } from '@sahibindenbot/shared';

/** ScanDefinition-shaped snapshot fields consumed by the engine. */
export interface ScanDefinitionSnapshot {
    name?: string | null;
    startUrls: string[];
    maxItems?: number | null;
    maxPages?: number | null;
    includeDetails?: boolean | null;
    maxConcurrency?: number | null;
    navigationTimeoutSeconds?: number | null;
    requestHandlerTimeoutSeconds?: number | null;
    maxRequestRetries?: number | null;
    delayMinMs?: number | null;
    delayMaxMs?: number | null;
    debugMode?: boolean | null;
    storeRawHtml?: boolean | null;
    browserMode?: BrowserMode | null;
    cdpUrl?: string | null;
    allowedDomains?: string[] | null;
    humanInTheLoop?: boolean | null;
}

/** Defaults mirroring packages/config/src/schema.ts (single behavioral source). */
export const SNAPSHOT_DEFAULTS = {
    maxItems: null,
    maxPages: null,
    includeDetails: false,
    maxConcurrency: 3,
    navigationTimeoutSeconds: 90,
    requestHandlerTimeoutSeconds: 180,
    maxRequestRetries: 8,
    delayMinMs: 2000,
    delayMaxMs: 5000,
    debugMode: false,
    storeRawHtml: false,
    allowedDomains: ['sahibinden.com', 'www.sahibinden.com'],
    outputDir: 'storage/datasets',
    humanInTheLoop: true,
    humanInTheLoopTimeoutSeconds: 180,
} as const;

export function crawlConfigFromSnapshot(snapshot: ScanDefinitionSnapshot): CrawlConfig {
    const browserMode: BrowserMode = snapshot.browserMode === 'cdp' ? 'cdp' : 'managed';
    return {
        name: snapshot.name ?? undefined,
        startUrls: [...snapshot.startUrls],
        maxItems: snapshot.maxItems ?? SNAPSHOT_DEFAULTS.maxItems,
        maxPages: snapshot.maxPages ?? SNAPSHOT_DEFAULTS.maxPages,
        includeDetails: snapshot.includeDetails ?? SNAPSHOT_DEFAULTS.includeDetails,
        maxConcurrency: snapshot.maxConcurrency ?? SNAPSHOT_DEFAULTS.maxConcurrency,
        navigationTimeoutSeconds: snapshot.navigationTimeoutSeconds ?? SNAPSHOT_DEFAULTS.navigationTimeoutSeconds,
        requestHandlerTimeoutSeconds:
            snapshot.requestHandlerTimeoutSeconds ?? SNAPSHOT_DEFAULTS.requestHandlerTimeoutSeconds,
        maxRequestRetries: snapshot.maxRequestRetries ?? SNAPSHOT_DEFAULTS.maxRequestRetries,
        delayMinMs: snapshot.delayMinMs ?? SNAPSHOT_DEFAULTS.delayMinMs,
        delayMaxMs: snapshot.delayMaxMs ?? SNAPSHOT_DEFAULTS.delayMaxMs,
        debugMode: snapshot.debugMode ?? SNAPSHOT_DEFAULTS.debugMode,
        storeRawHtml: snapshot.storeRawHtml ?? SNAPSHOT_DEFAULTS.storeRawHtml,
        browser:
            browserMode === 'cdp'
                ? // cdpUrl may be absent — validation is the API layer's job.
                  { mode: 'cdp', cdpUrl: snapshot.cdpUrl ?? undefined }
                : { mode: 'managed', headless: true },
        // Proxy and cookies are injected via CrawlDeps (ProfileProxyProvider /
        // SessionProvider over decrypted DB profiles) — never via config.
        proxy: null,
        sessionCookiesFile: null,
        allowedDomains: snapshot.allowedDomains?.length
            ? [...snapshot.allowedDomains]
            : [...SNAPSHOT_DEFAULTS.allowedDomains],
        outputDir: SNAPSHOT_DEFAULTS.outputDir,
        humanInTheLoop: snapshot.humanInTheLoop ?? SNAPSHOT_DEFAULTS.humanInTheLoop,
        humanInTheLoopTimeoutSeconds: SNAPSHOT_DEFAULTS.humanInTheLoopTimeoutSeconds,
    };
}
