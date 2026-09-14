/**
 * deps-factory — builds the engine's CrawlDeps for one run, resolving the
 * snapshot's profile REFERENCES into live providers:
 *
 * - output:    PrismaOutputRepository over the listing/run repositories.
 *              NOTE: the real constructor is (listingRepo, runRepo, runId) —
 *              the run repo is required because the adapter owns the live
 *              run-counter increments (and exposes getOutcomeCounts() for the
 *              terminal absolute-counter write).
 * - debugStore: FsDebugArtifactStore at `<artifactsDir>/<runId>`.
 * - proxies:   proxyProfileId → listUsableEndpoints + getEndpointCredentials
 *              (THE decryption path — worker-only, ARCHITECTURE.md §10) →
 *              ProfileProxyProvider(endpoints, profile.strategy).
 *              No profile / empty profile → NullProxyProvider (direct).
 * - sessions:  cookieProfileId → getCookiesDecrypted → StaticSessionProvider.
 * - policy:    sessionPolicyId → { poolSize, maxUsageCount,
 *              persistCookiesPerSession } (engine-consumed subset).
 * - events:    DbRedisEventSink (persist-then-publish, ADR-0004).
 * - cancellation: the caller's RedisCancellationToken.
 *
 * Decrypted secrets live only inside the providers — never logged, never in
 * the snapshot, never crossing a process boundary (§10 write-only contract).
 */
import path from 'node:path';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { toRuntimeLogger } from '@sahibindenbot/shared';
import type { ProxyProvider, SessionProvider } from '@sahibindenbot/shared';
import type {
    DatabaseClient,
    PrismaCookieProfileRepository,
    PrismaProxyProfileRepository,
    PrismaSessionPolicyRepository,
} from '@sahibindenbot/database';
import { PrismaOutputRepository } from '@sahibindenbot/database';
import type { CrawlDeps, SessionPolicyConfig } from '@sahibindenbot/scraper-engine';
import {
    FsDebugArtifactStore,
    NullProxyProvider,
    ProfileProxyProvider,
    StaticSessionProvider,
} from '@sahibindenbot/scraper-engine';
import type { ProxyEndpointInput } from '@sahibindenbot/scraper-engine';
import type { RedisCancellationToken } from './cancellation.js';
import { DbRedisEventSink } from './event-sink.js';
import type { KeyBuilders } from './keys.js';
import type { WorkerSnapshot } from './snapshot.js';

export interface BuildCrawlDepsOptions {
    db: DatabaseClient;
    redis: Redis;
    proxyProfiles: PrismaProxyProfileRepository;
    cookieProfiles: PrismaCookieProfileRepository;
    sessionPolicies: PrismaSessionPolicyRepository;
    runId: string;
    scanDefinitionId: string;
    snapshot: WorkerSnapshot;
    /** Pino logger; a { runId, scanDefinitionId } child is created here. */
    logger: Logger;
    artifactsDir: string;
    cancellation: RedisCancellationToken;
    keyBuilders?: KeyBuilders;
}

export interface BuiltCrawlDeps {
    crawlDeps: CrawlDeps;
    /** Kept for the terminal counter mapping (getOutcomeCounts/getErrors). */
    output: PrismaOutputRepository;
    /** Kept so the worker can flush() before writing the terminal state. */
    eventSink: DbRedisEventSink;
}

