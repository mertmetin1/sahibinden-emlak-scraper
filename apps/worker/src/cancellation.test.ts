/**
 * RedisCancellationToken against the real Redis (keys prefixed `sahtest:`).
 * No database, no browser.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisCancellationToken } from './cancellation.js';
import { createTestRedis, flushTestKeys, testKeyBuilders } from './test/helpers.js';

/** Redis-only suite — no database needed. */
const SLUG = 'cancel';

describe('RedisCancellationToken', () => {
    let redis: Redis;

    beforeAll(async () => {
        redis = createTestRedis();
        await redis.ping();
    });

    afterAll(async () => {
        await flushTestKeys(redis, SLUG);
        redis.disconnect();
    });

    it('flips isCancelled when the cancel key is set (polled)', async () => {
        const runId = `run-${randomUUID()}`;
        const keys = testKeyBuilders(SLUG);
        const token = new RedisCancellationToken(redis, runId, {
            pollIntervalMs: 50,
            keyBuilder: keys.cancelKey,
        });
        try {
            expect(token.isCancelled).toBe(false);
            expect(token.cancelReason).toBeNull();

            await redis.set(keys.cancelKey(runId), '1', 'PX', 60_000);

            await vi.waitFor(() => expect(token.isCancelled).toBe(true), { timeout: 3_000, interval: 25 });
            expect(token.cancelReason).toBe('cancel requested via API');
        } finally {
            token.dispose();
        }
    });

    it('checkNow() performs an immediate out-of-band check', async () => {
        const runId = `run-${randomUUID()}`;
        const keys = testKeyBuilders(SLUG);
        await redis.set(keys.cancelKey(runId), '1', 'PX', 60_000);

        const token = new RedisCancellationToken(redis, runId, {
            pollIntervalMs: 60_000, // polling disabled in practice
            keyBuilder: keys.cancelKey,
        });
        try {
            expect(token.isCancelled).toBe(false); // constructor must not block on Redis
            await expect(token.checkNow()).resolves.toBe(true);
            expect(token.isCancelled).toBe(true);
        } finally {
            token.dispose();
        }
    });

    it('requestCancel() flips locally without any Redis key (shutdown path)', async () => {
        const runId = `run-${randomUUID()}`;
        const token = new RedisCancellationToken(redis, runId, {
            pollIntervalMs: 50,
            keyBuilder: testKeyBuilders(SLUG).cancelKey,
        });
        try {
            expect(token.isCancelled).toBe(false);
            token.requestCancel();
            expect(token.isCancelled).toBe(true);
            expect(token.cancelReason).toBe('worker shutdown');
        } finally {
            token.dispose();
        }
    });

    it('stops polling after dispose()', async () => {
        const runId = `run-${randomUUID()}`;
        const keys = testKeyBuilders(SLUG);
        const token = new RedisCancellationToken(redis, runId, {
            pollIntervalMs: 50,
            keyBuilder: keys.cancelKey,
        });
        token.dispose();
        await redis.set(keys.cancelKey(runId), '1', 'PX', 60_000);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(token.isCancelled).toBe(false);
    });

    it('does not flip on a different run id (key isolation)', async () => {
        const runId = `run-${randomUUID()}`;
        const otherRunId = `run-${randomUUID()}`;
        const keys = testKeyBuilders(SLUG);
        const token = new RedisCancellationToken(redis, runId, {
            pollIntervalMs: 50,
            keyBuilder: keys.cancelKey,
        });
        try {
            await redis.set(keys.cancelKey(otherRunId), '1', 'PX', 60_000);
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(token.isCancelled).toBe(false);
        } finally {
            token.dispose();
        }
    });
});
