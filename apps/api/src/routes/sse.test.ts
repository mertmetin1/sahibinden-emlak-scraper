/**
 * SSE stream tests (ADR-0004) — real HTTP against a listening app (inject
 * buffers whole responses and cannot exercise a live stream).
 *
 * Covers: live frames in order with ids, DB-backed replay on reconnect via
 * Last-Event-ID, terminal RUN_END + close (both live-detected and
 * already-terminal connect), unknown-run 404, and the paginated
 * /api/runs/:id/events replay endpoint. Events are persisted via the
 * repository then published to the namespaced channel (persist-then-publish,
 * exactly like the worker's DbRedisEventSink). No worker needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { buildTestContext, TEST_REDIS_URL, type TestAppContext } from '../testing/test-app.js';
import { seedRun, seedScan } from '../testing/seed.js';

interface SseFrame {
    id: string | null;
    event: string;
    data: string;
}

function parseFrame(raw: string): SseFrame {
    const frame: SseFrame = { id: null, event: 'message', data: '' };
    for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue; // heartbeat comment
        else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) frame.data = line.slice(5).trim();
    }
    return frame;
}

/** Minimal SSE reader over a fetch response body. */
class SseClient {
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    private buffer = '';
    private readonly decoder = new TextDecoder();
    private streamDone = false;

    constructor(private readonly response: Response) {
        if (response.body === null) throw new Error('SSE response has no body');
        this.reader = response.body.getReader();
    }

    /** Next DATA frame (comment-only frames like `: ping` are skipped), or null on stream end. */
    async nextFrame(timeoutMs = 10_000): Promise<SseFrame | null> {
        for (;;) {
            while (!this.buffer.includes('\n\n')) {
                if (this.streamDone) {
                    const rest = this.buffer;
                    this.buffer = '';
                    return rest.trim() === '' ? null : parseFrame(rest);
                }
                const result = await Promise.race([
                    this.reader.read(),
                    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timed out waiting for SSE frame')), timeoutMs)),
                ]);
                if (result.done) {
                    this.streamDone = true;
                    continue;
                }
                this.buffer += this.decoder.decode(result.value, { stream: true });
            }
            const idx = this.buffer.indexOf('\n\n');
            const raw = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 2);
            const frame = parseFrame(raw);
            // Comment-only frames (heartbeats, the leading `: connected`) carry no data.
            if (frame.id === null && frame.event === 'message' && frame.data === '') continue;
            return frame;
        }
    }

    async close(): Promise<void> {
        await this.reader.cancel().catch(() => undefined);
        // Consume/close the underlying response so the socket is released.
        this.response.body?.cancel().catch(() => undefined);
    }
}

