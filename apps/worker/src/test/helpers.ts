/**
 * Shared test harness for apps/worker — hermetic against the REAL local
 * services without ever touching production data:
 *
 * - Redis: the real instance at redis://localhost:6379, but every key lives
 *   under the file's isolation slug `sahtest-<slug>:*` (key builders AND the
 *   BullMQ `prefix`, whose keys land at `sahtest-<slug>:<queue>:*`).
 *   afterAll flushes exactly that glob via SCAN+DEL.
 * - Postgres: each DB-touching test FILE gets its own database
 *   (`sahibindenbot_test_<slug>`) — vitest runs files in parallel and a
 *   shared TRUNCATE would wipe the sibling file's rows mid-test (the same
 *   per-file-database convention as packages/database). NEVER the main db.
 *
 * Provisioning a new slug (once, idempotent):
 *   docker exec sahibindenbot-postgres psql -U sahibinden -d postgres -c "CREATE DATABASE sahibindenbot_test_<slug>"
 *   cd packages/database && DATABASE_URL="postgresql://sahibinden:sahibinden_local_dev@localhost:5433/sahibindenbot_test_<slug>" pnpm exec prisma migrate deploy
 *
 * If either service is unreachable these tests FAIL LOUDLY — no fake green.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { createLogger, CRAWL_QUEUE } from '@sahibindenbot/shared';
import type { CrawlJobData } from '@sahibindenbot/shared';
import { createDatabaseClient } from '@sahibindenbot/database';
import type { DatabaseClient } from '@sahibindenbot/database';
import { bullmqConnectionOptions } from '../redis.js';
import { prefixKeyBuilders } from '../keys.js';
import type { KeyBuilders } from '../keys.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// cwd (repo root for the root vitest run) first, then repo root relative to
// this file (apps/worker/src/test → ../../../..).
dotenv.config({ path: [path.resolve(process.cwd(), '.env'), path.resolve(here, '..', '..', '..', '..', '.env')] });

export const TEST_REDIS_URL = process.env.WORKER_TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

/** Default slug for suites that only need Redis (no DB). */
export const REDIS_ONLY_SLUG = 'redis';

/** Redis key prefix for one test file, e.g. `sahtest-qa:`. */
export function testKeyPrefix(slug: string): string {
    return `sahtest-${slug}:`;
}

export function testDatabaseUrl(slug: string): string {
    const dbName = `sahibindenbot_test_${slug}`;
    const override = process.env.WORKER_TEST_DATABASE_URL;
    if (override !== undefined && override.trim() !== '') {
        // The override pins the SERVER; the per-file db name still applies.
        try {
            const url = new URL(override.trim());
            url.pathname = `/${dbName}`;
            return url.toString();
        } catch {
            // fall through to DATABASE_URL derivation
        }
    }
    const main = process.env.DATABASE_URL;
    if (main !== undefined && main.trim() !== '') {
        try {
            const url = new URL(main.trim());
            url.pathname = `/${dbName}`;
            return url.toString();
        } catch {
            // fall through to the local default
        }
    }
    return `postgresql://sahibinden:sahibinden_local_dev@localhost:5433/${dbName}`;
}

export function testKeyBuilders(slug: string = REDIS_ONLY_SLUG): KeyBuilders {
    return prefixKeyBuilders(testKeyPrefix(slug));
}

export function createTestRedis(): Redis {
    return new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
}

export function createTestQueue(slug: string): Queue<CrawlJobData> {
    return new Queue<CrawlJobData>(CRAWL_QUEUE, {
        connection: bullmqConnectionOptions(TEST_REDIS_URL),
        // BullMQ prefix → keys `sahtest-<slug>:crawl-queue:*` (same glob as
        // the key builders, so flushTestKeys covers jobs too).
        prefix: `sahtest-${slug}`,
    });
}

export function createSilentLogger(): Logger {
    return createLogger('worker-test', 'silent');
}

/** Deletes every key of this test file (SCAN `sahtest-<slug>:*` + DEL batches). */
export async function flushTestKeys(redis: Redis, slug: string = REDIS_ONLY_SLUG): Promise<void> {
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${testKeyPrefix(slug)}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
}

/** Full wipe of all tables (the file's own test DB only!). */
export async function truncateAll(db: DatabaseClient): Promise<void> {
    await db.prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
            "ScanRunEvent", "ScanRunListing", "ListingSeenHistory", "ListingPriceHistory",
            "ListingAttribute", "ListingImage", "Listing", "Seller",
            "ScanRun", "ScanDefinition",
            "ProxyEndpoint", "ProxyProfile", "CookieProfile", "SessionPolicy", "AppSetting"
        RESTART IDENTITY CASCADE
    `);
}

export interface TestContext {
    db: DatabaseClient;
    redis: Redis;
    queue: Queue<CrawlJobData>;
    logger: Logger;
    slug: string;
}

/** Wired context for DB+Redis integration suites, isolated per slug. */
export async function createTestContext(slug: string): Promise<TestContext> {
    const db = createDatabaseClient(testDatabaseUrl(slug));
    const redis = createTestRedis();
    const queue = createTestQueue(slug);
    const logger = createSilentLogger();
    // Fail fast with a clear message when services are down.
    await redis.ping();
    await db.prisma.$queryRawUnsafe('SELECT 1');
    return { db, redis, queue, logger, slug };
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
    await ctx.queue.close().catch(() => undefined);
    await flushTestKeys(ctx.redis, ctx.slug).catch(() => undefined);
    ctx.redis.disconnect();
    await ctx.db.disconnect().catch(() => undefined);
}
