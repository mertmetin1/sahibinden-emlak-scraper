/**
 * DbRedisEventSink — the worker's EventSink implementation (ADR-0004):
 * every run event is (1) INSERTed into ScanRunEvent (durability + ordering;
 * the BigInt id doubles as the SSE replay cursor), THEN (2) PUBLISHed to the
 * Redis channel `run-events:{runId}` for live SSE forwarding.
 *
 * Persist-then-publish guarantees no gaps: a client that misses pub/sub
 * messages replays from Postgres via Last-Event-ID.
 *
 * The shared EventSink port is synchronous (`emit(...): void`) — the engine
 * fire-and-forgets inside a try/catch. We therefore serialize work on an
 * internal promise chain (preserving persist→publish order per event AND
 * global event order) and expose `flush()` so the worker can drain before
 * writing the terminal run state.
 *
 * Redaction: the engine pre-redacts payloads; we run shared's redactSecrets
 * again defensively (§9.3). Secrets must never reach ScanRunEvent or pub/sub.
 */
import type { CrawlEvent, EventSink, RuntimeLogger } from '@sahibindenbot/shared';
import { redactSecrets } from '@sahibindenbot/shared';
import type { RunRepository } from '@sahibindenbot/database';
import type { Redis } from 'ioredis';
import { defaultKeyBuilders } from './keys.js';

export interface DbRedisEventSinkOptions {
    runs: RunRepository;
    redis: Redis;
    runId: string;
    scanDefinitionId: string;
    logger?: RuntimeLogger;
    /** Test hook: prefix the channel. Defaults to RedisKeys.runEventsChannel. */
    channelBuilder?: (runId: string) => string;
}

/** Published wire shape — the API's SSE broker forwards this verbatim. */
export interface RunEventMessage {
    /** Decimal string of ScanRunEvent.id — the SSE `id:` / Last-Event-ID cursor. */
    seq: string;
    runId: string;
    scanDefinitionId: string;
    type: string;
    at: string;
    data: Record<string, unknown> | null;
}

export class DbRedisEventSink implements EventSink {
    private tail: Promise<void> = Promise.resolve();
    private dropped = 0;

    constructor(private readonly options: DbRedisEventSinkOptions) {}

    emit(event: CrawlEvent): void {
        this.enqueue(event);
        // PROXY_FAILURE fan-out (task spec): the engine reports transport
        // retries as REQUEST_RETRY { code }; a proxy-classified code ALSO
        // raises PROXY_FAILURE so proxy health problems are visible as their
        // own event type. NOTE: Crawlee's ProxyConfiguration picks endpoints
        // internally, so the failing endpointId is not observable at this
        // layer — the payload carries the request URL + code instead.
        if (event.type === 'REQUEST_RETRY' && event.data?.['code'] === 'PROXY_ERROR') {
            this.enqueue({
                type: 'PROXY_FAILURE',
                at: new Date().toISOString(),
                data: { url: event.data['url'], errorCode: 'PROXY_ERROR' },
            });
        }
    }

    /** Drains the persist/publish chain. Never rejects (errors are logged). */
    async flush(): Promise<void> {
        await this.tail;
    }

    /** Events that failed to persist/publish (each logged when it happened). */
    get droppedCount(): number {
        return this.dropped;
    }

    private enqueue(event: CrawlEvent): void {
        // Defensive deep-redaction (engine payloads are already whitelisted).
        const safe: CrawlEvent = {
            type: event.type,
            at: event.at,
            ...(event.data !== undefined ? { data: redactSecrets(event.data) } : {}),
        };
        this.tail = this.tail
            .then(() => this.persistThenPublish(safe))
            .catch((err: unknown) => {
                // A broken sink must NEVER kill a crawl (engine contract).
                this.dropped += 1;
                this.options.logger?.warn('run event persist/publish failed', {
                    runId: this.options.runId,
                    type: event.type,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
    }

    private async persistThenPublish(event: CrawlEvent): Promise<void> {
        const record = await this.options.runs.addEvent(this.options.runId, event.type, event.data);
        const channel = (this.options.channelBuilder ?? defaultKeyBuilders.runEventsChannel)(this.options.runId);
        const message: RunEventMessage = {
            seq: record.id,
            runId: this.options.runId,
            scanDefinitionId: this.options.scanDefinitionId,
            type: event.type,
            at: event.at,
            data: event.data ?? null,
        };
        await this.options.redis.publish(channel, JSON.stringify(message));
    }
}
