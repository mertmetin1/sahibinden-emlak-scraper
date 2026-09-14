/**
 * RunControlService — BullMQ producer + run lifecycle orchestration.
 *
 * FROZEN QUEUE CONTRACT (shared with apps/worker — do not diverge):
 * - Queue: CRAWL_QUEUE ('crawl-queue'); job name 'crawl'; data { runId }.
 * - The ScanRun row is created FIRST (status QUEUED, configurationSnapshot =
 *   deep copy of the scan's execution config), then enqueued with
 *   jobId `scan:${scanId}:${runId}`, attempts 2, fixed backoff 5000ms,
 *   removeOnComplete 100, removeOnFail 500.
 * - Duplicate protection: DB check for an active run (QUEUED/STARTING/
 *   RUNNING/CANCELLING) + RedisKeys.scanLockKey SET NX PX 30000 race guard
 *   (released on enqueue failure).
 * - Cancel: QUEUED → remove job + status CANCELLED; STARTING/RUNNING →
 *   SET RedisKeys.cancelKey(runId) PX 600000 + status CANCELLING.
 * - Retry: only from FAILED/PARTIAL/CANCELLED → new run (trigger RETRY,
 *   SAME snapshot) + enqueue.
 *
 * The Redis key functions and queue name/prefix are injectable so tests can
 * run hermetically under a `sahtest` namespace without touching dev keys.
 */
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { CRAWL_QUEUE, RedisKeys, redactSecrets, type CrawlJobData } from '@sahibindenbot/shared';
import type { DatabaseClient, RunRecord, ScanRecord, ScanTriggerValue } from '@sahibindenbot/database';
import { conflict, notFound } from './errors.js';

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Statuses that block a new run for the same scan (frozen contract). */
export const ACTIVE_RUN_STATUSES = ['QUEUED', 'STARTING', 'RUNNING', 'CANCELLING'] as const;
/** Statuses from which a retry is allowed (frozen contract). */
export const RETRYABLE_RUN_STATUSES = ['FAILED', 'PARTIAL', 'CANCELLED'] as const;

export const SCAN_LOCK_TTL_MS = 30_000; // PX 30000 — enqueue race guard
export const CANCEL_KEY_TTL_MS = 600_000; // PX 600000 — 10 min cooperative cancel signal

/** Test-run snapshot overrides (frozen contract): shallow smoke crawl. */
export const TEST_RUN_OVERRIDES = { maxItems: 10, maxPages: 1 } as const;

export interface RunControlKeys {
    scanLockKey: (scanDefinitionId: string) => string;
    cancelKey: (runId: string) => string;
}

export interface RunControlLogger {
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
}

export interface RunControlOptions {
    db: DatabaseClient;
    redis: Redis;
    /** Defaults to CRAWL_QUEUE ('crawl-queue'). */
    queueName?: string;
    /** BullMQ key prefix (tests isolate via e.g. 'sahtest-runs'). */
    queuePrefix?: string;
    /** Defaults to shared RedisKeys (production contract). */
    keys?: RunControlKeys;
    lockTtlMs?: number;
    cancelTtlMs?: number;
    logger?: RunControlLogger;
}

// ---------------------------------------------------------------------------
// Configuration snapshot (ARCHITECTURE §4.2 — immutable deep copy)
// ---------------------------------------------------------------------------

/**
 * Deep-copies every execution-relevant field of the scan definition into the
 * run's configurationSnapshot. Secrets are captured BY REFERENCE (profile
 * ids) — the worker resolves/decrypts them at run start; secret values never
 * enter the snapshot. `overrides` are merged last (test-run caps).
 */
