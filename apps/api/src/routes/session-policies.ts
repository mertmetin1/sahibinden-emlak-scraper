/**
 * Session policy routes — full CRUD. No secret material on this model.
 */
import type { FastifyPluginAsync } from 'fastify';
import { routeDoc } from '../docs.js';
import { notFound, parseWith } from '../errors.js';
import { idParamSchema, sessionPolicyCreateSchema, sessionPolicyUpdateSchema } from '../schemas.js';

export const sessionPolicyRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/session-policies — list with assigned-scan counts.
    app.get('/api/session-policies', {
        schema: routeDoc({
            tags: ['sessions'],
            summary: 'List session policies',
            description: 'All policies with assigned-scan counts. No secret material on this model.',
        }),
    }, async () => {
        const rows = await app.sessionPolicies.list();
        return { rows, total: rows.length };
    });

    // POST /api/session-policies
    app.post('/api/session-policies', {
        schema: routeDoc({
            tags: ['sessions'],
            summary: 'Create a session policy',
            description: 'Pool size, usage/age caps, cookie persistence, proxy affinity, network-failure retirement.',
            body: sessionPolicyCreateSchema,
        }),
    }, async (request, reply) => {
        const body = parseWith(sessionPolicyCreateSchema, request.body);
        const policy = await app.sessionPolicies.create(body);
        return reply.code(201).send(policy);
    });

    // GET /api/session-policies/:id
    app.get('/api/session-policies/:id', {
        schema: routeDoc({
            tags: ['sessions'],
            summary: 'Session policy detail',
            params: idParamSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const policy = await app.sessionPolicies.getById(id);
        if (policy === null) throw notFound(`session policy ${id} not found`);
        return policy;
    });

    // PATCH /api/session-policies/:id
    app.patch('/api/session-policies/:id', {
        schema: routeDoc({
            tags: ['sessions'],
            summary: 'Update a session policy',
            params: idParamSchema,
            body: sessionPolicyUpdateSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const body = parseWith(sessionPolicyUpdateSchema, request.body);
        return app.sessionPolicies.update(id, body);
    });

    // DELETE /api/session-policies/:id — referencing scans are SetNull-detached.
    app.delete('/api/session-policies/:id', {
        schema: routeDoc({
            tags: ['sessions'],
            summary: 'Delete a session policy',
            description: 'Scans referencing the policy are detached (SetNull).',
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        await app.sessionPolicies.delete(id);
        return reply.code(204).send();
    });
};
