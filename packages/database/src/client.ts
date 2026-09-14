/**
 * DatabaseClient factory — the single entry point for wiring the persistence
 * layer. Consumers (worker, api, seed) call createDatabaseClient() and use
 * `repos.*`; `prisma` is exposed for the rare raw need (and for tests), but
 * no package other than this one may IMPORT @prisma/client types.
 */
import { PrismaClient } from '@prisma/client';
import type { ListingRepository, RunRepository, ScanRepository } from './repositories/interfaces.js';
import { PrismaListingRepository } from './repositories/prisma-listing-repository.js';
import { PrismaRunRepository } from './repositories/prisma-run-repository.js';
import { PrismaScanRepository } from './repositories/prisma-scan-repository.js';

export interface DatabaseRepositories {
    listings: ListingRepository;
    runs: RunRepository;
    scans: ScanRepository;
}

export interface DatabaseClient {
    prisma: PrismaClient;
    repos: DatabaseRepositories;
    disconnect(): Promise<void>;
}

/**
 * @param databaseUrl postgresql:// URL. Defaults to the DATABASE_URL env var
 *                    (Prisma's own resolution) when omitted.
 */
export function createDatabaseClient(databaseUrl?: string): DatabaseClient {
    const prisma = new PrismaClient(
        databaseUrl !== undefined ? { datasources: { db: { url: databaseUrl } } } : undefined,
    );
    return {
        prisma,
        repos: {
            listings: new PrismaListingRepository(prisma),
            runs: new PrismaRunRepository(prisma),
            scans: new PrismaScanRepository(prisma),
        },
        disconnect: () => prisma.$disconnect(),
    };
}