export function buildConfigurationSnapshot(
    scan: ScanRecord,
    trigger: ScanTriggerValue,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    const base: Record<string, unknown> = {
        // Field names mirror the worker's WorkerSnapshot (apps/worker
        // snapshot.ts) exactly — the worker rehydrates CrawlConfig from this
        // object and never from the live definition row.
        snapshotVersion: 1,
        scanDefinitionId: scan.id,
        name: scan.name,
        trigger,
        capturedAt: new Date().toISOString(),
        startUrls: structuredClone(scan.startUrls),
        allowedDomains: structuredClone(scan.allowedDomains),
        timezone: scan.timezone,
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
        browserMode: scan.browserMode,
        cdpUrl: scan.cdpUrl,
        proxyProfileId: scan.proxyProfileId,
        cookieProfileId: scan.cookieProfileId,
        sessionPolicyId: scan.sessionPolicyId,
        debugMode: scan.debugMode,
        storeRawHtml: scan.storeRawHtml,
        storeScreenshotsOnFailure: scan.storeScreenshotsOnFailure,
        staleDetectionEnabled: scan.staleDetectionEnabled,
        staleAfterSuccessfulRuns: scan.staleAfterSuccessfulRuns,
        humanInTheLoop: scan.humanInTheLoop,
    };
    return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RunControlService {
    readonly queue: Queue<CrawlJobData>;

    private readonly db: DatabaseClient;
    private readonly redis: Redis;
    private readonly keys: RunControlKeys;
    private readonly lockTtlMs: number;
    private readonly cancelTtlMs: number;
    private readonly logger: RunControlLogger | undefined;

    constructor(options: RunControlOptions) {
        this.db = options.db;
        this.redis = options.redis;
        this.keys = options.keys ?? RedisKeys;
        this.lockTtlMs = options.lockTtlMs ?? SCAN_LOCK_TTL_MS;
        this.cancelTtlMs = options.cancelTtlMs ?? CANCEL_KEY_TTL_MS;
        this.logger = options.logger;
        this.queue = new Queue<CrawlJobData>(options.queueName ?? CRAWL_QUEUE, {
            connection: options.redis,
            ...(options.queuePrefix !== undefined ? { prefix: options.queuePrefix } : {}),
        });
    }

    /** BullMQ job id for a (scan, run) pair — frozen contract. */
    static jobId(scanDefinitionId: string, runId: string): string {
        return `scan:${scanDefinitionId}:${runId}`;
    }

    /**
     * Active-run lookup used by the duplicate guard. GAP NOTE: RunRepository
     * has no multi-status "find active run for scan" method (listRuns takes a
     * single status), so this uses the exposed prisma client directly —
     * client.ts documents prisma as available for exactly these raw needs.
     */
    async findActiveRun(scanDefinitionId: string): Promise<{ id: string; status: string } | null> {
        return this.db.prisma.scanRun.findFirst({
            where: { scanDefinitionId, status: { in: [...ACTIVE_RUN_STATUSES] } },
            select: { id: true, status: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Creates + enqueues a run for the scan. Throws ApiError 409
     * RUN_ALREADY_ACTIVE when a run is active (DB check + Redis race guard).
     */
    async startRun(
        scan: ScanRecord,
        trigger: ScanTriggerValue,
        snapshotOverrides: Record<string, unknown> = {},
    ): Promise<RunRecord> {
        await this.acquireScanLock(scan.id);
        let run: RunRecord | null = null;
        try {
            const snapshot = buildConfigurationSnapshot(scan, trigger, snapshotOverrides);
            run = await this.db.repos.runs.createRun(scan.id, trigger, snapshot);
            await this.enqueue(run.id, scan.id);
            this.logger?.info({ scanId: scan.id, runId: run.id, trigger }, 'run enqueued');
            return run;
        } catch (err) {
            // Frozen contract: release the race guard on enqueue failure; the
            // orphaned QUEUED row is closed out FAILED so it never blocks.
            await this.releaseScanLock(scan.id);
            if (run !== null) {
                await this.db.repos.runs
                    .finishRun(run.id, 'FAILED', {}, 'queue enqueue failed')
                    .catch(() => undefined);
            }
            this.logger?.error(redactSecrets({ err: toLoggable(err), scanId: scan.id }), 'run enqueue failed');
            throw err;
        }
    }

    /**
     * Frozen cancel flow. QUEUED → remove BullMQ job + CANCELLED (lock
     * released; the worker never sees the job). STARTING/RUNNING → cancel key
     * (PX 600000) + CANCELLING; the worker's CancellationToken observes it and
     * drives the run to CANCELLED (lock release is worker-side). CANCELLING is
     * idempotent. Terminal states → 409 RUN_NOT_CANCELLABLE.
     *
     * Race hardening (beyond the letter of the contract): if the QUEUED job
     * is already locked/active in a worker when removal is attempted, we fall
     * back to the cooperative path instead of forcing CANCELLED.
     */
    async cancelRun(runId: string): Promise<RunRecord> {
        const run = await this.getRunOrThrow(runId);
        switch (run.status) {
            case 'QUEUED': {
                const jobId = RunControlService.jobId(run.scanDefinitionId, run.id);
                const job = await this.queue.getJob(jobId);
                let removed = job === undefined; // nothing queued → safe to cancel outright
                if (job !== undefined) {
                    try {
                        await job.remove();
                        removed = true;
                    } catch {
                        removed = false; // locked/active in a worker → cooperative path
                    }
                }
                if (removed) {
                    await this.db.repos.runs.updateStatus(run.id, 'CANCELLED', { finishedAt: new Date() });
                    await this.releaseScanLock(run.scanDefinitionId);
                    this.logger?.info({ runId: run.id }, 'queued run cancelled (job removed)');
                } else {
                    await this.signalCooperativeCancel(run.id);
                    this.logger?.info({ runId: run.id }, 'queued run already active — cooperative cancel signalled');
                }
                break;
            }
            case 'STARTING':
            case 'RUNNING': {
                await this.signalCooperativeCancel(run.id);
                this.logger?.info({ runId: run.id }, 'cooperative cancel signalled');
                break;
            }
            case 'CANCELLING':
                break; // idempotent — already on its way to CANCELLED
            default:
                throw conflict('RUN_NOT_CANCELLABLE', `run ${runId} is ${run.status} and cannot be cancelled`);
        }
        return this.getRunOrThrow(runId);
    }

    /**
     * Frozen retry flow: only FAILED/PARTIAL/CANCELLED → new run with the
     * SAME configurationSnapshot, trigger RETRY, then enqueue (with the same
     * duplicate protection as a fresh start).
     */
    async retryRun(runId: string): Promise<RunRecord> {
        const source = await this.getRunOrThrow(runId);
        if (!(RETRYABLE_RUN_STATUSES as readonly string[]).includes(source.status)) {
            throw conflict(
                'RUN_NOT_RETRYABLE',
                `run ${runId} is ${source.status}; only ${RETRYABLE_RUN_STATUSES.join('/')} runs can be retried`,
            );
        }
        await this.acquireScanLock(source.scanDefinitionId);
        let run: RunRecord | null = null;
        try {
            // Same snapshot — retry = "same config, new attempt" (§4.2).
            run = await this.db.repos.runs.createRun(source.scanDefinitionId, 'RETRY', source.configurationSnapshot);
            await this.enqueue(run.id, source.scanDefinitionId);
            this.logger?.info({ runId: run.id, retryOf: source.id }, 'retry run enqueued');
            return run;
        } catch (err) {
            await this.releaseScanLock(source.scanDefinitionId);
            if (run !== null) {
                await this.db.repos.runs
                    .finishRun(run.id, 'FAILED', {}, 'queue enqueue failed')
                    .catch(() => undefined);
            }
            this.logger?.error(redactSecrets({ err: toLoggable(err), runId }), 'retry enqueue failed');
            throw err;
        }
    }

    /** Closes the BullMQ queue (the shared ioredis connection is NOT quit here — owned by the app). */
    async close(): Promise<void> {
        await this.queue.close();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private async getRunOrThrow(runId: string): Promise<RunRecord> {
        const found = await this.db.repos.runs.getRunWithEvents(runId);
        if (found === null) throw notFound(`run ${runId} not found`);
        return found.run;
    }

    /** DB active-run check + Redis SET NX PX race guard (frozen contract). */
    private async acquireScanLock(scanDefinitionId: string): Promise<void> {
        const active = await this.findActiveRun(scanDefinitionId);
        if (active !== null) {
            throw conflict(
                'RUN_ALREADY_ACTIVE',
                `scan ${scanDefinitionId} already has an active run (${active.id}, status ${active.status})`,
                { activeRunId: active.id, activeRunStatus: active.status },
            );
        }
        const acquired = await this.redis.set(
            this.keys.scanLockKey(scanDefinitionId),
            `api-enqueue:${Date.now()}`,
            'PX',
            this.lockTtlMs,
            'NX',
        );
        if (acquired === null) {
            throw conflict(
                'RUN_ALREADY_ACTIVE',
                `scan ${scanDefinitionId} has a run being enqueued right now (lock held)`,
            );
        }
    }

    private async releaseScanLock(scanDefinitionId: string): Promise<void> {
        await this.redis.del(this.keys.scanLockKey(scanDefinitionId)).catch(() => undefined);
    }

    private async signalCooperativeCancel(runId: string): Promise<void> {
        await this.redis.set(this.keys.cancelKey(runId), '1', 'PX', this.cancelTtlMs);
        await this.db.repos.runs.updateStatus(runId, 'CANCELLING');
    }

    /** Enqueue per the frozen contract: job name 'crawl', data { runId }. */
    private async enqueue(runId: string, scanDefinitionId: string): Promise<void> {
        await this.queue.add(
            'crawl',
            { runId },
            {
                jobId: RunControlService.jobId(scanDefinitionId, runId),
                attempts: 2,
                backoff: { type: 'fixed', delay: 5000 },
                removeOnComplete: 100,
                removeOnFail: 500,
            },
        );
    }
}

function toLoggable(err: unknown): Record<string, unknown> {
    if (err instanceof Error) return { name: err.name, message: err.message };
    return { message: String(err) };
}