describe('run events (replay endpoint + SSE stream)', () => {
    let ctx: TestAppContext;
    let publisher: Redis;
    let baseUrl: string;
    /** Every open client — closed in afterAll so app.close() never waits on SSE sockets. */
    const openClients: SseClient[] = [];

    beforeAll(async () => {
        ctx = await buildTestContext('sse');
        await ctx.app.listen({ port: 0, host: '127.0.0.1' });
        const address = ctx.app.server.address();
        if (address === null || typeof address === 'string') throw new Error('no listen address');
        baseUrl = `http://127.0.0.1:${address.port}`;
        publisher = new Redis(TEST_REDIS_URL);
    });

    afterAll(async () => {
        await Promise.all(openClients.splice(0).map((client) => client.close()));
        await publisher.quit();
        await ctx.cleanup();
        await ctx.app.close();
    });

    async function connect(runId: string, lastEventId?: string): Promise<{ response: Response; client: SseClient }> {
        const response = await fetch(`${baseUrl}/api/runs/${runId}/events/stream`, {
            headers: lastEventId !== undefined ? { 'last-event-id': lastEventId } : {},
        });
        const client = new SseClient(response);
        openClients.push(client);
        return { response, client };
    }

    /** Persist-then-publish, mirroring the worker's DbRedisEventSink. */
    async function persistAndPublish(runId: string, scanId: string, type: string, data: unknown): Promise<string> {
        const record = await ctx.app.db.repos.runs.addEvent(runId, type, data);
        const message = {
            seq: record.id,
            runId,
            scanDefinitionId: scanId,
            type,
            at: new Date().toISOString(),
            data: data ?? null,
        };
        await publisher.publish(ctx.runEventsChannel(runId), JSON.stringify(message));
        return record.id;
    }

    it('streams live frames in order, replays from DB on Last-Event-ID reconnect, ends with RUN_END', async () => {
        const scanId = await seedScan(ctx);
        const runId = await seedRun(ctx, scanId); // QUEUED — non-terminal

        // -- Connect 1: two live events arrive in order with their ids --------
        const first = await connect(runId);
        expect(first.response.status).toBe(200);
        expect(first.response.headers.get('content-type')).toContain('text/event-stream');

        const seq1 = await persistAndPublish(runId, scanId, 'RUN_STARTED', { triggerType: 'MANUAL' });
        const frame1 = await first.client.nextFrame();
        expect(frame1?.id).toBe(seq1);
        expect(frame1?.event).toBe('RUN_STARTED');
        expect(JSON.parse(frame1?.data ?? '{}')).toMatchObject({ seq: seq1, runId, scanDefinitionId: scanId });

        const seq2 = await persistAndPublish(runId, scanId, 'CATEGORY_PARSED', { url: 'https://x', listingsFound: 3 });
        const frame2 = await first.client.nextFrame();
        expect(frame2?.id).toBe(seq2);
        expect(frame2?.event).toBe('CATEGORY_PARSED');
        expect(BigInt(frame2?.id ?? '0')).toBeGreaterThan(BigInt(seq1));
        await first.client.close();

        // -- Reconnect with Last-Event-ID = seq1 → only seq2 replays (from DB)
        const second = await connect(runId, seq1);
        expect(second.response.status).toBe(200);
        const replayed = await second.client.nextFrame();
        expect(replayed?.id).toBe(seq2);
        expect(replayed?.event).toBe('CATEGORY_PARSED');
        expect(JSON.parse(replayed?.data ?? '{}')).toMatchObject({ seq: seq2, runId });

        // -- Terminal: RUN_COMPLETED frame, then RUN_END, then stream closes --
        await ctx.app.db.repos.runs.finishRun(runId, 'SUCCEEDED', { itemsInserted: 3 });
        const seq3 = await persistAndPublish(runId, scanId, 'RUN_COMPLETED', { status: 'SUCCEEDED' });
        const frame3 = await second.client.nextFrame();
        expect(frame3?.id).toBe(seq3);
        expect(frame3?.event).toBe('RUN_COMPLETED');

        const runEnd = await second.client.nextFrame();
        expect(runEnd?.event).toBe('RUN_END');
        expect(runEnd?.id).toBeNull(); // not a persisted event — must not pollute cursors
        expect(JSON.parse(runEnd?.data ?? '{}')).toMatchObject({ runId, status: 'SUCCEEDED' });

        expect(await second.client.nextFrame()).toBeNull(); // stream closed
        await second.client.close();
    });

    it('replays the journal then closes immediately for an already-terminal run', async () => {
        const scanId = await seedScan(ctx);
        const runId = await seedRun(ctx, scanId);
        const seq1 = await ctx.app.db.repos.runs.addEvent(runId, 'RUN_STARTED', { triggerType: 'MANUAL' });
        await ctx.app.db.repos.runs.finishRun(runId, 'FAILED', {}, 'boom (test)');

        const { response, client } = await connect(runId);
        expect(response.status).toBe(200);

        const replayed = await client.nextFrame();
        expect(replayed?.id).toBe(seq1.id);
        expect(replayed?.event).toBe('RUN_STARTED');

        const runEnd = await client.nextFrame();
        expect(runEnd?.event).toBe('RUN_END');
        expect(JSON.parse(runEnd?.data ?? '{}')).toMatchObject({ runId, status: 'FAILED' });

        expect(await client.nextFrame()).toBeNull();
        await client.close();
    });

    it('404s the stream for an unknown run with the uniform error shape', async () => {
        const response = await fetch(`${baseUrl}/api/runs/does-not-exist/events/stream`);
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.error.code).toBe('NOT_FOUND');
    });

    it('GET /api/runs/:id/events replays paginated by afterId with lastEventId cursor', async () => {
        const scanId = await seedScan(ctx);
        const runId = await seedRun(ctx, scanId);
        const e1 = await ctx.app.db.repos.runs.addEvent(runId, 'RUN_STARTED', { triggerType: 'MANUAL' });
        const e2 = await ctx.app.db.repos.runs.addEvent(runId, 'CATEGORY_PARSED', { listingsFound: 2 });
        const e3 = await ctx.app.db.repos.runs.addEvent(runId, 'RUN_COMPLETED', { status: 'SUCCEEDED' });

        const all = await ctx.app.inject({ method: 'GET', url: `/api/runs/${runId}/events` });
        expect(all.statusCode).toBe(200);
        expect(all.json().events.map((e: { id: string }) => e.id)).toEqual([e1.id, e2.id, e3.id]);
        expect(all.json().lastEventId).toBe(e3.id);

        const after = await ctx.app.inject({ method: 'GET', url: `/api/runs/${runId}/events?afterId=${e1.id}` });
        expect(after.statusCode).toBe(200);
        expect(after.json().events.map((e: { id: string }) => e.id)).toEqual([e2.id, e3.id]);
        expect(after.json().lastEventId).toBe(e3.id);

        // No new events → empty page, cursor echoes the requested afterId.
        const none = await ctx.app.inject({ method: 'GET', url: `/api/runs/${runId}/events?afterId=${e3.id}` });
        expect(none.json()).toEqual({ events: [], lastEventId: e3.id });

        const badCursor = await ctx.app.inject({ method: 'GET', url: `/api/runs/${runId}/events?afterId=abc` });
        expect(badCursor.statusCode).toBe(400);

        const missing = await ctx.app.inject({ method: 'GET', url: '/api/runs/nope/events' });
        expect(missing.statusCode).toBe(404);
    });
});
