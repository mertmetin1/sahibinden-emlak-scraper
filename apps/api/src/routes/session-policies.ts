/**
 * Session policy routes — full CRUD. No secret material on this model.
 */
import type { FastifyPluginAsync } from 'fastify';
import { notFound, parseWith } from '../errors.js';
import { idParamSchema, sessionPolicyCreateSchema, sessionPolicyUpdateSchema } from '../schemas.js';

export const sessionPolicyRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/session-policies — list with assigned-scan counts.
    app.get('/api/session-policies', async () => {
        const rows = await app.sessionPolicies.list();
        return { rows, total: rows.length };
    });

    // POST /api/session-policies
    app.post('/api/session-policies', async (request, reply) => {
        const body = parseWith(sessionPolicyCreateSchema, request.body);
        const policy = await app.sessionPolicies.create(body);
        return reply.code(201).send(policy);
    });

    // GET /api/session-policies/:id
    app.get('/api/session-policies/:id', async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const policy = await app.sessionPolicies.getById(id);
        if (policy === null) throw notFound(`session policy ${id} not found`);
        return policy;
    });

    // PATCH /api/session-policies/:id
    app.patch('/api/session-policies/:id', async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const body = parseWith(sessionPolicyUpdateSchema, request.body);
        return app.sessionPolicies.update(id, body);
    });

    // DELETE /api/session-policies/:id — referencing scans are SetNull-detached.
    app.delete('/api/session-policies/:id', async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        await app.sessionPolicies.delete(id);
        return reply.code(204).send();
    });
};
