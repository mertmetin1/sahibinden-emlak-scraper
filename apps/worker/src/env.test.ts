/**
 * loadWorkerEnv — pure env-validation tests (no services). The worker must
 * fail fast with a bilingual TR/EN message on missing/invalid env.
 */
import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env.js';

// A syntactically valid 32-byte base64 key (content irrelevant — never used).
const VALID_KEY = Buffer.alloc(32, 1).toString('base64');

function validEnv(): NodeJS.ProcessEnv {
    return {
        DATABASE_URL: 'postgresql://sahibinden:x@localhost:5433/sahibindenbot',
        REDIS_URL: 'redis://localhost:6379',
        APP_SECRET_KEY: VALID_KEY,
    };
}

describe('loadWorkerEnv', () => {
    it('returns parsed env with defaults', () => {
        const env = loadWorkerEnv(validEnv());
        expect(env.databaseUrl).toContain('sahibindenbot');
        expect(env.redisUrl).toBe('redis://localhost:6379');
        expect(env.masterKey).toBe(VALID_KEY);
        expect(env.artifactsDir).toBe('storage/artifacts');
        expect(env.logLevel).toBe('info');
        expect(env.crawlConcurrency).toBe(1);
    });

    it('fails fast listing ALL missing vars, bilingually', () => {
        expect(() => loadWorkerEnv({ APP_SECRET_KEY: VALID_KEY })).toThrowError(/DATABASE_URL/);
        let message = '';
        try {
            loadWorkerEnv({ APP_SECRET_KEY: VALID_KEY });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('DATABASE_URL');
        expect(message).toContain('REDIS_URL');
        expect(message).toContain('Eksik ortam değişkeni'); // TR
        expect(message).toContain('missing environment variable'); // EN
    });

    it('rejects an invalid APP_SECRET_KEY via loadMasterKey', () => {
        expect(() => loadWorkerEnv({ ...validEnv(), APP_SECRET_KEY: 'not-base64!!' })).toThrowError(/APP_SECRET_KEY/);
        expect(() => loadWorkerEnv({ ...validEnv(), APP_SECRET_KEY: '' })).toThrowError(/APP_SECRET_KEY/);
    });

    it('honours WORKER_CRAWL_CONCURRENCY within 1-4 and rejects junk', () => {
        expect(loadWorkerEnv({ ...validEnv(), WORKER_CRAWL_CONCURRENCY: '3' }).crawlConcurrency).toBe(3);
        expect(() => loadWorkerEnv({ ...validEnv(), WORKER_CRAWL_CONCURRENCY: '0' })).toThrowError(
            /WORKER_CRAWL_CONCURRENCY/,
        );
        expect(() => loadWorkerEnv({ ...validEnv(), WORKER_CRAWL_CONCURRENCY: 'many' })).toThrowError(
            /WORKER_CRAWL_CONCURRENCY/,
        );
    });

    it('honours ARTIFACTS_DIR and LOG_LEVEL overrides', () => {
        const env = loadWorkerEnv({ ...validEnv(), ARTIFACTS_DIR: '/data/artifacts', LOG_LEVEL: 'debug' });
        expect(env.artifactsDir).toBe('/data/artifacts');
        expect(env.logLevel).toBe('debug');
    });
});
