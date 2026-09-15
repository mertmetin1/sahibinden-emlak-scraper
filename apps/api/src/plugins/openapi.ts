/**
 * OpenAPI plugin — @fastify/swagger (spec generation from route `schema`
 * slots) + @fastify/swagger-ui (interactive docs).
 *
 * Surfaces:
 * - GET /api/openapi.json  the OpenAPI 3.1 document (hidden from itself)
 * - /api/docs              swagger-ui (static assets + spec fetch)
 *
 * MUST be registered before the route plugins: swagger collects routes via
 * an onRoute hook, which only sees routes registered after it.
 */
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { API_TAGS } from '../docs.js';

export const openApiPlugin = fp(async (app) => {
    await app.register(swagger, {
        openapi: {
            openapi: '3.1.0',
            info: {
                title: 'SahibindenBot API',
                version: '0.1.0',
                description:
                    'Local-first sahibinden.com crawling & intelligence API. ' +
                    'Uniform error shape: `{ "error": { "code", "message", "details?" } }`. ' +
                    'Secrets (proxy credentials, cookie material) are write-only and never returned.',
            },
            tags: [...API_TAGS],
        },
    });

    await app.register(swaggerUi, {
        routePrefix: '/api/docs',
        uiConfig: { docExpansion: 'list', deepLinking: true },
    });

    // Stable spec URL for clients/codegen (swagger-ui serves its own copy
    // under /api/docs/json; this one is the public contract path).
    app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
});
