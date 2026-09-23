/**
 * GET /health — liveness + dependency readiness in one shape:
 *   { status: 'ok' | 'degraded', db, redis, worker }
 * Real pings: Postgres `SELECT 1`, Redis `PING`, worker heartbeat key.
 * 200 when db+redis are up (panel usable); worker may still be down.
 */
import type { FastifyPluginAsync } from 'fastify';
import { RedisKeys } from '@sahibindenbot/shared';
import { routeDoc } from '../docs.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
    app.get('/health', {
        schema: routeDoc({
            tags: ['system'],
            summary: 'Liveness + dependency readiness',
            description:
                'Real pings: Postgres `SELECT 1`, Redis `PING`, worker heartbeat. 200 when db and redis ' +
                'are up, 503 with `{ status: "degraded", db, redis, worker }` otherwise. Worker down ' +
                'alone does not degrade the API — the panel can still open.',
        }),
    }, async (_request, reply) => {
        const [db, redis] = await Promise.all([
            app.db.prisma
                .$queryRaw`SELECT 1`
                .then(() => 'up' as const)
                .catch(() => 'down' as const),
            app.redis
                .ping()
                .then((pong) => (pong === 'PONG' ? ('up' as const) : ('down' as const)))
                .catch(() => 'down' as const),
        ]);
        const workerBeat =
            redis === 'up'
                ? await app.redis.get(RedisKeys.workerHeartbeat).catch(() => null)
                : null;
        const worker = workerBeat !== null && workerBeat !== '' ? ('up' as const) : ('down' as const);
        const ok = db === 'up' && redis === 'up';
        return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', db, redis, worker });
    });
};
