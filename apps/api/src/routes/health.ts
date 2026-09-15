/**
 * GET /health — liveness + dependency readiness in one shape:
 *   { status: 'ok' | 'degraded', db: 'up'|'down', redis: 'up'|'down' }
 * Real pings: Postgres `SELECT 1`, Redis `PING`. 200 when both up, else 503.
 */
import type { FastifyPluginAsync } from 'fastify';
import { routeDoc } from '../docs.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
    app.get('/health', {
        schema: routeDoc({
            tags: ['system'],
            summary: 'Liveness + dependency readiness',
            description:
                'Real pings: Postgres `SELECT 1`, Redis `PING`. 200 when both are up, 503 with ' +
                '`{ status: "degraded", db, redis }` otherwise.',
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
        const ok = db === 'up' && redis === 'up';
        return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', db, redis });
    });
};
