/**
 * Worker environment loading + validation. Fails FAST with a bilingual
 * (TR/EN) message — a worker that boots with a bad config fails every run
 * it picks up, so we refuse to boot instead.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadMasterKey } from '@sahibindenbot/shared';

export interface WorkerEnv {
    databaseUrl: string;
    redisUrl: string;
    /** Validated base64 32-byte AES-256-GCM master key (loadMasterKey). */
    masterKey: string;
    artifactsDir: string;
    logLevel: string;
    /** BullMQ crawl concurrency — browser-heavy, default 1 (ADR-0003). */
    crawlConcurrency: number;
}

/**
 * Loads .env into process.env. Looks at the cwd first (repo root when run
 * via `pnpm start` from the root), then at the repo root relative to this
 * module (apps/worker/src → ../../..), so `pnpm --filter …worker start`
 * (cwd = apps/worker) also finds it. Existing env vars always win
 * (dotenv never overrides).
 */
export function loadDotenv(): void {
    const here = path.dirname(fileURLToPath(import.meta.url));
    dotenv.config({ path: [path.resolve(process.cwd(), '.env'), path.resolve(here, '..', '..', '..', '.env')] });
}

function readRequired(env: NodeJS.ProcessEnv, name: string, missing: string[]): string {
    const value = env[name]?.trim();
    if (value === undefined || value === '') {
        missing.push(name);
        return '';
    }
    return value;
}

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
    const missing: string[] = [];
    const databaseUrl = readRequired(env, 'DATABASE_URL', missing);
    const redisUrl = readRequired(env, 'REDIS_URL', missing);
    if (missing.length > 0) {
        throw new Error(
            `Eksik ortam değişkeni / missing environment variable(s): ${missing.join(', ')}. ` +
                `Kök .env dosyasını kontrol edin / check the repository-root .env file (see .env.example).`,
        );
    }

    let masterKey: string;
    try {
        masterKey = loadMasterKey(env);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
            `APP_SECRET_KEY geçersiz / invalid: ${detail}. ` +
                `Üretmek için / to generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
        );
    }

    const concurrencyRaw = env.WORKER_CRAWL_CONCURRENCY?.trim();
    const crawlConcurrency = concurrencyRaw === undefined || concurrencyRaw === '' ? 1 : Number(concurrencyRaw);
    if (!Number.isInteger(crawlConcurrency) || crawlConcurrency < 1 || crawlConcurrency > 4) {
        throw new Error(
            `WORKER_CRAWL_CONCURRENCY 1-4 arası bir tamsayı olmalı / must be an integer between 1 and 4 ` +
                `(got '${concurrencyRaw ?? ''}') — browser-heavy crawling defaults to 1 (ADR-0003).`,
        );
    }

    return {
        databaseUrl,
        redisUrl,
        masterKey,
        artifactsDir: env.ARTIFACTS_DIR?.trim() || 'storage/artifacts',
        logLevel: env.LOG_LEVEL?.trim() || 'info',
        crawlConcurrency,
    };
}
