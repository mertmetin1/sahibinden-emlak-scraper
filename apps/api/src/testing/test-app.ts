/**
 * Hermetic test harness for the API app.
 *
 * - Real Postgres: the dedicated `sahibindenbot_test` database (provisioned +
 *   migrated by the repo setup; see apps/api README notes in the task report).
 * - Real Redis: every file gets its own key namespace (`sahtest:<ns>:*`) —
 *   BullMQ queue prefix AND the lock/cancel key functions are namespaced, so
 *   tests never touch dev (`sahbot:*` / `bull:*`) keys.
 * - Fixed test-only master key (NOT the dev key from .env).
 * - Parallel-file safety: the root vitest config runs up to 2 files
 *   concurrently against the same test DB, so instead of TRUNCATE (which
 *   would race), each context tracks the rows it created and deletes only
 *   those on cleanup. Names are randomized per test.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseEnv } from '../env.js';
import type { RunControlKeys } from '../queue.js';

export const TEST_DATABASE_URL =
    'postgresql://sahibinden:sahibinden_local_dev@localhost:5433/sahibindenbot_test?schema=public';
export const TEST_REDIS_URL = 'redis://localhost:6379';
/** 32 zero-ish bytes, base64 — valid AES-256 key, test-only, hermetic. */
export const TEST_MASTER_KEY = Buffer.from('a'.repeat(32), 'utf8').toString('base64');

export interface TestAppContext {
    app: FastifyInstance;
    /** The namespaced key functions the app under test was built with. */
    keys: RunControlKeys;
    /** BullMQ queue prefix the app under test was built with. */
    queuePrefix: string;
    /** Namespaced SSE pub/sub channel builder the app under test was built with. */
    runEventsChannel: (runId: string) => string;
    /** Rows created by the current test file — deleted by cleanup(). */
    track: {
        scanIds: string[];
        proxyProfileIds: string[];
        cookieProfileIds: string[];
        sessionPolicyIds: string[];
        listingIds: string[];
        sellerIds: string[];
        settingKeys: string[];
    };
    /** Deletes tracked rows + flushes this file's Redis namespace. */
    cleanup: () => Promise<void>;
}

export function uniqueName(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function buildTestContext(namespace: string): Promise<TestAppContext> {
    const env = parseEnv({
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL: TEST_REDIS_URL,
        APP_SECRET_KEY: TEST_MASTER_KEY,
        LOG_LEVEL: 'silent',
    });
    const prefix = `sahtest:${namespace}`;
    const keys: RunControlKeys = {
        scanLockKey: (scanDefinitionId) => `${prefix}:lock:scan:${scanDefinitionId}`,
        cancelKey: (runId) => `${prefix}:cancel:${runId}`,
    };
    const queuePrefix = `${prefix}:queue`;
    const runEventsChannel = (runId: string): string => `${prefix}:run-events:${runId}`;
    const app = await buildApp({ env, queuePrefix, keys, runEventsChannel });
    await app.ready();

    const track: TestAppContext['track'] = {
        scanIds: [],
        proxyProfileIds: [],
        cookieProfileIds: [],
        sessionPolicyIds: [],
        listingIds: [],
        sellerIds: [],
        settingKeys: [],
    };

    const cleanup = async (): Promise<void> => {
        // FK-safe order: scans cascade to runs/events; profiles detach or cascade.
        for (const id of track.scanIds.splice(0)) {
            await app.db.prisma.scanDefinition.deleteMany({ where: { id } });
        }
        for (const id of track.proxyProfileIds.splice(0)) {
            await app.db.prisma.proxyProfile.deleteMany({ where: { id } });
        }
        for (const id of track.cookieProfileIds.splice(0)) {
            await app.db.prisma.cookieProfile.deleteMany({ where: { id } });
        }
        for (const id of track.sessionPolicyIds.splice(0)) {
            await app.db.prisma.sessionPolicy.deleteMany({ where: { id } });
        }
        // Listings cascade their images/attributes/priceHistory/seenHistory/
        // runLinks; sellers are SetNull-detached from listings, so listings go
        // first, then sellers, then settings.
        for (const id of track.listingIds.splice(0)) {
            await app.db.prisma.listing.deleteMany({ where: { id } });
        }
        for (const id of track.sellerIds.splice(0)) {
            await app.db.prisma.seller.deleteMany({ where: { id } });
        }
        for (const key of track.settingKeys.splice(0)) {
            await app.db.prisma.appSetting.deleteMany({ where: { key } });
        }
        const redisKeys = await app.redis.keys(`${prefix}:*`);
        if (redisKeys.length > 0) await app.redis.del(...redisKeys);
    };

    return { app, keys, queuePrefix, runEventsChannel, track, cleanup };
}

/** Asserts none of the given secret strings appear anywhere in a response body. */
export function expectNoSecrets(rawBody: string, secrets: string[]): void {
    for (const secret of secrets) {
        if (rawBody.includes(secret)) {
            throw new Error(`response body leaks secret material: "${secret.slice(0, 4)}…"`);
        }
    }
}
