/**
 * queue-admin — run-control helpers. The API app (A5) imports these; the
 * worker's scheduler uses them too. NOT wired to HTTP here.
 *
 * Duplicate protection is two-layered (ADR-0003):
 *   1. DURABLE: a DB check rejects when the scan already has a run in an
 *      active status (QUEUED/STARTING/RUNNING/CANCELLING) — Postgres is the
 *      source of truth.
 *   2. RACE: two concurrent enqueues can both pass the DB check, so after
 *      creating the run row we `SET lock:scan:{scanId} {runId} NX PX 30000`.
 *      Losing the race → the just-created row is marked CANCELLED (audit
 *      trail) and a typed RUN_ALREADY_ACTIVE error is thrown.
 *      The worker releases the lock (compare-and-delete by runId) when the
 *      run reaches a terminal state; the 30s PX bounds a crashed worker's
 *      leftover lock.
 *
 * BullMQ jobId is `scan:{scanId}:{runId}` — unique per run, so a completed
 * job never blocks the scan's NEXT run (a plain `scan:{scanId}` jobId would
 * be returned by queue.add WITHOUT enqueueing while the previous completed
 * job is still retained — BullMQ jobId reuse gotcha). Singleton semantics
 * come from the DB+lock guard, not from the jobId.
 */
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { CrawlJobData, RuntimeLogger } from '@sahibindenbot/shared';
import type {
    DatabaseRepositories,
    RunRecord,
    ScanRunStatusValue,
    ScanTriggerValue,
} from '@sahibindenbot/database';
import { defaultKeyBuilders } from './keys.js';
import { buildSnapshotFromScan } from './snapshot.js';

export const CRAWL_JOB_NAME = 'crawl';
export const SCAN_LOCK_TTL_MS = 30_000;
export const CANCEL_KEY_TTL_MS = 10 * 60 * 1000;

/** Statuses in which a run still occupies its scan definition. */
export const ACTIVE_RUN_STATUSES: readonly ScanRunStatusValue[] = ['QUEUED', 'STARTING', 'RUNNING', 'CANCELLING'];
/** Only these terminal statuses may be retried. */
export const RETRYABLE_RUN_STATUSES: readonly ScanRunStatusValue[] = ['FAILED', 'PARTIAL', 'CANCELLED'];

export type QueueAdminErrorCode =
    | 'RUN_ALREADY_ACTIVE'
    | 'SCAN_NOT_FOUND'
    | 'SCAN_DISABLED'
    | 'RUN_NOT_FOUND'
    | 'INVALID_RUN_STATE'
    | 'ENQUEUE_FAILED';

/** Typed error — the API maps `code` to 409/404/422 without string matching. */
export class QueueAdminError extends Error {
    constructor(
        public readonly code: QueueAdminErrorCode,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message);
        this.name = 'QueueAdminError';
        if (options?.cause !== undefined) this.cause = options.cause;
    }
}

export interface QueueAdminDeps {
    repos: DatabaseRepositories;
    queue: Queue<CrawlJobData>;
    redis: Redis;
    logger?: RuntimeLogger;
    /** Test hook: prefix keys. Defaults to shared RedisKeys. */
    keyBuilders?: Pick<typeof defaultKeyBuilders, 'scanLockKey' | 'cancelKey'>;
}

export interface EnqueueOptions {
    /** RETRY: reuse the original run's snapshot verbatim (§4.2). */
    snapshotOverride?: unknown;
    /** RETRY of an old run stays allowed on a since-disabled definition. */
    skipEnabledCheck?: boolean;
}

export interface EnqueueResult {
    runId: string;
    jobId: string;
}

export interface CancelResult {
    runId: string;
    status: 'CANCELLING' | 'CANCELLED';
}

export function crawlJobId(scanDefinitionId: string, runId: string): string {
    return `scan:${scanDefinitionId}:${runId}`;
}

/**
 * Enqueues a run for a scan definition. Returns { runId, jobId } or throws a
 * typed QueueAdminError ('RUN_ALREADY_ACTIVE' on the duplicate guard).
 */
