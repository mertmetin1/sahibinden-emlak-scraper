/**
 * @sahibindenbot/worker — composition root (ARCHITECTURE.md §2.1, §6).
 *
 * Boots: env validation (fail fast, TR/EN) → DatabaseClient → Redis →
 * BullMQ queue + crawl Worker → cron scheduler → stale-run sweeper.
 *
 * Graceful shutdown (§6.3) on SIGTERM/SIGINT:
 *   1. stop scheduler + sweeper intervals (no new work is produced);
 *   2. worker.pause() — no new jobs are fetched;
 *   3. cooperative-cancel the active run (same path as API cancellation);
 *   4. wait for the active job up to 25s (compose stop_grace_period is 40s);
 *   5. worker.close() → queue.close() → prisma disconnect → redis quit →
 *      exit(0). A second signal forces exit(1) — the sweeper then recovers
 *      any abandoned run.
 *
 * NOTE: MAINTENANCE_QUEUE is intentionally NOT created — the scheduler and
 * sweeper run as in-process intervals (phase-10 tasking), so there is no
 * maintenance job traffic yet.
 */
import { Queue } from 'bullmq';
import { createLogger, redactSecrets, toRuntimeLogger } from '@sahibindenbot/shared';
import { CRAWL_QUEUE } from '@sahibindenbot/shared';
import type { CrawlJobData } from '@sahibindenbot/shared';
import {
    createDatabaseClient,
    PrismaCookieProfileRepository,
    PrismaProxyProfileRepository,
    PrismaSessionPolicyRepository,
} from '@sahibindenbot/database';
import { loadDotenv, loadWorkerEnv } from './env.js';
import type { WorkerEnv } from './env.js';
import { bullmqConnectionOptions, createRedisClient } from './redis.js';
import { createCrawlWorker } from './worker.js';
import { ScanScheduler } from './scheduler.js';
import { StaleRunSweeper } from './sweeper.js';
import type { QueueAdminDeps } from './queue-admin.js';

/** §6.3: cooperative-cancel budget for the active run during shutdown. */
const SHUTDOWN_BUDGET_MS = 25_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
    return redactSecrets(err instanceof Error ? err.message : String(err));
}

async function main(): Promise<void> {
    loadDotenv();
    const env: WorkerEnv = loadWorkerEnv(); // throws TR/EN on missing/invalid env
    const logger = createLogger('worker', env.logLevel);
    logger.info('worker starting / worker başlatılıyor…');

    const db = createDatabaseClient(env.databaseUrl);
    const redis = createRedisClient(env.redisUrl);
    const connection = bullmqConnectionOptions(env.redisUrl);

    const crawlQueue = new Queue<CrawlJobData>(CRAWL_QUEUE, { connection });

    // Secret-bearing repositories are constructed with the validated master
    // key; decryption happens ONLY inside this process (§10).
    const proxyProfiles = new PrismaProxyProfileRepository(db.prisma, env.masterKey);
    const cookieProfiles = new PrismaCookieProfileRepository(db.prisma, env.masterKey);
    const sessionPolicies = new PrismaSessionPolicyRepository(db.prisma);

    const workerHandle = createCrawlWorker({
        db,
        redis,
        connection,
        proxyProfiles,
        cookieProfiles,
        sessionPolicies,
        logger,
        artifactsDir: env.artifactsDir,
        concurrency: env.crawlConcurrency,
    });

    const queueAdmin: QueueAdminDeps = {
        repos: db.repos,
        queue: crawlQueue,
        redis,
        logger: toRuntimeLogger(logger),
    };
    const scheduler = new ScanScheduler({ repos: db.repos, queueAdmin, logger });
    const sweeper = new StaleRunSweeper({ repos: db.repos, queue: crawlQueue, redis, logger });
    scheduler.start();
    sweeper.start();

    workerHandle.worker.on('completed', (job) => {
        logger.info({ jobId: job.id, runId: job.data.runId }, 'crawl job completed');
    });
    workerHandle.worker.on('failed', (job, err) => {
        logger.error(
            { jobId: job?.id ?? null, runId: job?.data.runId ?? null, err: errMessage(err) },
            'crawl job failed',
        );
    });
    workerHandle.worker.on('error', (err) => {
        logger.error({ err: errMessage(err) }, 'bullmq worker error');
    });

    let shutdownStarted = false;
    const shutdown = (signal: string): void => {
        if (shutdownStarted) {
            logger.warn({ signal }, 'second signal received — forcing exit(1) / ikinci sinyal — zorla çıkılıyor');
            process.exit(1);
        }
        shutdownStarted = true;
        logger.info({ signal }, 'shutdown requested / kapatma isteği alındı');
        void (async (): Promise<void> => {
            // 1) stop producing work
            scheduler.stop();
            sweeper.stop();
            logger.info('scheduler + sweeper stopped');

            // 2) stop fetching new jobs
            await workerHandle.worker.pause().catch((err: unknown) => {
                logger.warn({ err: errMessage(err) }, 'worker.pause() failed — continuing shutdown');
            });
            logger.info('worker paused — no new jobs will be fetched');

            // 3) cooperative cancel of the active run (§6.3)
            const activeRun = workerHandle.getActiveRun();
            if (activeRun !== null) {
                activeRun.token.requestCancel('worker shutdown');
                logger.info({ runId: activeRun.runId }, 'cancellation signalled to the active run');
            }

            // 4) wait for the active job to drain (25s budget)
            const drained = await workerHandle.waitForActiveJob(SHUTDOWN_BUDGET_MS);
            if (drained) {
                logger.info('active job drained within the shutdown budget');
            } else {
                logger.warn(
                    { budgetMs: SHUTDOWN_BUDGET_MS },
                    'active job did not finish in time — proceeding; the sweeper will recover the run',
                );
            }

            // 5) ordered teardown
            await workerHandle.worker.close().catch((err: unknown) => {
                logger.warn({ err: errMessage(err) }, 'worker.close() failed — continuing');
            });
            logger.info('bullmq worker closed');
            await crawlQueue.close().catch((err: unknown) => {
                logger.warn({ err: errMessage(err) }, 'queue.close() failed — continuing');
            });
            await db.disconnect().catch((err: unknown) => {
                logger.warn({ err: errMessage(err) }, 'prisma disconnect failed — continuing');
            });
            logger.info('database disconnected');
            await Promise.race([redis.quit(), sleep(2_000)]);
            logger.info('redis connection closed — exiting / çıkılıyor');
            await sleep(150); // let pino flush before exit
            process.exit(0);
        })().catch((err: unknown) => {
            logger.error({ err: errMessage(err) }, 'shutdown sequence failed — exit(1)');
            process.exit(1);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info(
        { queue: CRAWL_QUEUE, concurrency: env.crawlConcurrency, artifactsDir: env.artifactsDir },
        'worker ready — waiting for crawl jobs / tarama işleri bekleniyor',
    );
}

main().catch((err: unknown) => {
    // Boot failures (env validation, connection errors) — no logger yet.
    console.error(`worker boot failed / worker başlatılamadı: ${errMessage(err)}`);
    process.exit(1);
});
