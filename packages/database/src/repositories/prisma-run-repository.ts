/**
 * Prisma implementation of RunRepository — run lifecycle writes, counter
 * increments, event journal (ScanRunEvent.id doubles as SSE replay cursor),
 * and stale-run discovery for the sweeper.
 */
import { CrawlError } from '@sahibindenbot/shared';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type {
    RunCounters,
    RunEventRecord,
    RunRecord,
    RunRepository,
    ScanRunStatusValue,
    ScanTriggerValue,
} from './interfaces.js';
import { toEventRecord, toRunRecord } from './prisma-mappers.js';

/** Counter field names are exactly the ScanRun column names (see interfaces.ts). */
const COUNTER_FIELDS = new Set([
    'pagesVisited',
    'categoryPagesVisited',
    'detailPagesVisited',
    'itemsDiscovered',
    'itemsInserted',
    'itemsUpdated',
    'pricesChanged',
    'failedRequests',
    'retryCount',
]);

export class PrismaRunRepository implements RunRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async createRun(
        scanDefinitionId: string,
        trigger: ScanTriggerValue,
        configurationSnapshot: unknown,
    ): Promise<RunRecord> {
        try {
            const run = await this.prisma.scanRun.create({
                data: {
                    scanDefinitionId,
                    trigger,
                    status: 'QUEUED',
                    // Caller supplies snapshot JSON — cast justified: unknown -> InputJsonValue.
                    configurationSnapshot: configurationSnapshot as Prisma.InputJsonValue,
                },
            });
            return toRunRecord(run);
        } catch (err) {
            throw wrapDbError(err, `createRun failed for scan ${scanDefinitionId}`);
        }
    }

    async updateStatus(
        runId: string,
        status: ScanRunStatusValue,
        timestamps?: { startedAt?: Date; finishedAt?: Date; durationMs?: number },
    ): Promise<void> {
        try {
            await this.prisma.scanRun.update({
                where: { id: runId },
                data: {
                    status,
                    ...(timestamps?.startedAt !== undefined ? { startedAt: timestamps.startedAt } : {}),
                    ...(timestamps?.finishedAt !== undefined ? { finishedAt: timestamps.finishedAt } : {}),
                    ...(timestamps?.durationMs !== undefined ? { durationMs: timestamps.durationMs } : {}),
                },
            });
        } catch (err) {
            throw wrapDbError(err, `updateStatus failed for run ${runId}`);
        }
    }

    async heartbeat(runId: string): Promise<void> {
        try {
            await this.prisma.scanRun.update({ where: { id: runId }, data: { heartbeatAt: new Date() } });
        } catch (err) {
            throw wrapDbError(err, `heartbeat failed for run ${runId}`);
        }
    }

    async addEvent(runId: string, type: string, data?: unknown): Promise<RunEventRecord> {
        try {
            const event = await this.prisma.scanRunEvent.create({
                data: {
                    runId,
                    type,
                    // undefined -> omit column (NULL); otherwise store JSON.
                    ...(data !== undefined ? { data: data as Prisma.InputJsonValue } : {}),
                },
            });
            return toEventRecord(event);
        } catch (err) {
            throw wrapDbError(err, `addEvent failed for run ${runId}`);
        }
    }

    async incrementCounter(runId: string, field: keyof RunCounters, by = 1): Promise<void> {
        if (!COUNTER_FIELDS.has(field)) {
            throw new CrawlError('DATABASE', `incrementCounter: unknown counter field '${String(field)}'`);
        }
        try {
            await this.prisma.scanRun.update({
                where: { id: runId },
                data: { [field]: { increment: by } },
            });
        } catch (err) {
            throw wrapDbError(err, `incrementCounter(${field}) failed for run ${runId}`);
        }
    }

    async finishRun(
        runId: string,
        status: ScanRunStatusValue,
        counters: Partial<RunCounters>,
        errorSummary?: string | null,
    ): Promise<void> {
        try {
            const run = await this.prisma.scanRun.findUnique({ where: { id: runId }, select: { startedAt: true } });
            if (run === null) throw new CrawlError('DATABASE', `finishRun: run not found: ${runId}`);
            const finishedAt = new Date();
            const durationMs = run.startedAt !== null ? finishedAt.getTime() - run.startedAt.getTime() : null;
            await this.prisma.scanRun.update({
                where: { id: runId },
                data: {
                    status,
                    ...counters,
                    finishedAt,
                    durationMs,
                    heartbeatAt: finishedAt,
                    ...(errorSummary !== undefined ? { errorSummary } : {}),
                },
            });
        } catch (err) {
            throw wrapDbError(err, `finishRun failed for run ${runId}`);
        }
    }

    async listRuns(
        scanId?: string,
        status?: ScanRunStatusValue,
        page = 1,
        pageSize = 20,
    ): Promise<{ rows: RunRecord[]; total: number }> {
        const where: Prisma.ScanRunWhereInput = {};
        if (scanId !== undefined) where.scanDefinitionId = scanId;
        if (status !== undefined) where.status = status;
        const safePage = Math.max(1, page);
        const safePageSize = Math.min(Math.max(1, pageSize), 200);
        const [total, rows] = await this.prisma.$transaction([
            this.prisma.scanRun.count({ where }),
            this.prisma.scanRun.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (safePage - 1) * safePageSize,
                take: safePageSize,
            }),
        ]);
        return { rows: rows.map(toRunRecord), total };
    }

    async getRunWithEvents(
        runId: string,
        afterEventId?: string | number | bigint,
    ): Promise<{ run: RunRecord; events: RunEventRecord[] } | null> {
        const run = await this.prisma.scanRun.findUnique({ where: { id: runId } });
        if (run === null) return null;
        const events = await this.prisma.scanRunEvent.findMany({
            where: {
                runId,
                ...(afterEventId !== undefined ? { id: { gt: BigInt(afterEventId) } } : {}),
            },
            orderBy: { id: 'asc' },
        });
        return { run: toRunRecord(run), events: events.map(toEventRecord) };
    }

    async findStaleRunningRuns(olderThanMs: number): Promise<RunRecord[]> {
        const cutoff = new Date(Date.now() - olderThanMs);
        const rows = await this.prisma.scanRun.findMany({
            where: {
                status: { in: ['STARTING', 'RUNNING', 'CANCELLING'] },
                OR: [
                    { heartbeatAt: { lt: cutoff } },
                    // never heartbeated — fall back to creation time
                    { heartbeatAt: null, createdAt: { lt: cutoff } },
                ],
            },
            orderBy: { createdAt: 'asc' },
        });
        return rows.map(toRunRecord);
    }
}

function wrapDbError(err: unknown, context: string): CrawlError {
    if (err instanceof CrawlError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CrawlError('DATABASE', `${context}: ${message}`, err);
}
