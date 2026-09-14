/**
 * Redis wiring. Two connection families:
 * - BullMQ Queue/Worker get CONNECTION OPTIONS (BullMQ manages its own
 *   pooled/blocking connections; ioredis' default retryStrategy reconnects
 *   automatically — required by "BullMQ connection options must allow
 *   reconnection").
 * - The worker's own key/lock/pub-sub traffic uses ONE shared ioredis
 *   client (createRedisClient).
 *
 * BullMQ hard requirement (v5): blocking commands need
 * `maxRetriesPerRequest: null`, otherwise the Worker throws at boot.
 */
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';

/**
 * Parses redis://[:user:pass@]host[:port][/db] / rediss:// into ioredis
 * options. The URL itself is NEVER logged (may embed a password) — parse
 * failures raise a secret-free message.
 */
export function parseRedisUrl(redisUrl: string): RedisOptions {
    let url: URL;
    try {
        url = new URL(redisUrl);
    } catch {
        throw new Error('REDIS_URL is not a valid URL (expected redis://[user:pass@]host:port[/db])');
    }
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
        throw new Error(`REDIS_URL must use redis:// or rediss:// (got protocol '${url.protocol}')`);
    }
    const options: RedisOptions = {
        host: url.hostname,
        port: url.port === '' ? 6379 : Number(url.port),
    };
    if (url.username !== '') options.username = decodeURIComponent(url.username);
    if (url.password !== '') options.password = decodeURIComponent(url.password);
    if (url.pathname !== '' && url.pathname !== '/') {
        const db = Number(url.pathname.slice(1));
        if (!Number.isInteger(db) || db < 0) throw new Error('REDIS_URL db index must be a non-negative integer');
        options.db = db;
    }
    if (url.protocol === 'rediss:') options.tls = {};
    return options;
}

/** BullMQ connection options: parsed URL + the mandatory maxRetriesPerRequest: null. */
export function bullmqConnectionOptions(redisUrl: string): RedisOptions {
    return { ...parseRedisUrl(redisUrl), maxRetriesPerRequest: null };
}

/** The worker's own client (cancel keys, locks, pub/sub publish). */
export function createRedisClient(redisUrl: string): Redis {
    return new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        // ioredis defaults keep reconnecting (retryStrategy: 2s cap backoff);
        // enableOfflineQueue queues commands while reconnecting.
        enableReadyCheck: true,
    });
}
