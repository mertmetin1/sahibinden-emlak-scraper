/**
 * Prisma implementation of ScanRepository — scan definition CRUD, duplicate
 * (' (kopya)' suffix, disabled), and list-with-latest-run for the dashboard.
 */
import { CrawlError } from '@sahibindenbot/shared';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { RunRecord, ScanCreateInput, ScanRecord, ScanRepository, ScanUpdateInput } from './interfaces.js';
import { toRunRecord, toScanRecord } from './prisma-mappers.js';

export class PrismaScanRepository implements ScanRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async create(data: ScanCreateInput): Promise<ScanRecord> {
        try {
            const scan = await this.prisma.scanDefinition.create({ data: toCreateData(data) });
            return toScanRecord(scan);
        } catch (err) {
            throw wrapDbError(err, `scan create failed for '${data.name}'`);
        }
    }

    async getById(id: string): Promise<ScanRecord | null> {
        const scan = await this.prisma.scanDefinition.findUnique({ where: { id } });
        return scan === null ? null : toScanRecord(scan);
    }

    async update(id: string, patch: ScanUpdateInput): Promise<ScanRecord> {
        try {
            const scan = await this.prisma.scanDefinition.update({ where: { id }, data: toUpdateData(patch) });
            return toScanRecord(scan);
        } catch (err) {
            throw wrapDbError(err, `scan update failed for ${id}`);
        }
    }

    async delete(id: string): Promise<void> {
        try {
            await this.prisma.scanDefinition.delete({ where: { id } });
        } catch (err) {
            throw wrapDbError(err, `scan delete failed for ${id}`);
        }
    }

    async list(
        filters?: { enabled?: boolean; q?: string },
        page = 1,
        pageSize = 50,
    ): Promise<{ rows: ScanRecord[]; total: number }> {
        const where: Prisma.ScanDefinitionWhereInput = {};
        if (filters?.enabled !== undefined) where.enabled = filters.enabled;
        if (filters?.q !== undefined && filters.q.trim() !== '') {
            where.name = { contains: filters.q.trim(), mode: 'insensitive' };
        }
        const safePage = Math.max(1, page);
        const safePageSize = Math.min(Math.max(1, pageSize), 200);
        const [total, rows] = await this.prisma.$transaction([
            this.prisma.scanDefinition.count({ where }),
            this.prisma.scanDefinition.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (safePage - 1) * safePageSize,
                take: safePageSize,
            }),
        ]);
        return { rows: rows.map(toScanRecord), total };
    }

    async duplicate(id: string): Promise<ScanRecord> {
        try {
            const source = await this.prisma.scanDefinition.findUnique({ where: { id } });
            if (source === null) throw new CrawlError('DATABASE', `duplicate: scan definition not found: ${id}`);
            // Strip identity/bookkeeping; copy every execution knob verbatim.
            const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = source;
            const copy = await this.prisma.scanDefinition.create({
                data: {
                    ...rest,
                    // JsonValue (read type, nullable) -> InputJsonValue (write type) — justified:
                    // these columns are non-null Json, so the stored value is never null.
                    startUrls: source.startUrls as Prisma.InputJsonValue,
                    allowedDomains: source.allowedDomains as Prisma.InputJsonValue,
                    name: `${source.name} (kopya)`,
                    enabled: false, // copies start disabled — deliberate operator action to enable
                },
            });
            return toScanRecord(copy);
        } catch (err) {
            throw wrapDbError(err, `scan duplicate failed for ${id}`);
        }
    }

    async listWithLatestRun(): Promise<Array<{ scan: ScanRecord; latestRun: RunRecord | null }>> {
        const scans = await this.prisma.scanDefinition.findMany({
            orderBy: { createdAt: 'desc' },
            include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 } },
        });
        return scans.map((scan) => ({
            scan: toScanRecord(scan),
            latestRun: scan.runs[0] !== undefined ? toRunRecord(scan.runs[0]) : null,
        }));
    }
}

