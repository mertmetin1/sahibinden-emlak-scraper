/**
 * Engine-local types. The shared package is frozen for this phase, so
 * `CrawlDeps` (the dependency bundle consumed by `runCrawl`) lives here.
 */
import type {
    CancellationToken,
    DebugArtifactStore,
    EventSink,
    OutputRepository,
    ProxyProvider,
    RuntimeLogger,
    SessionProvider,
} from '@sahibindenbot/shared';

/**
 * Session-pool policy — the engine-consumed subset of the SessionPolicy DB
 * model (ARCHITECTURE.md §4). When present on CrawlDeps, runCrawl derives
 * `sessionPoolOptions` / `persistCookiesPerSession` from it; when absent,
 * the engine defaults apply (pool 10, maxUsageCount 50, persist true).
 *
 * NOTE: the model's `proxyAffinity`, `retireOnNetworkFailures` and
 * `failureThreshold` fields are consumed by the WORKER layer (proxy health,
 * quarantine, session retirement orchestration) — the engine deliberately
 * ignores them.
 */
export interface SessionPolicyConfig {
    /** Crawlee sessionPoolOptions.maxPoolSize. */
    poolSize: number;
    /** Crawlee sessionOptions.maxUsageCount — session retires after N uses. */
    maxUsageCount: number;
    /** Crawlee persistCookiesPerSession. */
    persistCookiesPerSession: boolean;
}

/** Dependencies injected into `runCrawl` — the local replacements for `Actor.*`. */
export interface CrawlDeps {
    /** Batch sink for parsed listings (replaces `Actor.pushData`). */
    output: OutputRepository;
    /** Debug HTML/screenshot capture (replaces `Actor.setValue`). Never receives cookies. */
    debugStore: DebugArtifactStore;
    /** Proxy configuration source; may yield null = direct connection. */
    proxyProvider: ProxyProvider;
    /** Supplies authorized, user-exported session cookies. */
    sessionProvider: SessionProvider;
    /** Structured logger (pino-backed). The engine never uses console.*. */
    logger: RuntimeLogger;
    /** Structured event sink. Payloads must stay redacted (no cookies/headers). */
    events: EventSink;
    /** Cooperative cancellation; checked between category pages. */
    cancellation?: CancellationToken;
    /** Optional session-pool policy; engine defaults apply when absent. */
    sessionPolicy?: SessionPolicyConfig;
}

/**
 * Anti-bot interstitial classification. Detection only — the engine NEVER
 * solves challenges programmatically (ADR-0002); it either waits for a human
 * in a visible browser or fails the request with a typed error.
 */
export type ChallengeKind = 'cloudflare' | 'perimeterx' | 'login-wall' | 'unusual-access' | 'unknown-block';
