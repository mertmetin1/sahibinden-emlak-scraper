/**
 * prismaPlugin — wires the persistence layer onto the Fastify instance.
 *
 * Decorates:
 * - `db`             DatabaseClient (createDatabaseClient) — repos + raw prisma
 * - `proxyProfiles`  PrismaProxyProfileRepository (needs the master key to
 *                    encrypt endpoint credentials on write)
 * - `cookieProfiles` PrismaCookieProfileRepository (encrypts cookie JSON on write)
 * - `sessionPolicies` PrismaSessionPolicyRepository
 *
 * The profile repositories are NOT part of DatabaseClient.repos (which wires
 * only listings/runs/scans) — they are constructed here from the exported
 * classes. The decryption paths on those repositories
 * (getEndpointCredentials / getCookiesDecrypted) are worker-only and are
 * NEVER called from this process.
 *
 * Closes on shutdown via an onClose hook (prisma.$disconnect()).
 */
import fp from 'fastify-plugin';
import {
    createDatabaseClient,
    PrismaCookieProfileRepository,
    PrismaProxyProfileRepository,
    PrismaSessionPolicyRepository,
    type DatabaseClient,
} from '@sahibindenbot/database';

export interface PrismaPluginOptions {
    databaseUrl: string;
    /** Validated base64 32-byte master key (see shared/security loadMasterKey). */
    masterKey: string;
}

declare module 'fastify' {
    interface FastifyInstance {
        db: DatabaseClient;
        proxyProfiles: PrismaProxyProfileRepository;
        cookieProfiles: PrismaCookieProfileRepository;
        sessionPolicies: PrismaSessionPolicyRepository;
    }
}

export const prismaPlugin = fp<PrismaPluginOptions>(async (app, opts) => {
    const db = createDatabaseClient(opts.databaseUrl);
    app.decorate('db', db);
    app.decorate('proxyProfiles', new PrismaProxyProfileRepository(db.prisma, opts.masterKey));
    app.decorate('cookieProfiles', new PrismaCookieProfileRepository(db.prisma, opts.masterKey));
    app.decorate('sessionPolicies', new PrismaSessionPolicyRepository(db.prisma));
    app.addHook('onClose', async () => {
        await db.disconnect();
    });
});
