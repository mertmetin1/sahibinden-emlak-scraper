/**
 * ScanScheduler — cron dispatch (ARCHITECTURE.md §6.2, ADR-0003).
 *
 * Every 30s tick: enabled ScanDefinitions with a non-null `schedule` are
 * evaluated IN THEIR OWN TIMEZONE (croner). A scan is due when the latest
 * cron occurrence falls within the last 60s AND the scan has no active run
 * AND no SCHEDULE-triggered run was already created since that occurrence
 * (the double-fire guard — Postgres, not ScanDefinition.lastScheduledAt, is
 * the guard; the real schema has no such column and the run journal is
 * strictly stronger). Missed windows while the worker was down are NOT
 * backfilled (deliberate, ADR-0003).
 *
 * `computeDueScans` is the pure, DB-free core — unit-tested over a matrix of
 * due/not-due/already-active/already-fired/timezone/invalid cases.
 */
import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { DatabaseRepositories, ScanRunStatusValue, ScanTriggerValue } from '@sahibindenbot/database';
import { enqueueScanRun, QueueAdminError } from './queue-admin.js';
import type { QueueAdminDeps } from './queue-admin.js';

export const SCHEDULER_TICK_MS = 30_000;
export const DUE_WINDOW_MS = 60_000;
export const DEFAULT_TIMEZONE = 'Europe/Istanbul';

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['QUEUED', 'STARTING', 'RUNNING', 'CANCELLING']);

export interface SchedulableScan {
    id: string;
    name: string;
    schedule: string;
    timezone: string;
}

export interface RecentRunSummary {
    status: ScanRunStatusValue;
    trigger: ScanTriggerValue;
    createdAt: Date;
}

export type DueReason = 'due' | 'not-due' | 'already-active' | 'already-fired' | 'invalid-schedule';

export interface DueDecision {
    scanId: string;
    scanName: string;
    due: boolean;
    reason: DueReason;
    /** The cron occurrence that fired (null when not due / unparseable). */
    occurrence: Date | null;
    error?: string;
}

/**
 * Latest cron occurrence in (now - windowMs - 1s, now], or null.
 * croner v9 has no "previous occurrence before t" primitive (previousRun()
 * is job-state, not a date query), so we enumerate forward from just outside
 * the window with nextRun() and keep the last hit ≤ now. `paused: true`
 * jobs never execute — nextRun is a pure query.
 */
export function latestOccurrenceWithin(schedule: string, timezone: string, now: Date, windowMs: number): Date | null {
    const cron = new Cron(schedule, { timezone, paused: true });
    try {
        let candidate = cron.nextRun(new Date(now.getTime() - windowMs - 1_000));
        let latest: Date | null = null;
        let guard = 0;
        while (candidate !== null && candidate.getTime() <= now.getTime() && guard < 10) {
            latest = candidate;
            // +1s: croner strips milliseconds; stepping a whole second
            // guarantees progress whether nextRun is inclusive or exclusive.
            candidate = cron.nextRun(new Date(candidate.getTime() + 1_000));
            guard += 1;
        }
        return latest;
    } finally {
        cron.stop();
    }
}

/** Pure due-evaluation. `recentRunsByScan` holds the scan's latest runs (any status). */
export function computeDueScans(
    scans: readonly SchedulableScan[],
    now: Date,
    recentRunsByScan: ReadonlyMap<string, readonly RecentRunSummary[]>,
    windowMs: number = DUE_WINDOW_MS,
): DueDecision[] {
    return scans.map((scan) => {
        const base = { scanId: scan.id, scanName: scan.name };
        let occurrence: Date | null;
        try {
            occurrence = latestOccurrenceWithin(scan.schedule, scan.timezone || DEFAULT_TIMEZONE, now, windowMs);
        } catch (err) {
            return {
                ...base,
                due: false,
                reason: 'invalid-schedule',
                occurrence: null,
                error: err instanceof Error ? err.message : String(err),
            };
        }
        if (occurrence === null) return { ...base, due: false, reason: 'not-due', occurrence: null };

        const runs = recentRunsByScan.get(scan.id) ?? [];
        if (runs.some((run) => ACTIVE_STATUSES.has(run.status))) {
            return { ...base, due: false, reason: 'already-active', occurrence };
        }
        if (runs.some((run) => run.trigger === 'SCHEDULE' && run.createdAt.getTime() >= occurrence.getTime())) {
            return { ...base, due: false, reason: 'already-fired', occurrence };
        }
        return { ...base, due: true, reason: 'due', occurrence };
    });
}

