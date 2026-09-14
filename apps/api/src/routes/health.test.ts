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
        expect(res.json()).toEqual({ status: 'ok', db: 'up', redis: 'up' });
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
