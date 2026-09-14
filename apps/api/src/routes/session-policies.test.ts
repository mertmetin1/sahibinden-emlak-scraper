/**
 * Session policy route tests — full CRUD happy path + validation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, uniqueName, type TestAppContext } from '../testing/test-app.js';

describe('session policy routes', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
        ctx = await buildTestContext('session-policies');
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    it('creates, reads, updates, lists, deletes', async () => {
        const create = await ctx.app.inject({
            method: 'POST',
            url: '/api/session-policies',
            payload: { name: uniqueName('policy'), poolSize: 5, maxUsageCount: 25, proxyAffinity: false },
        });
        expect(create.statusCode).toBe(201);
        const id = create.json().id as string;
        ctx.track.sessionPolicyIds.push(id);
        expect(create.json().poolSize).toBe(5);
        expect(create.json().proxyAffinity).toBe(false);
        // defaults applied by the schema
        expect(create.json().maxAgeMinutes).toBe(60);
        expect(create.json().retireOnNetworkFailures).toBe(true);

        const detail = await ctx.app.inject({ method: 'GET', url: `/api/session-policies/${id}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().maxUsageCount).toBe(25);

        const patch = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/session-policies/${id}`,
            payload: { failureThreshold: 5 },
        });
        expect(patch.statusCode).toBe(200);
        expect(patch.json().failureThreshold).toBe(5);
        expect(patch.json().poolSize).toBe(5); // untouched

        const list = await ctx.app.inject({ method: 'GET', url: '/api/session-policies' });
        expect(list.statusCode).toBe(200);
        const row = list.json().rows.find((r: { id: string }) => r.id === id);
        expect(row.assignedScanCount).toBe(0);

        const del = await ctx.app.inject({ method: 'DELETE', url: `/api/session-policies/${id}` });
        expect(del.statusCode).toBe(204);
        const gone = await ctx.app.inject({ method: 'GET', url: `/api/session-policies/${id}` });
        expect(gone.statusCode).toBe(404);
    });

    it('validates bodies and 404s unknown ids', async () => {
        const bad = await ctx.app.inject({
            method: 'POST',
            url: '/api/session-policies',
            payload: { name: '', poolSize: 0 },
        });
        expect(bad.statusCode).toBe(400);
        expect(bad.json().error.code).toBe('VALIDATION_ERROR');

        const missing = await ctx.app.inject({ method: 'GET', url: '/api/session-policies/does-not-exist' });
        expect(missing.statusCode).toBe(404);
        expect(missing.json().error.code).toBe('NOT_FOUND');
    });
});
