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
import { routeDoc } from '../docs.js';
import { notFound, parseWith } from '../errors.js';
import { idParamSchema, runDetailQuerySchema, runListQuerySchema } from '../schemas.js';

export const runRoutes: FastifyPluginAsync = async (app) => {
    app.get('/api/runs', {
        schema: routeDoc({
            tags: ['runs'],
            summary: 'List runs',
            description: 'Newest first; filter by scanId and/or status; paginated.',
            querystring: runListQuerySchema,
        }),
    }, async (request) => {
        const query = parseWith(runListQuerySchema, request.query);
        const { rows, total } = await app.db.repos.runs.listRuns(query.scanId, query.status, query.page, query.pageSize);
        return { rows, total, page: query.page, pageSize: query.pageSize };
    });

    app.get('/api/runs/:id', {
        schema: routeDoc({
            tags: ['runs'],
            summary: 'Run detail with event journal',
            description:
                'Full run: configurationSnapshot, counters, errorSummary, plus persisted events. ' +
                '?afterEventId= (decimal string) replays only events after that cursor.',
            params: idParamSchema,
            querystring: runDetailQuerySchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const query = parseWith(runDetailQuerySchema, request.query);
        const found = await app.db.repos.runs.getRunWithEvents(id, query.afterEventId);
        if (found === null) throw notFound(`run ${id} not found`);
        return { ...found.run, events: found.events };
    });

    app.post('/api/runs/:id/cancel', {
        schema: routeDoc({
            tags: ['runs'],
            summary: 'Cancel a run',
            description:
                'QUEUED → BullMQ job removed + CANCELLED; STARTING/RUNNING → cooperative cancel key + ' +
                'CANCELLING (the worker drains to CANCELLED); CANCELLING is idempotent; terminal states ' +
                '→ 409 RUN_NOT_CANCELLABLE.',
            params: idParamSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        return app.runControl.cancelRun(id);
    });

    app.post('/api/runs/:id/retry', {
        schema: routeDoc({
            tags: ['runs'],
            summary: 'Retry a run with the same snapshot',
            description:
                'Only FAILED/PARTIAL/CANCELLED → new RETRY run with the SAME configurationSnapshot ' +
                '(409 RUN_NOT_RETRYABLE otherwise).',
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        const run = await app.runControl.retryRun(id);
        return reply.code(201).send(run);
    });
};
