/**
 * ScanRun.configurationSnapshot handling (ARCHITECTURE.md §4.2).
 *
 * The snapshot is an immutable deep copy of every execution-relevant
 * ScanDefinition field — plus the referenced profile ids (secrets are
 * captured BY REFERENCE and decrypted by the worker at run start) — taken at
 * enqueue time. The worker builds the crawl exclusively from the snapshot,
 * never from the live definition row.
 *
 * `WorkerSnapshot` = the engine-consumed fields (ScanDefinitionSnapshot)
 * + worker-only fields (profile ids, staleness knobs, bookkeeping).
 */
import type { ScanDefinitionSnapshot } from '@sahibindenbot/scraper-engine';
import type { ScanRecord, ScanTriggerValue } from '@sahibindenbot/database';

export const SNAPSHOT_VERSION = 1;

/** Test-run caps (ARCHITECTURE.md §6.2): test runs are small + debuggable. */
export const TEST_RUN_MAX_ITEMS = 25;
export const TEST_RUN_MAX_PAGES = 2;

export interface WorkerSnapshot extends ScanDefinitionSnapshot {
    incrementalMode?: boolean | null;
    storeScreenshotsOnFailure?: boolean | null;
    staleDetectionEnabled?: boolean | null;
    staleAfterSuccessfulRuns?: number | null;
    proxyProfileId?: string | null;
    cookieProfileId?: string | null;
    sessionPolicyId?: string | null;
    snapshotVersion?: number;
    capturedAt?: string;
}

/**
 * Deep-copies the execution-relevant fields of a ScanDefinition row.
 * TEST triggers override caps in the COPY (the definition is untouched).
 */
export function buildSnapshotFromScan(scan: ScanRecord, trigger: ScanTriggerValue): WorkerSnapshot {
    const snapshot: WorkerSnapshot = {
        snapshotVersion: SNAPSHOT_VERSION,
        capturedAt: new Date().toISOString(),
        name: scan.name,
        startUrls: structuredClone(scan.startUrls),
        maxItems: scan.maxItems,
        maxPages: scan.maxPages,
        includeDetails: scan.includeDetails,
        incrementalMode: scan.incrementalMode,
        maxConcurrency: scan.maxConcurrency,
        navigationTimeoutSeconds: scan.navigationTimeoutSeconds,
        requestHandlerTimeoutSeconds: scan.requestHandlerTimeoutSeconds,
        maxRequestRetries: scan.maxRequestRetries,
        delayMinMs: scan.delayMinMs,
        delayMaxMs: scan.delayMaxMs,
        debugMode: scan.debugMode,
        storeRawHtml: scan.storeRawHtml,
        storeScreenshotsOnFailure: scan.storeScreenshotsOnFailure,
        browserMode: scan.browserMode === 'cdp' ? 'cdp' : 'managed',
        cdpUrl: scan.cdpUrl,
        allowedDomains: structuredClone(scan.allowedDomains),
        humanInTheLoop: scan.humanInTheLoop,
        proxyProfileId: scan.proxyProfileId,
        cookieProfileId: scan.cookieProfileId,
        sessionPolicyId: scan.sessionPolicyId,
        staleDetectionEnabled: scan.staleDetectionEnabled,
        staleAfterSuccessfulRuns: scan.staleAfterSuccessfulRuns,
    };
    if (trigger === 'TEST') {
        snapshot.maxItems = Math.min(snapshot.maxItems ?? TEST_RUN_MAX_ITEMS, TEST_RUN_MAX_ITEMS);
        snapshot.maxPages = Math.min(snapshot.maxPages ?? TEST_RUN_MAX_PAGES, TEST_RUN_MAX_PAGES);
        snapshot.debugMode = true;
    }
    return snapshot;
}

/**
 * Validates the unknown JSON stored on the run row. Throws a plain Error
 * with a secret-free message on a bad shape (the worker maps this to an
 * UnrecoverableError — a malformed snapshot never retries).
 */
export function parseWorkerSnapshot(raw: unknown): WorkerSnapshot {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('configurationSnapshot is not an object');
    }
    const snapshot = raw as WorkerSnapshot;
    if (
        !Array.isArray(snapshot.startUrls) ||
        snapshot.startUrls.length === 0 ||
        !snapshot.startUrls.every((u) => typeof u === 'string' && u.length > 0)
    ) {
        throw new Error('configurationSnapshot.startUrls must be a non-empty string array');
    }
    return snapshot;
}
