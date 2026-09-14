/**
 * StaleRunSweeper — worker-death recovery (ARCHITECTURE.md §6.2, ADR-0003).
 *
 * The crawl worker heartbeats every 15s while RUNNING. When the worker
 * process dies, the run row would rot in STARTING/RUNNING/CANCELLING
 * forever — BullMQ's stalled detection (stalledInterval 30s,
 * maxStalledCount: 0) only fails the JOB, never the DB row. Every 30s this
 * sweeper:
 *
 *   - STARTING/RUNNING with heartbeat older than 60s → FAILED,
 *     errorSummary 'worker heartbeat lost (stale run recovery)';
 *   - CANCELLING with a stale heartbeat (the cancelling worker is gone — the
 *     run can never reach CANCELLED by itself) → CANCELLED;
 *   - best-effort: removes the leftover BullMQ job, releases the scan lock,
 *     and emits the terminal run event (persist-then-publish) so SSE clients
 *     see the run close.
 *
 * `sweepOnce` is exported for tests and manual invocation.
 */
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { CrawlJobData } from '@sahibindenbot/shared';
import type { DatabaseRepositories } from '@sahibindenbot/database';
import { DbRedisEventSink } from './event-sink.js';
import type { KeyBuilders } from './keys.js';
import { crawlJobId, releaseScanLock } from './queue-admin.js';

export const SWEEPER_TICK_MS = 30_000;
export const STALE_HEARTBEAT_MS = 60_000;

export const STALE_FAILURE_SUMMARY = 'worker heartbeat lost (stale run recovery)';
export const STALE_CANCEL_SUMMARY = 'worker heartbeat lost during cancellation (stale run recovery)';

export interface SweeperDeps {
    repos: DatabaseRepositories;
    queue: Queue<CrawlJobData>;
    redis: Redis;
    logger: Logger;
    keyBuilders?: KeyBuilders;
}

export interface SweepResult {
    /** Run ids marked FAILED (were STARTING/RUNNING). */
    failed: string[];
    /** Run ids marked CANCELLED (were CANCELLING). */
    cancelled: string[];
}

export async function sweepOnce(deps: SweeperDeps, olderThanMs: number = STALE_HEARTBEAT_MS): Promise<SweepResult> {
    const stale = await deps.repos.runs.findStaleRunningRuns(olderThanMs);
    const result: SweepResult = { failed: [], cancelled: [] };

    for (const run of stale) {
        const sink = new DbRedisEventSink({
            runs: deps.repos.runs,
            redis: deps.redis,
            runId: run.id,
            scanDefinitionId: run.scanDefinitionId,
            ...(deps.keyBuilders !== undefined ? { channelBuilder: deps.keyBuilders.runEventsChannel } : {}),
        });
        const at = new Date().toISOString();

        if (run.status === 'CANCELLING') {
            await deps.repos.runs.finishRun(run.id, 'CANCELLED', {}, STALE_CANCEL_SUMMARY);
            sink.emit({ type: 'RUN_COMPLETED', at, data: { status: 'CANCELLED', errorSummary: STALE_CANCEL_SUMMARY } });
            result.cancelled.push(run.id);
        } else {
            await deps.repos.runs.finishRun(run.id, 'FAILED', {}, STALE_FAILURE_SUMMARY);
            sink.emit({ type: 'RUN_FAILED', at, data: { status: 'FAILED', message: STALE_FAILURE_SUMMARY } });
            result.failed.push(run.id);
        }
        await sink.flush();

        // Best-effort cleanup: the stalled BullMQ job (maxStalledCount: 0 has
        // already failed it — no re-run risk) and the scan lock.
        const job = await deps.queue.getJob(crawlJobId(run.scanDefinitionId, run.id)).catch(() => undefined);
        if (job !== undefined) await job.remove().catch(() => undefined);
        await releaseScanLock(deps.redis, run.scanDefinitionId, run.id, deps.keyBuilders?.scanLockKey);

        deps.logger.warn(
            { runId: run.id, scanId: run.scanDefinitionId, previousStatus: run.status },
            run.status === 'CANCELLING' ? 'stale CANCELLING run marked CANCELLED' : 'stale run marked FAILED',
        );
    }
    return result;
}

export class StaleRunSweeper {
    private timer: NodeJS.Timeout | null = null;
    private ticking = false;

    constructor(private readonly deps: SweeperDeps & { tickMs?: number }) {}

    start(): void {
        if (this.timer !== null) return;
        const tickMs = this.deps.tickMs ?? SWEEPER_TICK_MS;
        this.timer = setInterval(() => {
            void this.safeTick();
        }, tickMs);
        this.timer.unref?.();
        this.deps.logger.info({ tickMs, staleHeartbeatMs: STALE_HEARTBEAT_MS }, 'stale-run sweeper started');
    }

    stop(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
    }

    private async safeTick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            await sweepOnce(this.deps);
        } catch (err) {
            this.deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'sweeper tick failed');
        } finally {
            this.ticking = false;
        }
    }
}
