/**
 * API environment loading + validation (fail fast, clear messages).
 *
 * `parseEnv` is pure (takes an explicit source object) so tests can build a
 * hermetic environment without touching process.env or .env files.
 * `loadEnvFromProcess` adds dotenv wiring for the real bootstrap: the root
 * monorepo .env is loaded first, then a cwd-local .env as fallback; variables
 * already present in process.env always win (dotenv never overrides).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { loadMasterKey } from '@sahibindenbot/shared';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
    /** postgresql:// URL — Prisma datasource. */
    DATABASE_URL: z.string().url(),
    /** redis:// URL — BullMQ transport + run-control keys. */
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    /** 32-byte base64 master key (AES-256-GCM) — validated via loadMasterKey below. */
    APP_SECRET_KEY: z.string().min(1),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** Public URL of the web app — used as the primary CORS origin. */
    APP_URL: z.string().url().default('http://localhost:3000'),
    /** Optional comma-separated extra CORS origins. */
    CORS_ORIGINS: z.string().optional(),
});

export interface ApiEnv {
    DATABASE_URL: string;
    REDIS_URL: string;
    /** Validated (base64, 32-byte) master key, trimmed. */
    APP_SECRET_KEY: string;
    API_PORT: number;
    API_HOST: string;
    LOG_LEVEL: (typeof LOG_LEVELS)[number];
    APP_URL: string;
    /** Resolved CORS allow-list: APP_URL + localhost dev origins + CORS_ORIGINS extras. */
    corsOrigins: string[];
}

function buildCorsOrigins(env: z.infer<typeof envSchema>): string[] {
    const origins = new Set<string>();
    origins.add(env.APP_URL);
    // Local dev frontends (web app / vite-style tooling on loopback).
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000']) origins.add(url);
    if (env.CORS_ORIGINS !== undefined) {
        for (const entry of env.CORS_ORIGINS.split(',')) {
            const trimmed = entry.trim();
            if (trimmed !== '') origins.add(trimmed);
        }
    }
    return [...origins];
}

/**
 * Validates the given environment source. Throws an Error with a clear,
 * itemized message when invalid; fails fast on a missing/malformed
 * APP_SECRET_KEY via shared's loadMasterKey.
 */
export function parseEnv(source: Record<string, string | undefined>): ApiEnv {
    const result = envSchema.safeParse(source);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
        throw new Error(`Invalid API environment:\n${issues}`);
    }
    const env = result.data;
    // Fail fast: validates base64 alphabet + exact 32-byte length. Never logged.
    const masterKey = loadMasterKey({ APP_SECRET_KEY: env.APP_SECRET_KEY });
    return {
        DATABASE_URL: env.DATABASE_URL,
        REDIS_URL: env.REDIS_URL,
        APP_SECRET_KEY: masterKey,
        API_PORT: env.API_PORT,
        API_HOST: env.API_HOST,
        LOG_LEVEL: env.LOG_LEVEL,
        APP_URL: env.APP_URL,
        corsOrigins: buildCorsOrigins(env),
    };
}

/**
 * Process bootstrap variant: loads the monorepo root .env (three levels up
 * from this file: apps/api/src -> repo root) plus a cwd .env fallback, then
 * validates process.env. Existing process.env values always win.
 */
export function loadEnvFromProcess(): ApiEnv {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rootEnv = path.resolve(here, '..', '..', '..', '.env');
    dotenv.config({ path: [rootEnv, path.resolve(process.cwd(), '.env')] });
    return parseEnv(process.env);
}
