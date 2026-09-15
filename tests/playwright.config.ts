/**
 * Playwright config for the Phase 6 admin-panel UI suite (AGENT 8).
 *
 * Two web servers are managed (or reused when already running):
 *   1. api  — Fastify on :3001 (`pnpm --filter @sahibindenbot/api start`),
 *      env wired from the monorepo root .env (DATABASE_URL / REDIS_URL /
 *      APP_SECRET_KEY). The API's own bootstrap also reads that file;
 *      explicit env here keeps the config self-contained.
 *   2. web  — Next.js dev server on :3000 (`pnpm --filter @sahibindenbot/web dev`).
 *
 * Tests run against the seeded dev database (20 İstanbul listings + the
 * 'Adana Seyhan Satılık (demo)' scan with its synthetic SUCCEEDED run).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Dependency-free .env reader — just enough for KEY="value" lines. */
function loadRootEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    let text: string;
    try {
        text = readFileSync(path.join(ROOT, '.env'), 'utf8');
    } catch {
        return out;
    }
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        if (!/^[A-Z0-9_]+$/.test(key)) continue;
        let value = trimmed.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

const env = loadRootEnv();

export default defineConfig({
    testDir: path.join(HERE, 'e2e-ui'),
    // Keep all artifacts (traces on failure, .last-run) inside the owned dir.
    outputDir: path.join(HERE, 'e2e-ui', '.results'),
    timeout: 60_000,
    expect: { timeout: 15_000 },
    workers: 2,
    fullyParallel: true,
    retries: 0,
    reporter: [['list']],
    globalSetup: path.join(HERE, 'e2e-ui', 'global-setup.ts'),
    use: {
        baseURL: 'http://localhost:3000',
        navigationTimeout: 45_000,
        actionTimeout: 15_000,
        trace: 'retain-on-failure',
    },
    webServer: [
        {
            command: 'pnpm --filter @sahibindenbot/api start',
            url: 'http://localhost:3001/health',
            reuseExistingServer: true,
            timeout: 120_000,
            env: {
                DATABASE_URL: env.DATABASE_URL ?? '',
                REDIS_URL: env.REDIS_URL ?? 'redis://localhost:6379',
                APP_SECRET_KEY: env.APP_SECRET_KEY ?? '',
                API_PORT: '3001',
            },
        },
        {
            command: 'pnpm --filter @sahibindenbot/web dev',
            url: 'http://localhost:3000',
            reuseExistingServer: true,
            timeout: 120_000,
        },
    ],
});
