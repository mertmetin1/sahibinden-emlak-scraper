/**
 * OpenAPI surface tests — the generated 3.1 spec and the swagger-ui docs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, type TestAppContext } from '../testing/test-app.js';

describe('openapi', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
        ctx = await buildTestContext('openapi');
    });

    afterAll(async () => {
        await ctx.cleanup();
        await ctx.app.close();
    });

    it('GET /api/openapi.json returns a valid OpenAPI 3.1 document with all route domains', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: '/api/openapi.json' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('application/json');

        const spec = res.json();
        expect(spec.openapi).toMatch(/^3\.1\./);
        expect(spec.info.title).toBe('SahibindenBot API');

        // Required paths across the route domains.
        for (const path of [
            '/api/listings',
            '/api/listings/facets',
            '/api/scans',
            '/api/dashboard',
            '/api/listings/{id}',
            '/api/listings/{id}/price-history',
            '/api/listings/export.csv',
            '/api/listings/bulk-delete',
            '/api/runs',
            '/api/runs/{id}',
            '/api/runs/{id}/events',
            '/api/runs/{id}/events/stream',
            '/api/settings',
            '/api/proxy-profiles',
            '/api/cookie-profiles',
            '/api/session-policies',
            '/health',
            '/api/stack',
            '/api/stack/stop',
        ]) {
            expect(spec.paths, `missing path ${path}`).toHaveProperty(path);
        }

        // Tags + summaries are attached (spot checks across domains).
        expect(spec.paths['/api/listings'].get.tags).toContain('listings');
        expect(spec.paths['/api/listings'].get.summary).toBeTruthy();
        expect(spec.paths['/api/scans'].post.tags).toContain('scans');
        expect(spec.paths['/api/runs/{id}/events/stream'].get.tags).toContain('runs');
        expect(spec.paths['/api/dashboard'].get.tags).toContain('dashboard');
        expect(spec.paths['/api/settings'].patch.tags).toContain('settings');
        expect(spec.paths['/health'].get.tags).toContain('system');

        // The listings query schema made it through the Zod → JSON Schema conversion.
        const listingParams = spec.paths['/api/listings'].get.parameters ?? [];
        const paramNames = listingParams.map((p: { name: string }) => p.name);
        for (const name of ['page', 'pageSize', 'sort', 'order', 'search', 'province', 'sellerType', 'priceMin', 'priceMax', 'priceChanged', 'status', 'propertyCategory', 'propertySubtype', 'rooms', 'heating']) {
            expect(paramNames).toContain(name);
        }
        const sortParam = listingParams.find((p: { name: string }) => p.name === 'sort');
        expect(sortParam.schema.enum).toEqual(['price', 'firstSeenAt', 'lastSeenAt', 'title', 'area']);

        // The spec route itself is hidden from the document.
        expect(spec.paths).not.toHaveProperty('/api/openapi.json');
    });

    it('GET /api/docs serves the swagger-ui HTML', async () => {
        const res = await ctx.app.inject({ method: 'GET', url: '/api/docs/' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.body.toLowerCase()).toContain('swagger');
    });
});
