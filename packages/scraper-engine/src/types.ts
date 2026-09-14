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
}

/**
 * Anti-bot interstitial classification. Detection only — the engine NEVER
 * solves challenges programmatically (ADR-0002); it either waits for a human
 * in a visible browser or fails the request with a typed error.
 */
export type ChallengeKind = 'cloudflare' | 'perimeterx' | 'login-wall' | 'unknown-block';