export async function enqueueScanRun(
    deps: QueueAdminDeps,
    scanId: string,
    trigger: ScanTriggerValue,
    opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
    const scan = await deps.repos.scans.getById(scanId);
    if (scan === null) throw new QueueAdminError('SCAN_NOT_FOUND', `scan definition not found: ${scanId}`);
    if (opts.skipEnabledCheck !== true && !scan.enabled) {
        throw new QueueAdminError('SCAN_DISABLED', `scan '${scan.name}' (${scanId}) is disabled`);
    }

    // (1) Durable duplicate guard.
    const recent = await deps.repos.runs.listRuns(scanId, undefined, 1, 50);
    const active = recent.rows.find((row) => ACTIVE_RUN_STATUSES.includes(row.status));
    if (active !== undefined) {
        throw new QueueAdminError(
            'RUN_ALREADY_ACTIVE',
            `scan '${scan.name}' already has an active run (${active.id}, status ${active.status})`,
        );
    }

    const snapshot =
        opts.snapshotOverride !== undefined ? opts.snapshotOverride : buildSnapshotFromScan(scan, trigger);
    const run = await deps.repos.runs.createRun(scanId, trigger, snapshot);

    // (2) Race guard (30s, self-expiring; released by the worker on terminal state).
    const lockKey = (deps.keyBuilders?.scanLockKey ?? defaultKeyBuilders.scanLockKey)(scanId);
    const acquired = await deps.redis.set(lockKey, run.id, 'PX', SCAN_LOCK_TTL_MS, 'NX');
    if (acquired !== 'OK') {
        await deps.repos.runs
            .finishRun(run.id, 'CANCELLED', {}, 'superseded: concurrent enqueue won the scan lock')
            .catch(() => undefined);
        throw new QueueAdminError('RUN_ALREADY_ACTIVE', `scan '${scan.name}' is already being enqueued (lock held)`);
    }

    const jobId = crawlJobId(scanId, run.id);
    try {
        await deps.queue.add(
            CRAWL_JOB_NAME,
            { runId: run.id },
            {
                jobId,
                attempts: 2,
                backoff: { type: 'fixed', delay: 5_000 },
                removeOnComplete: 100,
                removeOnFail: 500,
            },
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await deps.repos.runs.finishRun(run.id, 'FAILED', {}, `enqueue failed: ${message}`).catch(() => undefined);
        await deps.redis.del(lockKey).catch(() => undefined);
        throw new QueueAdminError('ENQUEUE_FAILED', `failed to enqueue run ${run.id}: ${message}`, { cause: err });
    }

    deps.logger?.info('run enqueued', { runId: run.id, scanId, trigger, jobId });
    return { runId: run.id, jobId };
}

/**
 * Cancellation (ARCHITECTURE.md §6.2):
 * - QUEUED run  → remove the waiting BullMQ job, mark CANCELLED immediately.
 * - STARTING/RUNNING → set the Redis cancel key (PX 10 min) + status
 *   CANCELLING; the worker's RedisCancellationToken polls it (≤2s) and the
 *   engine drains cooperatively into CANCELLED.
 * - CANCELLING → idempotent (re-arms the key).
 * - terminal → typed INVALID_RUN_STATE error.
 */
export async function requestCancelRun(deps: QueueAdminDeps, runId: string): Promise<CancelResult> {
    const loaded = await deps.repos.runs.getRunWithEvents(runId);
    if (loaded === null) throw new QueueAdminError('RUN_NOT_FOUND', `run not found: ${runId}`);
    const run = loaded.run;
    const cancelKey = (deps.keyBuilders?.cancelKey ?? defaultKeyBuilders.cancelKey)(runId);

    switch (run.status) {
        case 'QUEUED': {
            const job = await deps.queue.getJob(crawlJobId(run.scanDefinitionId, run.id));
            let removed = false;
            if (job === undefined) {
                // No waiting job (already removed / never landed) — nothing to race.
                removed = true;
            } else {
                const state = await job.getState();
                if (state === 'waiting' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children') {
                    try {
                        await job.remove();
                        removed = true;
                    } catch {
                        removed = false; // lost the race — the job went active
                    }
                }
            }
            if (removed) {
                await deps.repos.runs.finishRun(runId, 'CANCELLED', {}, 'cancelled while queued');
                await releaseScanLock(deps.redis, run.scanDefinitionId, runId, deps.keyBuilders?.scanLockKey);
                deps.logger?.info('queued run cancelled', { runId });
                return { runId, status: 'CANCELLED' };
            }
            // The job started between our status read and the removal attempt:
            // fall through to the cooperative path.
            await deps.redis.set(cancelKey, '1', 'PX', CANCEL_KEY_TTL_MS);
            await deps.repos.runs.updateStatus(runId, 'CANCELLING');
            deps.logger?.info('run cancellation requested (job went active mid-cancel)', { runId });
            return { runId, status: 'CANCELLING' };
        }
        case 'STARTING':
        case 'RUNNING':
            await deps.redis.set(cancelKey, '1', 'PX', CANCEL_KEY_TTL_MS);
            await deps.repos.runs.updateStatus(runId, 'CANCELLING');
            deps.logger?.info('run cancellation requested', { runId, previousStatus: run.status });
            return { runId, status: 'CANCELLING' };
        case 'CANCELLING':
            await deps.redis.set(cancelKey, '1', 'PX', CANCEL_KEY_TTL_MS); // idempotent re-arm
            return { runId, status: 'CANCELLING' };
        default:
            throw new QueueAdminError(
                'INVALID_RUN_STATE',
                `run ${runId} is already terminal (${run.status}) — cannot cancel`,
            );
    }
}

/**
 * Retry = "same config, new attempt" (§4.2): creates a NEW run with trigger
 * RETRY and the ORIGINAL run's snapshot (not the current definition), then
 * enqueues it. Only FAILED/PARTIAL/CANCELLED runs are retryable.
 */
export async function retryRun(deps: QueueAdminDeps, runId: string): Promise<EnqueueResult> {
    const loaded = await deps.repos.runs.getRunWithEvents(runId);
    if (loaded === null) throw new QueueAdminError('RUN_NOT_FOUND', `run not found: ${runId}`);
    const run: RunRecord = loaded.run;
    if (!RETRYABLE_RUN_STATUSES.includes(run.status)) {
        throw new QueueAdminError(
            'INVALID_RUN_STATE',
            `only FAILED/PARTIAL/CANCELLED runs can be retried (run ${runId} is ${run.status})`,
        );
    }
    return enqueueScanRun(deps, run.scanDefinitionId, 'RETRY', {
        snapshotOverride: run.configurationSnapshot,
        skipEnabledCheck: true,
    });
}

/**
 * Compare-and-delete release of the scan lock — only the run that acquired
 * it may delete it (a stale value means another enqueue is in flight and the
 * lock must survive). Best-effort: the 30s PX is the backstop.
 */
export async function releaseScanLock(
    redis: Redis,
    scanDefinitionId: string,
    runId: string,
    keyBuilder: (scanDefinitionId: string) => string = defaultKeyBuilders.scanLockKey,
): Promise<void> {
    const script =
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
    try {
        await redis.eval(script, 1, keyBuilder(scanDefinitionId), runId);
    } catch {
        // best-effort — the PX TTL bounds any leftover lock
    }
}
