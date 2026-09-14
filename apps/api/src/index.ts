/**
 * @sahibindenbot/api bootstrap.
 *
 *   pnpm --filter @sahibindenbot/api start     (tsx src/index.ts)
 *
 * Loads the monorepo root .env, validates the environment (fail fast —
 * including APP_SECRET_KEY via shared's loadMasterKey), builds the Fastify
 * app, and listens. Graceful shutdown on SIGTERM/SIGINT: stop accepting
 * requests (fastify.close) → onClose hooks close the BullMQ queue, quit
 * Redis, and disconnect Prisma. A second signal force-exits.
 */
import { redactSecrets } from '@sahibindenbot/shared';
import { buildApp } from './app.js';
import { loadEnvFromProcess } from './env.js';

const SHUTDOWN_FORCE_EXIT_MS = 10_000;

async function main(): Promise<void> {
    const env = loadEnvFromProcess();
    const app = await buildApp({ env });

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
        if (shuttingDown) {
            process.exit(1); // second signal — immediate exit
        }
        shuttingDown = true;
        app.log.info({ signal }, 'shutdown requested — draining');
        // Backstop: never hang past the orchestrator's grace period.
        const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_FORCE_EXIT_MS);
        forceExit.unref();
        app.close()
            .then(() => {
                clearTimeout(forceExit);
                app.log.info('shutdown complete');
            })
            .catch((err: unknown) => {
                clearTimeout(forceExit);
                app.log.error(
                    redactSecrets({ err: err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) } }),
                    'error during shutdown',
                );
                process.exitCode = 1;
            });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await app.listen({ port: env.API_PORT, host: env.API_HOST });
    app.log.info({ port: env.API_PORT, host: env.API_HOST }, 'api listening');
}

main().catch((err: unknown) => {
    // Bootstrap failure (env validation, port bind, …). Redact before printing
    // — env parse errors can echo variable values.
    const safe = redactSecrets({ err: err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) } });
    process.stderr.write(`api bootstrap failed: ${JSON.stringify(safe)}\n`);
    process.exit(1);
});
