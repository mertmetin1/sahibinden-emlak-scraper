/**
 * Minimal fetch-based SSE reader.
 *
 * Why not EventSource: the run-events stream replays from Postgres via the
 * `Last-Event-ID` header (ADR-0004 persist-then-publish). EventSource only
 * sends that header on ITS OWN reconnects — a fresh page load always starts
 * without it. Using fetch lets us pass the cursor we persisted (per run, in
 * sessionStorage) on every (re)connect, so a browser refresh resumes exactly
 * where the previous view left off instead of replaying the whole journal.
 */

export interface SseFrame {
    id: string | null;
    event: string;
    data: string;
}

function parseFrame(raw: string): SseFrame | null {
    let id: string | null = null;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue; // comment / heartbeat
        if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return null;
    return { id, event, data: dataLines.join('\n') };
}

/**
 * Async generator over SSE frames. Throws on non-2xx; ends when the server
 * closes the stream. Abort via the passed signal.
 */
export async function* streamSse(
    url: string,
    lastEventId: string | null,
    signal: AbortSignal,
): AsyncGenerator<SseFrame> {
    const res = await fetch(url, {
        headers: lastEventId !== null ? { 'last-event-id': lastEventId } : {},
        cache: 'no-store',
        signal,
    });
    if (!res.ok || res.body === null) {
        throw new Error(`SSE stream failed (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const rawFrame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const frame = parseFrame(rawFrame);
            if (frame !== null) yield frame;
            boundary = buffer.indexOf('\n\n');
        }
    }
}
