/**
 * The crawl executor — a BullMQ Worker on CRAWL_QUEUE (concurrency 1 by
 * default; browser-heavy, ADR-0003). Job data is just { runId }: the run row
 * (with its immutable configurationSnapshot) is rehydrated from Postgres —
 * "Postgres is truth, BullMQ is transport".
 *
 * Lifecycle per job:
 *   load run → CANCELLING-at-pickup → mark CANCELLED, done
 *            → terminal-at-pickup → UnrecoverableError (no retry)
 *   QUEUED → STARTING (startedAt) → cancel-key pre-check → RUNNING
 *     (heartbeat every 15s) → runCrawl(config, deps) → terminal mapping
 *
 * Terminal mapping (CrawlResult → finishRun):
 *   status SUCCEEDED/PARTIAL/FAILED/CANCELLED straight through; counters
 *   itemsInserted/itemsUpdated/pricesChanged come from the
 *   PrismaOutputRepository's collected outcome counts (EXACT — CrawlResult
 *   only carries the mutated total itemsWritten); failedRequests,
 *   categoryPagesVisited, detailPagesVisited from the result;
 *   pagesVisited = category + detail. retryCount is NOT exposed by
 *   CrawlResult — left untouched (documented limitation).
 *   errorSummary: first 3 classified error messages, redacted, joined.
 *   Output-repository item failures downgrade SUCCEEDED → PARTIAL (silent
 *   data loss must not look like full success).
 *
 * Job failure: attempts: 2 (set at enqueue). A non-final throw hands the run
 * back to QUEUED (heartbeats stop; the sweeper's 60s cutoff only looks at
 * STARTING/RUNNING/CANCELLING, so a run waiting for its 5s BullMQ retry is
 * never condemned). The final throw marks the run FAILED with a classified,
 * redacted errorSummary. A run is NEVER left RUNNING.
 *
 * BullMQ quirks documented for the Lead:
 *   - maxStalledCount: 0 (ADR-0003): a stalled job fails immediately instead
 *     of being re-run — crawl side effects must not duplicate.
 *   - lockDuration raised to 120s (default 30s): crawls run for minutes;
 *     BullMQ auto-renews the lock while the event loop stays responsive, the
 *     raise is headroom against event-loop stalls.
 *   - UnrecoverableError fails the job without consuming retries.
 */
import { UnrecoverableError, Worker } from 'bullmq';
import type { Job, Worker as BullWorker } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CRAWL_QUEUE, redactSecrets, toRuntimeLogger } from '@sahibindenbot/shared';
import type { CrawlJobData, CrawlResult } from '@sahibindenbot/shared';
import type {
    DatabaseClient,
    OutcomeCounts,
    PrismaCookieProfileRepository,
    PrismaProxyProfileRepository,
    PrismaSessionPolicyRepository,
    RunCounters,
    ScanRunStatusValue,
} from '@sahibindenbot/database';
import { classifyError, crawlConfigFromSnapshot, runCrawl } from '@sahibindenbot/scraper-engine';
import { RedisCancellationToken } from './cancellation.js';
import { buildCrawlDeps } from './deps-factory.js';
import type { BuiltCrawlDeps } from './deps-factory.js';
import type { KeyBuilders } from './keys.js';
import { releaseScanLock } from './queue-admin.js';
import { parseWorkerSnapshot } from './snapshot.js';
import type { WorkerSnapshot } from './snapshot.js';

export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface CrawlWorkerDeps {
    db: DatabaseClient;
    redis: Redis;
    /** BullMQ connection options (see redis.ts bullmqConnectionOptions). */
    connection: RedisOptions;
    proxyProfiles: PrismaProxyProfileRepository;
    cookieProfiles: PrismaCookieProfileRepository;
    sessionPolicies: PrismaSessionPolicyRepository;
    logger: Logger;
    artifactsDir: string;
    concurrency?: number;
    keyBuilders?: KeyBuilders;
    /** Test hook: BullMQ key prefix (must match the producer Queue's prefix). */
    prefix?: string;
}

export interface ActiveRunInfo {
    runId: string;
    token: RedisCancellationToken;
}

export interface CrawlWorkerHandle {
    worker: BullWorker<CrawlJobData>;
    /** The currently executing run (null when idle) — shutdown reads this. */
    getActiveRun(): ActiveRunInfo | null;
    /** Resolves true when no job is executing; false after timeoutMs. */
    waitForActiveJob(timeoutMs: number): Promise<boolean>;
}