export async function buildCrawlDeps(options: BuildCrawlDepsOptions): Promise<BuiltCrawlDeps> {
    const { runId, scanDefinitionId } = options;
    const log = options.logger.child({ runId, scanDefinitionId });
    const runtimeLogger = toRuntimeLogger(log);

    const output = new PrismaOutputRepository(options.db.repos.listings, options.db.repos.runs, runId);
    const debugStore = new FsDebugArtifactStore(path.join(options.artifactsDir, runId));
    const proxyProvider = await resolveProxyProvider(options, runtimeLogger);
    const sessionProvider = await resolveSessionProvider(options, runtimeLogger);
    const sessionPolicy = await resolveSessionPolicy(options, runtimeLogger);
    const eventSink = new DbRedisEventSink({
        runs: options.db.repos.runs,
        redis: options.redis,
        runId,
        scanDefinitionId,
        logger: runtimeLogger,
        ...(options.keyBuilders !== undefined ? { channelBuilder: options.keyBuilders.runEventsChannel } : {}),
    });

    const crawlDeps: CrawlDeps = {
        output,
        debugStore,
        proxyProvider,
        sessionProvider,
        logger: runtimeLogger,
        events: eventSink,
        cancellation: options.cancellation,
        ...(sessionPolicy !== undefined ? { sessionPolicy } : {}),
    };
    return { crawlDeps, output, eventSink };
}

async function resolveProxyProvider(
    options: BuildCrawlDepsOptions,
    logger: ReturnType<typeof toRuntimeLogger>,
): Promise<ProxyProvider> {
    const profileId = options.snapshot.proxyProfileId;
    if (profileId === undefined || profileId === null) return new NullProxyProvider(logger);

    if (options.snapshot.browserMode === 'cdp') {
        // ARCHITECTURE.md §3.4: an attached real Chrome uses the user's own
        // network stack — the proxy profile is ignored in CDP mode.
        logger.warn('proxyProfileId is set but browserMode is CDP — proxy ignored (real Chrome network stack)', {
            proxyProfileId: profileId,
        });
    }

    const profile = await options.proxyProfiles.getProfile(profileId);
    if (profile === null) {
        logger.warn('proxy profile not found — crawling direct', { proxyProfileId: profileId });
        return new NullProxyProvider(logger);
    }
    if (!profile.enabled) {
        logger.warn('proxy profile is disabled — crawling direct', { proxyProfileId: profileId });
        return new NullProxyProvider(logger);
    }

    const usable = await options.proxyProfiles.listUsableEndpoints(profileId);
    if (usable.length === 0) {
        logger.warn('proxy profile has no usable endpoints (all disabled/quarantined) — crawling direct', {
            proxyProfileId: profileId,
        });
        return new NullProxyProvider(logger);
    }

    // getEndpointCredentials is the ONLY decryption path (worker-only, §10).
    const endpoints: ProxyEndpointInput[] = [];
    for (const endpoint of usable) {
        const credentials = await options.proxyProfiles.getEndpointCredentials(endpoint.id);
        endpoints.push({
            host: endpoint.host,
            port: endpoint.port,
            protocol: endpoint.protocol,
            username: credentials.username,
            password: credentials.password,
            weight: endpoint.weight,
        });
    }
    return new ProfileProxyProvider(endpoints, profile.strategy, logger);
}

async function resolveSessionProvider(
    options: BuildCrawlDepsOptions,
    logger: ReturnType<typeof toRuntimeLogger>,
): Promise<SessionProvider> {
    const profileId = options.snapshot.cookieProfileId;
    if (profileId === undefined || profileId === null) return new StaticSessionProvider([]);
    // THE cookie decryption path (worker-only, §10). Cookie values are never
    // logged — the engine logs names only.
    const cookies = await options.cookieProfiles.getCookiesDecrypted(profileId);
    logger.info('cookie profile resolved', { cookieProfileId: profileId, cookieCount: cookies.length });
    return new StaticSessionProvider(cookies);
}

async function resolveSessionPolicy(
    options: BuildCrawlDepsOptions,
    logger: ReturnType<typeof toRuntimeLogger>,
): Promise<SessionPolicyConfig | undefined> {
    const policyId = options.snapshot.sessionPolicyId;
    if (policyId === undefined || policyId === null) return undefined;
    const policy = await options.sessionPolicies.getById(policyId);
    if (policy === null) {
        logger.warn('session policy not found — engine defaults apply', { sessionPolicyId: policyId });
        return undefined;
    }
    return {
        poolSize: policy.poolSize,
        maxUsageCount: policy.maxUsageCount,
        persistCookiesPerSession: policy.persistCookiesPerSession,
    };
}
