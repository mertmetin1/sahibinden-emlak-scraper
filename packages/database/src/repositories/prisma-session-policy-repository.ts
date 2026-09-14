/**
 * PrismaSessionPolicyRepository — session policy CRUD. No secret material
 * lives on this model (pure operational knobs), so no encryption here.
 */
import { CrawlError } from '@sahibindenbot/shared';
import type { Prisma, PrismaClient, SessionPolicy } from '@prisma/client';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface SessionPolicyRecord {
    id: string;
    name: string;
    poolSize: number;
    maxUsageCount: number;
    maxAgeMinutes: number;
    persistCookiesPerSession: boolean;
    proxyAffinity: boolean;
    retireOnNetworkFailures: boolean;
    failureThreshold: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface SessionPolicyListItem extends SessionPolicyRecord {
    /** Number of ScanDefinitions referencing this policy. */
    assignedScanCount: number;
}

export interface SessionPolicyCreateInput {
    name: string;
    poolSize?: number;
    maxUsageCount?: number;
    maxAgeMinutes?: number;
    persistCookiesPerSession?: boolean;
    proxyAffinity?: boolean;
    retireOnNetworkFailures?: boolean;
    failureThreshold?: number;
}

export type SessionPolicyUpdateInput = Partial<SessionPolicyCreateInput>;

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toRecord(row: SessionPolicy): SessionPolicyRecord {
    return {
        id: row.id,
        name: row.name,
        poolSize: row.poolSize,
        maxUsageCount: row.maxUsageCount,
        maxAgeMinutes: row.maxAgeMinutes,
        persistCookiesPerSession: row.persistCookiesPerSession,
        proxyAffinity: row.proxyAffinity,
        retireOnNetworkFailures: row.retireOnNetworkFailures,
        failureThreshold: row.failureThreshold,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

const COUNT_INCLUDE = { _count: { select: { scanDefinitions: true } } } as const;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PrismaSessionPolicyRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async create(data: SessionPolicyCreateInput): Promise<SessionPolicyRecord> {
        try {
            const row = await this.prisma.sessionPolicy.create({ data: toCreateData(data) });
            return toRecord(row);
        } catch (err) {
            throw wrapDbError(err, `session policy create failed for '${data.name}'`);
        }
    }

    async getById(id: string): Promise<SessionPolicyRecord | null> {
        const row = await this.prisma.sessionPolicy.findUnique({ where: { id } });
        return row === null ? null : toRecord(row);
    }

    async update(id: string, patch: SessionPolicyUpdateInput): Promise<SessionPolicyRecord> {
        try {
            const data: Prisma.SessionPolicyUpdateInput = {};
            if (patch.name !== undefined) data.name = patch.name;
            if (patch.poolSize !== undefined) data.poolSize = patch.poolSize;
            if (patch.maxUsageCount !== undefined) data.maxUsageCount = patch.maxUsageCount;
            if (patch.maxAgeMinutes !== undefined) data.maxAgeMinutes = patch.maxAgeMinutes;
            if (patch.persistCookiesPerSession !== undefined) data.persistCookiesPerSession = patch.persistCookiesPerSession;
            if (patch.proxyAffinity !== undefined) data.proxyAffinity = patch.proxyAffinity;
            if (patch.retireOnNetworkFailures !== undefined) data.retireOnNetworkFailures = patch.retireOnNetworkFailures;
            if (patch.failureThreshold !== undefined) data.failureThreshold = patch.failureThreshold;
            const row = await this.prisma.sessionPolicy.update({ where: { id }, data });
            return toRecord(row);
        } catch (err) {
            throw wrapDbError(err, `session policy update failed for ${id}`);
        }
    }

    /** ScanDefinitions referencing the policy are SetNull-detached by the schema. */
    async delete(id: string): Promise<void> {
        try {
            await this.prisma.sessionPolicy.delete({ where: { id } });
        } catch (err) {
            throw wrapDbError(err, `session policy delete failed for ${id}`);
        }
    }

    async list(): Promise<SessionPolicyListItem[]> {
        const rows = await this.prisma.sessionPolicy.findMany({ orderBy: { createdAt: 'asc' }, include: COUNT_INCLUDE });
        return rows.map((row) => ({ ...toRecord(row), assignedScanCount: row._count.scanDefinitions }));
    }
}

function toCreateData(data: SessionPolicyCreateInput): Prisma.SessionPolicyCreateInput {
    return {
        name: data.name,
        ...(data.poolSize !== undefined ? { poolSize: data.poolSize } : {}),
        ...(data.maxUsageCount !== undefined ? { maxUsageCount: data.maxUsageCount } : {}),
        ...(data.maxAgeMinutes !== undefined ? { maxAgeMinutes: data.maxAgeMinutes } : {}),
        ...(data.persistCookiesPerSession !== undefined ? { persistCookiesPerSession: data.persistCookiesPerSession } : {}),
        ...(data.proxyAffinity !== undefined ? { proxyAffinity: data.proxyAffinity } : {}),
        ...(data.retireOnNetworkFailures !== undefined ? { retireOnNetworkFailures: data.retireOnNetworkFailures } : {}),
        ...(data.failureThreshold !== undefined ? { failureThreshold: data.failureThreshold } : {}),
    };
}

/** All persistence failures cross the boundary as CrawlError('DATABASE'). */
function wrapDbError(err: unknown, context: string): CrawlError {
    if (err instanceof CrawlError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CrawlError('DATABASE', `${context}: ${message}`, err);
}
