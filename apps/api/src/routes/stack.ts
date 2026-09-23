/**
 * Desktop-stack control: LAN URLs, worker heartbeat mirror, cooperative stop.
 * Stop writes storage/desktop-stack.stop; the desktop supervisor watches that
 * file and tears down API / worker / web. Harmless if no supervisor is running.
 */
import type { FastifyPluginAsync } from 'fastify';
import { RedisKeys } from '@sahibindenbot/shared';
import { routeDoc } from '../docs.js';
import { desktopStackEnabled, lanWebUrls, requestDesktopStop } from '../desktop-paths.js';

const WEB_PORT = 3000;

export const stackRoutes: FastifyPluginAsync = async (app) => {
    app.get(
        '/api/stack',
        {
            schema: routeDoc({
                tags: ['system'],
                summary: 'Desktop stack status (worker + LAN URLs)',
            }),
        },
        async () => {
            const beat = await app.redis.get(RedisKeys.workerHeartbeat).catch(() => null);
            return {
                worker: beat !== null && beat !== '' ? 'up' : 'down',
                workerHeartbeat: beat,
                desktopStack: desktopStackEnabled(),
                lanUrls: lanWebUrls(WEB_PORT),
                apiPort: Number.parseInt(process.env.API_PORT ?? '3001', 10) || 3001,
            };
        },
    );

    app.post(
        '/api/stack/stop',
        {
            schema: routeDoc({
                tags: ['system'],
                summary: 'Stop the desktop-launched stack',
                description:
                    'Writes the stop file watched by scripts/desktop/start.ps1. Closes API, worker and web when the panel was started from the desktop shortcut.',
            }),
        },
        async () => {
            const file = await requestDesktopStop();
            app.log.info({ file, desktopStack: desktopStackEnabled() }, 'desktop stack stop requested');
            return { ok: true, desktopStack: desktopStackEnabled(), file: pathBasename(file) };
        },
    );
};

function pathBasename(file: string): string {
    const parts = file.replaceAll('\\', '/').split('/');
    return parts[parts.length - 1] ?? file;
}