export function createCrawlWorker(deps: CrawlWorkerDeps): CrawlWorkerHandle {
    let active: { runId: string; token: RedisCancellationToken; done: Promise<void> } | null = null;

    const processor = async (job: Job<CrawlJobData>): Promise<ScanRunStatusValue> => {
        const { runId } = job.data;
        const log = deps.logger.child({ runId, jobId: job.id ?? null });

        const loaded = await deps.db.repos.runs.getRunWithEvents(runId);
        if (loaded === null) {
            // No run row → nothing to recover; failing without retry is correct.
            throw new UnrecoverableError(`ScanRun not found: ${runId}`);
        }
        const run = loaded.run;
        const scanId = run.scanDefinitionId;
        const runLog = log.child({ scanDefinitionId: scanId });

        // The scan lock is released no matter how the processor exits.
        try {
            // Cancelled while sitting in the queue (the API's job removal lost
            // the race against this pickup) → straight to CANCELLED.
            if (run.status === 'CANCELLING' || run.status === 'CANCELLED') {
                await deps.db.repos.runs.finishRun(runId, 'CANCELLED', {}, 'cancelled while queued');
                runLog.info('run was cancelled while queued — marked CANCELLED');
                return 'CANCELLED';
            }
            if (run.status !== 'QUEUED' && run.status !== 'STARTING' && run.status !== 'RUNNING') {
                throw new UnrecoverableError(`run ${runId} picked up in terminal status ${run.status}`);
            }
            if (run.status !== 'QUEUED') {
                // BullMQ retry after a processor crash: upserts are idempotent
                // and finishRun writes absolute counters, so restarting is safe.
                runLog.warn(
                    { status: run.status, attempt: job.attemptsMade + 1 },
                    're-running a run left non-QUEUED (BullMQ retry) — restarting crawl',
                );
            }

            // From here on, ANY throw must route through handleJobFailure so
            // the run row reaches a terminal state (FAILED on the final
            // attempt, back to QUEUED for a retry) — a malformed snapshot or
            // a missing scan must not strand the row in QUEUED/STARTING.
            try {
                let snapshot: WorkerSnapshot;
                try {
                    snapshot = parseWorkerSnapshot(run.configurationSnapshot);
                } catch (err) {
                    throw new UnrecoverableError(
                        `run ${runId} has a malformed configurationSnapshot: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
                const scan = await deps.db.repos.scans.getById(scanId);
                if (scan === null) throw new UnrecoverableError(`scan definition ${scanId} not found for run ${runId}`);

                await deps.db.repos.runs.updateStatus(runId, 'STARTING', { startedAt: new Date() });

                const token = new RedisCancellationToken(deps.redis, runId, {
                    ...(deps.keyBuilders !== undefined ? { keyBuilder: deps.keyBuilders.cancelKey } : {}),
                    logger: toRuntimeLogger(runLog),
                    onCancel: (reason) => runLog.info({ reason }, 'cancellation requested — engine will drain'),
                });
                let resolveDone!: () => void;
                const done = new Promise<void>((resolve) => {
                    resolveDone = resolve;
                });
                active = { runId, token, done };

                try {
                await token.checkNow();
                if (token.isCancelled) {
                    await deps.db.repos.runs.finishRun(runId, 'CANCELLED', {}, 'cancelled before the crawl started');
                    runLog.info('cancel key set before RUNNING — marked CANCELLED');
                    return 'CANCELLED';
                }

                await deps.db.repos.runs.updateStatus(runId, 'RUNNING');
                await deps.db.repos.runs.heartbeat(runId);
                const heartbeatTimer = setInterval(() => {
                    void deps.db.repos.runs
                        .heartbeat(runId)
                        .catch((err: unknown) =>
                            runLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'heartbeat failed'),
                        );
                }, HEARTBEAT_INTERVAL_MS);
                heartbeatTimer.unref?.();

                try {
                    const config = crawlConfigFromSnapshot(snapshot);
                    const built: BuiltCrawlDeps = await buildCrawlDeps({
                        db: deps.db,
                        redis: deps.redis,
                        proxyProfiles: deps.proxyProfiles,
                        cookieProfiles: deps.cookieProfiles,
                        sessionPolicies: deps.sessionPolicies,
                        runId,
                        scanDefinitionId: scanId,
                        snapshot,
                        logger: deps.logger,
                        artifactsDir: deps.artifactsDir,
                        cancellation: token,
                        ...(deps.keyBuilders !== undefined ? { keyBuilders: deps.keyBuilders } : {}),
                    });
                    let result: CrawlResult;
                    try {
                        result = await runCrawl(config, built.crawlDeps);
                    } finally {
                        // Persist-then-publish chain must drain before the
                        // terminal state write (SSE clients rely on order).
                        await built.eventSink.flush();
                    }

                    const counters = mapResultCounters(result, built.output.getOutcomeCounts());
                    const outputErrors = built.output.getErrors();
                    let status = result.status;
                    let errorSummary = summarizeErrors(result.errors);
                    if (outputErrors.length > 0) {
                        const note = `${outputErrors.length} listing write(s) failed (DATABASE)`;
                        errorSummary = errorSummary === null ? note : `${errorSummary} | ${note}`;
                        if (status === 'SUCCEEDED') status = 'PARTIAL';
                    }
                    if (status === 'CANCELLED' && errorSummary === null) {
                        errorSummary = token.cancelReason ?? 'cancelled';
                    }

                    // Staleness evaluation (§5.1): only non-incremental
                    // SUCCEEDED runs of stale-detection-enabled scans count.
                    if (status === 'SUCCEEDED' && snapshot.incrementalMode !== true && snapshot.staleDetectionEnabled !== false) {
                        try {
                            const staleness = await deps.db.repos.listings.applySuccessfulRunStaleness(scanId, runId);
                            runLog.info(
                                { staleMarked: staleness.staleMarked, resurrected: staleness.resurrected },
                                'post-run staleness evaluation applied',
                            );
                        } catch (err) {
                            // Staleness bookkeeping must never fail a good run.
                            runLog.warn(
                                { err: err instanceof Error ? err.message : String(err) },
                                'post-run staleness evaluation failed (non-fatal)',
                            );
                        }
                    }

                    await deps.db.repos.runs.finishRun(runId, status, counters, errorSummary);
                    runLog.info({ status, durationMs: result.durationMs, failedRequests: result.failedRequests }, 'run finished');
                    return status;
                } finally {
                    clearInterval(heartbeatTimer);
                }
                } finally {
                    token.dispose();
                    active = null;
                    resolveDone();
                }
            } catch (err) {
                // Single failure funnel for everything after the early-return
                // checks: snapshot/scan load, status transitions, deps build,
                // runCrawl. Retry-or-fail; the run never stays RUNNING.
                await handleJobFailure(job, err, deps, runId, runLog);
                throw err;
            }
        } finally {
            await releaseScanLock(deps.redis, scanId, runId, deps.keyBuilders?.scanLockKey);
        }
    };

    const worker = new Worker<CrawlJobData>(CRAWL_QUEUE, processor, {
        connection: deps.connection,
        concurrency: deps.concurrency ?? 1,
        stalledInterval: 30_000,
        maxStalledCount: 0,
        lockDuration: 120_000,
        ...(deps.prefix !== undefined ? { prefix: deps.prefix } : {}),
    });

    return {
        worker,
        getActiveRun: () => (active === null ? null : { runId: active.runId, token: active.token }),
        async waitForActiveJob(timeoutMs: number): Promise<boolean> {
            const current = active;
            if (current === null) return true;
            const drained = current.done.then(() => true as const);
            const timedOut = new Promise<false>((resolve) => {
                const timer = setTimeout(() => resolve(false), timeoutMs);
                timer.unref?.();
            });
            return Promise.race([drained, timedOut]);
        },
    };
}

/**
 * Retry-or-fail decision for a thrown processor error. Non-final attempts
 * hand the run back to QUEUED (BullMQ retries after the 5s backoff); the
 * final attempt marks FAILED. Either way the run never stays RUNNING.
 */
async function handleJobFailure(
    job: Job<CrawlJobData>,
    err: unknown,
    deps: CrawlWorkerDeps,
    runId: string,
    log: Logger,
): Promise<void> {
    const code = classifyError(err);
    const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);
    const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0 ? job.opts.attempts : 1;
    const isFinal = err instanceof UnrecoverableError || job.attemptsMade + 1 >= maxAttempts;

    if (isFinal) {
        try {
            await deps.db.repos.runs.finishRun(runId, 'FAILED', {}, `[${code}] ${message}`);
        } catch (finishErr) {
            log.error(
                { err: finishErr instanceof Error ? finishErr.message : String(finishErr) },
                'finishRun(FAILED) itself failed — sweeper will recover the run',
            );
        }
        log.error({ code, attempt: job.attemptsMade + 1, maxAttempts }, 'run marked FAILED (final attempt)');
    } else {
        try {
            await deps.db.repos.runs.updateStatus(runId, 'QUEUED');
            log.warn(
                { code, attempt: job.attemptsMade + 1, maxAttempts },
                'attempt failed — run handed back to QUEUED for BullMQ retry',
            );
        } catch (statusErr) {
            log.warn(
                { err: statusErr instanceof Error ? statusErr.message : String(statusErr) },
                'failed to hand run back to QUEUED (sweeper backstops)',
            );
        }
    }
}

/**
 * CrawlResult → absolute ScanRun counters. The inserted/updated/pricesChanged
 * breakdown is NOT in CrawlResult (only the mutated total `itemsWritten`) —
 * the exact split comes from the output adapter's collected outcome counts.
 * `retryCount` has no source in CrawlResult and is left untouched.
 */
export function mapResultCounters(result: CrawlResult, outcomes: OutcomeCounts): Partial<RunCounters> {
    const detailPagesVisited = result.detailPagesVisited ?? 0;
    return {
        pagesVisited: result.categoryPagesVisited + detailPagesVisited,
        categoryPagesVisited: result.categoryPagesVisited,
        detailPagesVisited,
        itemsDiscovered: result.itemsDiscovered,
        itemsInserted: outcomes.inserted,
        itemsUpdated: outcomes.updated,
        pricesChanged: outcomes.priceChanged,
        failedRequests: result.failedRequests,
    };
}

/** First 3 classified error messages, redacted, joined — ScanRun.errorSummary. */
export function summarizeErrors(errors: CrawlResult['errors']): string | null {
    if (errors.length === 0) return null;
    const summary = errors
        .slice(0, 3)
        .map((error) => `[${error.code}] ${error.message}`)
        .join(' | ');
    return redactSecrets(summary).slice(0, 500);
}