export interface ScanSchedulerDeps {
    repos: DatabaseRepositories;
    queueAdmin: QueueAdminDeps;
    logger: Logger;
    tickMs?: number;
    windowMs?: number;
}

export class ScanScheduler {
    private timer: NodeJS.Timeout | null = null;
    private ticking = false;

    constructor(private readonly deps: ScanSchedulerDeps) {}

    start(): void {
        if (this.timer !== null) return;
        const tickMs = this.deps.tickMs ?? SCHEDULER_TICK_MS;
        this.timer = setInterval(() => {
            void this.safeTick();
        }, tickMs);
        this.timer.unref?.();
        this.deps.logger.info({ tickMs, windowMs: this.deps.windowMs ?? DUE_WINDOW_MS }, 'scan scheduler started');
    }

    stop(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
    }

    /** Overlap-guarded tick wrapper — a slow tick never stacks the next one. */
    private async safeTick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            await this.tickOnce();
        } catch (err) {
            this.deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'scheduler tick failed');
        } finally {
            this.ticking = false;
        }
    }

    /** One dispatch pass. Exported for tests and manual triggering. */
    async tickOnce(now: Date = new Date()): Promise<DueDecision[]> {
        const { rows } = await this.deps.repos.scans.list({ enabled: true }, 1, 200);
        const scheduled = rows.filter((row) => row.schedule !== null && row.schedule.trim() !== '');

        const recentRunsByScan = new Map<string, RecentRunSummary[]>();
        for (const scan of scheduled) {
            const runs = await this.deps.repos.runs.listRuns(scan.id, undefined, 1, 20);
            recentRunsByScan.set(
                scan.id,
                runs.rows.map((run) => ({ status: run.status, trigger: run.trigger, createdAt: run.createdAt })),
            );
        }

        const decisions = computeDueScans(
            scheduled.map((scan) => ({
                id: scan.id,
                name: scan.name,
                schedule: scan.schedule as string, // filtered non-null above
                timezone: scan.timezone,
            })),
            now,
            recentRunsByScan,
            this.deps.windowMs ?? DUE_WINDOW_MS,
        );

        for (const decision of decisions) {
            if (decision.reason === 'invalid-schedule') {
                this.deps.logger.warn(
                    { scanId: decision.scanId, scanName: decision.scanName, error: decision.error },
                    'scan has an invalid cron schedule — skipped',
                );
                continue;
            }
            if (!decision.due) continue;
            try {
                const { runId } = await enqueueScanRun(this.deps.queueAdmin, decision.scanId, 'SCHEDULE');
                this.deps.logger.info(
                    {
                        scanId: decision.scanId,
                        scanName: decision.scanName,
                        runId,
                        occurrence: decision.occurrence?.toISOString() ?? null,
                    },
                    'SCHEDULED run fired',
                );
            } catch (err) {
                if (err instanceof QueueAdminError && err.code === 'RUN_ALREADY_ACTIVE') {
                    // Lost a race with a manual start / another dispatcher — fine.
                    this.deps.logger.debug({ scanId: decision.scanId }, 'scheduled fire skipped — run already active');
                } else {
                    this.deps.logger.error(
                        {
                            scanId: decision.scanId,
                            err: err instanceof Error ? err.message : String(err),
                        },
                        'scheduled fire failed',
                    );
                }
            }
        }
        return decisions;
    }
}
