/**
 * buildApp — Fastify instance factory. Used by the real bootstrap
 * (src/index.ts) and by tests (fastify.inject, no port binding).
 *
 * Wiring order: error/404 handlers → CORS → security headers → prisma plugin
 * (db + profile repositories) → run-control plugin (redis + BullMQ producer)
 * → routes. onClose hooks give the graceful-shutdown sequence:
 * fastify.close() → queue.close() → redis.quit() → prisma.$disconnect().
 */
import fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { CrawlError, redactSecrets } from '@sahibindenbot/shared';
import type { ApiEnv } from './env.js';
import { ApiError, toValidationIssues } from './errors.js';
import { RunControlService, type RunControlKeys } from './queue.js';
import { prismaPlugin } from './plugins/prisma.js';
import { healthRoutes } from './routes/health.js';
import { scanRoutes } from './routes/scans.js';
import { runRoutes } from './routes/runs.js';
import { proxyProfileRoutes } from './routes/proxy-profiles.js';
import { cookieProfileRoutes } from './routes/cookie-profiles.js';
import { sessionPolicyRoutes } from './routes/session-policies.js';

/** Pino redact paths (defense in depth on top of call-site redactSecrets). */
const LOG_REDACT_PATHS = [
    'password',
    'token',
    'cookie',
    'cookies',
    'sessionCookies',
    'setCookie',
    'authorization',
    'proxyAuth',
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["set-cookie"]',
    'res.headers["set-cookie"]',
    '*.password',
    '*.token',
    '*.cookie',
    '*.cookies',
    '*.sessionCookies',
    'data.cookies',
    'data.cookie',
    'data.password',
    'data.token',
];

export interface BuildAppOptions {
    env: ApiEnv;
    /** Test seams — production defaults come from the frozen contract. */
    queueName?: string;
    queuePrefix?: string;
    keys?: RunControlKeys;
}

declare module 'fastify' {
    interface FastifyInstance {
        redis: Redis;
        runControl: RunControlService;
    }
}

interface RunControlPluginOptions {
    redisUrl: string;
    queueName?: string | undefined;
    queuePrefix?: string | undefined;
    keys?: RunControlKeys | undefined;
}

/** Redis + BullMQ producer wiring; runs after prismaPlugin (needs app.db). */
const runControlPlugin = fp<RunControlPluginOptions>(async (app, opts) => {
    // maxRetriesPerRequest: null is required by BullMQ; enableReadyCheck off
    // per BullMQ's ioredis guidance. The instance is shared: health pings,
    // lock/cancel keys, and the Queue producer all use it.
    const redis = new Redis(opts.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
    redis.on('error', (err) => {
        // Never let a connection error crash the process — /health reports it.
        app.log.warn(redactSecrets({ err: { message: err.message } }), 'redis connection error');
    });
    const runControl = new RunControlService({
        db: app.db,
        redis,
        queueName: opts.queueName,
        queuePrefix: opts.queuePrefix,
        keys: opts.keys,
        logger: app.log,
    });
    app.decorate('redis', redis);
    app.decorate('runControl', runControl);
    app.addHook('onClose', async () => {
        await runControl.close(); // BullMQ queue first…
        await redis.quit(); // …then the shared connection
    });
});

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
    const { env } = options;

    const app = fastify({
        logger: {
            level: env.LOG_LEVEL,
            redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
        },
    });

    // -- Uniform error shape: { error: { code, message, details? } } ---------
    app.setErrorHandler((err: FastifyError, request, reply) => {
        if (err instanceof ApiError) {
            return reply.code(err.statusCode).send({
                error: {
                    code: err.code,
                    message: err.message,
                    ...(err.details !== undefined ? { details: err.details } : {}),
                },
            });
        }
        if (err instanceof ZodError) {
            return reply
                .code(400)
                .send({ error: { code: 'VALIDATION_ERROR', message: 'request validation failed', details: { issues: toValidationIssues(err) } } });
        }
        if (err instanceof CrawlError) {
            // Repository failures cross the boundary as CrawlError('DATABASE').
            // Duck-typed Prisma codes on the cause (no @prisma/client import
            // allowed here): P2025 record-not-found → 404, P2002 unique → 409.
            const causeCode = (err.cause as { code?: unknown } | undefined)?.code;
            if (causeCode === 'P2025') {
                return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'resource not found' } });
            }
            if (causeCode === 'P2002') {
                return reply.code(409).send({ error: { code: 'CONFLICT', message: 'a resource with this identity already exists' } });
            }
            request.log.error(redactSecrets({ err: { name: err.name, code: err.code, message: err.message } }), 'persistence failure');
            return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
        }
        // Fastify's own errors (bad JSON, unknown content-type, …) carry a statusCode.
        const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
        if (statusCode >= 500) {
            request.log.error(redactSecrets({ err: { name: err.name, message: err.message } }), 'unhandled error');
            return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
        }
        return reply
            .code(statusCode)
            .send({ error: { code: typeof err.code === 'string' ? err.code : 'BAD_REQUEST', message: err.message } });
    });

    app.setNotFoundHandler((request, reply) => {
        return reply
            .code(404)
            .send({ error: { code: 'NOT_FOUND', message: `route ${request.method} ${request.url} not found` } });
    });

    // -- CORS: localhost/APP_URL origins only --------------------------------
    await app.register(cors, { origin: env.corsOrigins, credentials: false });

    // -- Tolerant body parsing ------------------------------------------------
    // Bodyless trigger endpoints (run/test/cancel/retry/duplicate) must work
    // regardless of client Content-Type habits: empty bodies parse to {}
    // (instead of FST_ERR_CTP_EMPTY_JSON_BODY / INVALID_MEDIA_TYPE), and a
    // catch-all parser accepts JSON sent with a non-JSON content-type.
    // Non-empty non-JSON payloads still fail with 400 VALIDATION_ERROR.
    const tolerantJsonParser = (_req: unknown, body: string | Buffer, done: (err: Error | null, result?: unknown) => void): void => {
        const text = typeof body === 'string' ? body : body.toString('utf8');
        if (text.trim() === '') return done(null, {});
        try {
            done(null, JSON.parse(text));
        } catch {
            done(new ApiError(400, 'VALIDATION_ERROR', 'request body must be valid JSON'));
        }
    };
    app.addContentTypeParser('application/json', { parseAs: 'string' }, tolerantJsonParser);
    app.addContentTypeParser('*', { parseAs: 'string' }, tolerantJsonParser);

    // -- Security headers (onSend so they also cover error responses) --------
    app.addHook('onSend', async (_request, reply, payload) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'no-referrer');
        return payload;
    });

    // -- Persistence + run control -------------------------------------------
    await app.register(prismaPlugin, { databaseUrl: env.DATABASE_URL, masterKey: env.APP_SECRET_KEY });
    await app.register(runControlPlugin, {
        redisUrl: env.REDIS_URL,
        queueName: options.queueName,
        queuePrefix: options.queuePrefix,
        keys: options.keys,
    });

    // -- Routes ---------------------------------------------------------------
    await app.register(healthRoutes);
    await app.register(scanRoutes);
    await app.register(runRoutes);
    await app.register(proxyProfileRoutes);
    await app.register(cookieProfileRoutes);
    await app.register(sessionPolicyRoutes);

    return app;
}
