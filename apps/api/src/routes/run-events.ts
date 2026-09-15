/**
 * Run event routes — paginated replay + SSE live stream (ADR-0004).
 *
 * GET /api/runs/:id/events              replay from ScanRunEvent (?afterId=
 *                                       decimal event id → getRunWithEvents
 *                                       afterEventId semantics)
 * GET /api/runs/:id/events/stream       SSE: replay-then-live
 *
 * SSE algorithm (gap-free, duplicate-free):
 *   1. existence + status check (getRunWithEvents)
 *   2. terminal run  → replay rows id > Last-Event-ID, send `event: RUN_END`,
 *      close. No subscription (the worker flushes its sink BEFORE writing the
 *      terminal status, so a terminal run's journal is complete).
 *   3. active run    → SUBSCRIBE first (buffering messages), then re-query
 *      the replay window. Persist-then-publish (ADR-0004) guarantees anything
 *      published between the existence check and subscribe is re-found by the
 *      second query; buffered live messages are deduped by seq > lastSeq.
 *   4. live forward  → frames `id: <seq>\nevent: <type>\ndata: <json>\n\n`;
 *      on a terminal event type (RUN_COMPLETED/RUN_FAILED) a final
 *      `event: RUN_END` (no id — it is not a persisted event and must not
 *      pollute Last-Event-ID cursors) is sent and the stream closes.
 *   5. heartbeat comment `: ping` every 15s; the dedicated subscriber
 *      connection is torn down when the response finishes or the socket closes.
 *
 * Redaction: events are pre-redacted at the worker; payloads pass through
 * shared's redactSecrets again here, defensively (§9.3).
 *
 * REPOSITORY GAPS (reported, not patched):
 * - RunRepository.getRunWithEvents has no `take` limit — a very long run's
 *   replay arrives in one response.
 * - RunEventMessage (the pub/sub wire shape) is defined in apps/worker; it is
 *   duplicated here as a wire contract and belongs in packages/shared next to
 *   RedisKeys.
 */
import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { Redis } from 'ioredis';
import { redactSecrets } from '@sahibindenbot/shared';
import type { RunEventRecord, RunRecord } from '@sahibindenbot/database';
import { routeDoc } from '../docs.js';
import { notFound, parseWith } from '../errors.js';
import { idParamSchema, runEventsQuerySchema } from '../schemas.js';

/** Run statuses after which no further events arrive (frozen contract). */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
/** Terminal event types emitted by the worker/sweeper (ARCHITECTURE §9.1). */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['RUN_COMPLETED', 'RUN_FAILED']);
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Pub/sub wire shape published by the worker's DbRedisEventSink
 * (apps/worker/src/event-sink.ts) — forwarded as the SSE `data:` payload.
 */
interface RunEventMessage {
    /** Decimal string of ScanRunEvent.id — the SSE `id:` / Last-Event-ID cursor. */
    seq: string;
    runId: string;
    scanDefinitionId: string;
    type: string;
    at: string;
    data: unknown;
}

export interface RunEventRoutesOptions {
    redisUrl: string;
    /** Channel builder — production default RedisKeys.runEventsChannel; tests inject a sahtest-prefixed one. */
    runEventsChannel: (runId: string) => string;
}

/** SSE frame. JSON.stringify escapes newlines, so `data:` is always single-line. */
function sseFrame(id: string | null, event: string, data: unknown): string {
    const idLine = id !== null ? `id: ${id}\n` : '';
    return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Uniform payload — replayed DB rows and live pub/sub messages share one frame shape. */
function framePayload(run: RunRecord, event: RunEventRecord): RunEventMessage {
    return {
        seq: event.id,
        runId: run.id,
        scanDefinitionId: run.scanDefinitionId,
        type: event.type,
        at: event.createdAt.toISOString(),
        data: redactSecrets(event.data ?? null),
    };
}

function parseRunEventMessage(raw: string): RunEventMessage | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const msg = parsed as Partial<RunEventMessage>;
        if (typeof msg.seq !== 'string' || typeof msg.type !== 'string' || typeof msg.runId !== 'string') return null;
        return msg as RunEventMessage;
    } catch {
        return null;
    }
}

