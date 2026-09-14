/**
 * Run routes — list/detail plus cancel & retry control (frozen contract).
 *
 * - GET  /api/runs            filters scanId/status, paginated
 * - GET  /api/runs/:id        full run: snapshot, counters, errorSummary,
 *                             events (RunRepository.getRunWithEvents;
 *                             ?afterEventId= replays the event journal)
 * - POST /api/runs/:id/cancel QUEUED → job removed + CANCELLED;
 *                             STARTING/RUNNING → cancel key + CANCELLING
 * - POST /api/runs/:id/retry  FAILED/PARTIAL/CANCELLED → new RETRY run with
 *                             the SAME configurationSnapshot
 */
import type { FastifyPluginAsync } from 'fastify';
import { notFound, parseWith } from '../errors.js';
import { idParamSchema, runDetailQuerySchema, runListQuerySchema } from '../schemas.js';

export const runRoutes: FastifyPluginAsync = async (app) => {
    app.get('/api/runs', async (request) => {
        const query = parseWith(runListQuerySchema, request.query);
        const { rows, total } = await app.db.repos.runs.listRuns(query.scanId, query.status, query.page, query.pageSize);
        return { rows, total, page: query.page, pageSize: query.pageSize };
    });

    app.get('/api/runs/:id', async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const query = parseWith(runDetailQuerySchema, request.query);
        const found = await app.db.repos.runs.getRunWithEvents(id, query.afterEventId);
        if (found === null) throw notFound(`run ${id} not found`);
        return { ...found.run, events: found.events };
    });

    app.post('/api/runs/:id/cancel', async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        return app.runControl.cancelRun(id);
    });

    app.post('/api/runs/:id/retry', async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        const run = await app.runControl.retryRun(id);
        return reply.code(201).send(run);
    });
};
