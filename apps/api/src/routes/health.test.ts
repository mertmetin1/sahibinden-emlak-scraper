/**
 * /health contract tests — real Postgres + Redis pings via fastify.inject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, type TestAppContext } from '../testing/test-app.js';

describe('GET /health', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
        ctx = await buildTestContext('health');
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    it('reports ok with db and redis up', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { status: string; db: string; redis: string; worker: string };
        expect(body.status).toBe('ok');
        expect(body.db).toBe('up');
        expect(body.redis).toBe('up');
        expect(['up', 'down']).toContain(body.worker);
    });

    it('sets security headers on responses', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: '/health' });
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('unknown routes return the uniform error shape', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: '/api/nope' });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('NOT_FOUND');
    });
});

describe('GET/POST /api/stack', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
        ctx = await buildTestContext('stack');
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    it('returns worker status and LAN urls', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: '/api/stack' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { worker: string; lanUrls: string[]; desktopStack: boolean };
        expect(['up', 'down']).toContain(body.worker);
        expect(body.lanUrls.some((u) => u.includes('127.0.0.1:3000'))).toBe(true);
        expect(body.desktopStack).toBe(false);
    });

    it('writes a stop file without touching the production path', async () => {
        const { mkdtemp, readFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = await mkdtemp(join(tmpdir(), 'stack-stop-'));
        const file = join(dir, 'desktop-stack.stop');
        const previous = process.env.DESKTOP_STOP_FILE;
        process.env.DESKTOP_STOP_FILE = file;
        try {
            const res = await ctx.app.inject({ method: 'POST', url: '/api/stack/stop' });
            expect(res.statusCode).toBe(200);
            expect(res.json().ok).toBe(true);
            const written = await readFile(file, 'utf8');
            expect(written.length).toBeGreaterThan(0);
        } finally {
            if (previous === undefined) delete process.env.DESKTOP_STOP_FILE;
            else process.env.DESKTOP_STOP_FILE = previous;
            await rm(dir, { recursive: true, force: true });
        }
    });
});