/**
 * Terminal status carried in a terminal event's payload (worker always sets
 * it; §9.1). Returns null for non-terminal event types. Type-based fallback —
 * a DB re-read would race the worker's terminal write (the sink flushes
 * BEFORE the status update), so the event is the truth.
 */
function terminalStatusFromPayload(type: string, data: unknown): string | null {
    if (!TERMINAL_EVENT_TYPES.has(type)) return null;
    const status = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).status : undefined;
    if (typeof status === 'string' && TERMINAL_RUN_STATUSES.has(status)) return status;
    return type === 'RUN_FAILED' ? 'FAILED' : 'SUCCEEDED';
}

export const runEventRoutes: FastifyPluginAsync<RunEventRoutesOptions> = async (app, opts) => {
    // GET /api/runs/:id/events — paginated replay (non-live fallback, ADR-0004).
    app.get(
        '/api/runs/:id/events',
        {
            schema: routeDoc({
                tags: ['runs'],
                summary: 'Replay persisted run events',
                description:
                    'Returns ScanRunEvent rows with id > afterId (decimal string cursor), ascending. ' +
                    'lastEventId is the cursor for the next call (echoes afterId when no new events).',
                params: idParamSchema,
                querystring: runEventsQuerySchema,
            }),
        },
        async (request) => {
            const { id } = parseWith(idParamSchema, request.params);
            const query = parseWith(runEventsQuerySchema, request.query);
            const found = await app.db.repos.runs.getRunWithEvents(id, query.afterId);
            if (found === null) throw notFound(`run ${id} not found`);
            const events = found.events.map((event) => ({
                id: event.id,
                runId: event.runId,
                type: event.type,
                data: redactSecrets(event.data ?? null),
                createdAt: event.createdAt,
            }));
            return { events, lastEventId: events.at(-1)?.id ?? query.afterId ?? null };
        },
    );

    // GET /api/runs/:id/events/stream — SSE replay-then-live (ADR-0004).
    app.get(
        '/api/runs/:id/events/stream',
        {
            schema: routeDoc({
                tags: ['runs'],
                summary: 'Live run event stream (SSE)',
                description:
                    'Server-Sent Events: replays persisted events with id > Last-Event-ID, then forwards ' +
                    'live Redis pub/sub frames (`run-events:{runId}`). Heartbeat comment `: ping` every ' +
                    '15s. A final `event: RUN_END` (carrying the terminal status) closes the stream once ' +
                    'the run reaches SUCCEEDED/PARTIAL/FAILED/CANCELLED.',
                params: idParamSchema,
            }),
        },
        async (request, reply) => {
            const { id } = parseWith(idParamSchema, request.params);
            const lastEventIdHeader = request.headers['last-event-id'];
            const lastEventId =
                typeof lastEventIdHeader === 'string' && /^\d+$/.test(lastEventIdHeader.trim())
                    ? lastEventIdHeader.trim()
                    : undefined;

            const initial = await app.db.repos.runs.getRunWithEvents(id, lastEventId);
            if (initial === null) throw notFound(`run ${id} not found`);
            const { run } = initial;

            const stream = new Readable({ read() {} });
            let lastSeq = lastEventId !== undefined ? BigInt(lastEventId) : 0n;
            let closed = false;
            let subscriber: Redis | null = null;
            let statusPolling = false;

            const sendRunEnd = (status: string): void => {
                if (closed) return;
                // push(null) ends the stream cleanly — buffered frames flush
                // first (destroy() here would discard them).
                stream.push(sseFrame(null, 'RUN_END', { runId: run.id, status }));
                stream.push(null);
                releaseResources();
            };

            const heartbeat = setInterval(() => {
                if (closed || stream.destroyed) return;
                stream.push(': ping\n\n');
                // Eventless terminal transitions exist (API-side cancel of a
                // QUEUED run writes no event), so the heartbeat doubles as a
                // cheap terminal-status poll (single-row select, 15s cadence).
                if (statusPolling) return;
                statusPolling = true;
                void app.db.prisma.scanRun
                    .findUnique({ where: { id: run.id }, select: { status: true } })
                    .then((row) => {
                        if (row !== null && TERMINAL_RUN_STATUSES.has(row.status)) sendRunEnd(row.status);
                    })
                    .catch(() => undefined)
                    .finally(() => {
                        statusPolling = false;
                    });
            }, HEARTBEAT_INTERVAL_MS);

            /** Releases heartbeat + Redis subscriber exactly once. Never touches the stream. */
            const releaseResources = (): void => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                if (subscriber !== null) {
                    const sub = subscriber;
                    subscriber = null;
                    sub.removeAllListeners('message');
                    void sub.unsubscribe().catch(() => undefined);
                    void sub.quit().catch(() => undefined);
                }
            };
            // 'finish' = response fully sent (our own end), 'close' = socket gone
            // (client disconnect). Both release the Redis subscriber; a client
            // abort additionally destroys the (never self-destroyed) stream.
            reply.raw.on('finish', releaseResources);
            reply.raw.on('close', () => {
                releaseResources();
                if (!stream.destroyed) stream.destroy();
            });

            const pushEvent = (frameId: string, type: string, payload: RunEventMessage): void => {
                if (!closed && !stream.destroyed) stream.push(sseFrame(frameId, type, payload));
            };

            const deliverLive = (msg: RunEventMessage): void => {
                if (closed) return;
                let seq: bigint;
                try {
                    seq = BigInt(msg.seq);
                } catch {
                    return; // malformed cursor — skip frame
                }
                if (seq <= lastSeq) return; // already covered by the DB replay
                lastSeq = seq;
                pushEvent(msg.seq, msg.type, redactSecrets(msg));
                const terminal = terminalStatusFromPayload(msg.type, msg.data);
                if (terminal !== null) sendRunEnd(terminal);
            };

            /** Writes replay frames; returns the terminal status if a terminal event was replayed. */
            const replayEvents = (events: RunEventRecord[]): string | null => {
                let terminal: string | null = null;
                for (const event of events) {
                    const seq = BigInt(event.id);
                    if (seq <= lastSeq) continue;
                    lastSeq = seq;
                    pushEvent(event.id, event.type, framePayload(run, event));
                    terminal = terminalStatusFromPayload(event.type, event.data) ?? terminal;
                }
                return terminal;
            };

            if (TERMINAL_RUN_STATUSES.has(run.status)) {
                // Journal is complete (sink flushes before the terminal write):
                // replay + RUN_END + close, no subscription needed.
                reply.header('content-type', 'text/event-stream; charset=utf-8');
                reply.header('cache-control', 'no-cache');
                reply.header('x-accel-buffering', 'no');
                // Leading comment frame: forces header flush + confirms liveness.
                stream.push(': connected\n\n');
                replayEvents(initial.events);
                sendRunEnd(run.status);
                return reply.send(stream);
            }

            // Active run — subscribe FIRST (buffering), then re-query the
            // replay window so events persisted between the existence check
            // and the subscription are not lost (persist-then-publish).
            const channel = opts.runEventsChannel(run.id);
            const buffered: RunEventMessage[] = [];
            let replaying = true;
            subscriber = new Redis(opts.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
            subscriber.on('error', (err) => {
                request.log.warn({ err: { message: err.message } }, 'sse subscriber redis error');
            });
            subscriber.on('message', (messageChannel: string, raw: string) => {
                if (messageChannel !== channel) return;
                const msg = parseRunEventMessage(raw);
                if (msg === null) return;
                if (replaying) buffered.push(msg);
                else deliverLive(msg);
            });
            try {
                await subscriber.subscribe(channel);
            } catch (err) {
                releaseResources();
                if (!stream.destroyed) stream.destroy();
                throw err; // response not started — normal error shape applies
            }

            const replay = await app.db.repos.runs.getRunWithEvents(id, lastEventId);
            reply.header('content-type', 'text/event-stream; charset=utf-8');
            reply.header('cache-control', 'no-cache');
            reply.header('x-accel-buffering', 'no');
            // Leading comment frame: forces header flush + confirms liveness.
            stream.push(': connected\n\n');
            const replayTerminal = replayEvents(replay?.events ?? []);
            replaying = false;
            for (const msg of buffered) deliverLive(msg);
            // The run may have finished (with a terminal event) between the
            // existence check and now — close instead of hanging.
            if (replayTerminal !== null) sendRunEnd(replayTerminal);

            return reply.send(stream);
        },
    );
};