function toCreateData(data: ScanCreateInput): Prisma.ScanDefinitionCreateInput {
    return {
        name: data.name,
        startUrls: data.startUrls,
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        ...(data.schedule !== undefined ? { schedule: data.schedule } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        ...(data.maxItems !== undefined ? { maxItems: data.maxItems } : {}),
        ...(data.maxPages !== undefined ? { maxPages: data.maxPages } : {}),
        ...(data.includeDetails !== undefined ? { includeDetails: data.includeDetails } : {}),
        ...(data.incrementalMode !== undefined ? { incrementalMode: data.incrementalMode } : {}),
        ...(data.maxConcurrency !== undefined ? { maxConcurrency: data.maxConcurrency } : {}),
        ...(data.navigationTimeoutSeconds !== undefined ? { navigationTimeoutSeconds: data.navigationTimeoutSeconds } : {}),
        ...(data.requestHandlerTimeoutSeconds !== undefined
            ? { requestHandlerTimeoutSeconds: data.requestHandlerTimeoutSeconds }
            : {}),
        ...(data.maxRequestRetries !== undefined ? { maxRequestRetries: data.maxRequestRetries } : {}),
        ...(data.delayMinMs !== undefined ? { delayMinMs: data.delayMinMs } : {}),
        ...(data.delayMaxMs !== undefined ? { delayMaxMs: data.delayMaxMs } : {}),
        ...(data.browserMode !== undefined ? { browserMode: data.browserMode } : {}),
        ...(data.cdpUrl !== undefined ? { cdpUrl: data.cdpUrl } : {}),
        ...(data.proxyProfileId !== undefined && data.proxyProfileId !== null
            ? { proxyProfile: { connect: { id: data.proxyProfileId } } }
            : {}),
        ...(data.cookieProfileId !== undefined && data.cookieProfileId !== null
            ? { cookieProfile: { connect: { id: data.cookieProfileId } } }
            : {}),
        ...(data.sessionPolicyId !== undefined && data.sessionPolicyId !== null
            ? { sessionPolicy: { connect: { id: data.sessionPolicyId } } }
            : {}),
        ...(data.debugMode !== undefined ? { debugMode: data.debugMode } : {}),
        ...(data.storeRawHtml !== undefined ? { storeRawHtml: data.storeRawHtml } : {}),
        ...(data.storeScreenshotsOnFailure !== undefined
            ? { storeScreenshotsOnFailure: data.storeScreenshotsOnFailure }
            : {}),
        ...(data.staleDetectionEnabled !== undefined ? { staleDetectionEnabled: data.staleDetectionEnabled } : {}),
        ...(data.staleAfterSuccessfulRuns !== undefined ? { staleAfterSuccessfulRuns: data.staleAfterSuccessfulRuns } : {}),
        ...(data.allowedDomains !== undefined ? { allowedDomains: data.allowedDomains } : {}),
        ...(data.humanInTheLoop !== undefined ? { humanInTheLoop: data.humanInTheLoop } : {}),
    };
}

function toUpdateData(patch: ScanUpdateInput): Prisma.ScanDefinitionUpdateInput {
    // Same shape as create; every field optional. Explicit nulls clear
    // nullable columns (schedule, maxItems, FK disconnects handled by id null).
    const data: Prisma.ScanDefinitionUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.startUrls !== undefined) data.startUrls = patch.startUrls;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.schedule !== undefined) data.schedule = patch.schedule;
    if (patch.timezone !== undefined) data.timezone = patch.timezone;
    if (patch.maxItems !== undefined) data.maxItems = patch.maxItems;
    if (patch.maxPages !== undefined) data.maxPages = patch.maxPages;
    if (patch.includeDetails !== undefined) data.includeDetails = patch.includeDetails;
    if (patch.incrementalMode !== undefined) data.incrementalMode = patch.incrementalMode;
    if (patch.maxConcurrency !== undefined) data.maxConcurrency = patch.maxConcurrency;
    if (patch.navigationTimeoutSeconds !== undefined) data.navigationTimeoutSeconds = patch.navigationTimeoutSeconds;
    if (patch.requestHandlerTimeoutSeconds !== undefined)
        data.requestHandlerTimeoutSeconds = patch.requestHandlerTimeoutSeconds;
    if (patch.maxRequestRetries !== undefined) data.maxRequestRetries = patch.maxRequestRetries;
    if (patch.delayMinMs !== undefined) data.delayMinMs = patch.delayMinMs;
    if (patch.delayMaxMs !== undefined) data.delayMaxMs = patch.delayMaxMs;
    if (patch.browserMode !== undefined) data.browserMode = patch.browserMode;
    if (patch.cdpUrl !== undefined) data.cdpUrl = patch.cdpUrl;
    if (patch.proxyProfileId !== undefined) {
        data.proxyProfile = patch.proxyProfileId === null ? { disconnect: true } : { connect: { id: patch.proxyProfileId } };
    }
    if (patch.cookieProfileId !== undefined) {
        data.cookieProfile =
            patch.cookieProfileId === null ? { disconnect: true } : { connect: { id: patch.cookieProfileId } };
    }
    if (patch.sessionPolicyId !== undefined) {
        data.sessionPolicy =
            patch.sessionPolicyId === null ? { disconnect: true } : { connect: { id: patch.sessionPolicyId } };
    }
    if (patch.debugMode !== undefined) data.debugMode = patch.debugMode;
    if (patch.storeRawHtml !== undefined) data.storeRawHtml = patch.storeRawHtml;
    if (patch.storeScreenshotsOnFailure !== undefined) data.storeScreenshotsOnFailure = patch.storeScreenshotsOnFailure;
    if (patch.staleDetectionEnabled !== undefined) data.staleDetectionEnabled = patch.staleDetectionEnabled;
    if (patch.staleAfterSuccessfulRuns !== undefined) data.staleAfterSuccessfulRuns = patch.staleAfterSuccessfulRuns;
    if (patch.allowedDomains !== undefined) data.allowedDomains = patch.allowedDomains;
    if (patch.humanInTheLoop !== undefined) data.humanInTheLoop = patch.humanInTheLoop;
    return data;
}

function wrapDbError(err: unknown, context: string): CrawlError {
    if (err instanceof CrawlError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CrawlError('DATABASE', `${context}: ${message}`, err);
}
