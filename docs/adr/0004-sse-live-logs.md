# ADR 0004: Server-Sent Events for Live Run Logs

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** Architecture Agent
- **Related:** ARCHITECTURE.md §9

## Context

The web UI must show a run's progress live: category pages parsed, listings discovered/inserted/updated, price changes, retries, failures, completion. Events originate in the **worker**, but browsers connect to the **api** (web proxies `/api/*`). We need ordered, gap-free delivery with reconnect support, over plain HTTP, behind Docker Compose networking, for a single-operator product (low client counts).

## Decision

Use **SSE (Server-Sent Events)** from `apps/api`, fed by Redis pub/sub, with Postgres-backed replay:

1. Worker `EventSink.emit()` first inserts a `ScanRunEvent` row (its autoincrement `id` is the ordering `seq`), then publishes the serialized event to Redis channel `run-events:{runId}`. **Persist-then-publish** guarantees subscribers never see an event that a replaying client couldn't also fetch.
2. API route `GET /api/v1/runs/:id/events/stream` (SSE): on connect, replays `ScanRunEvent` rows with `id > Last-Event-ID`, then subscribes to `run-events:{runId}` and forwards frames (`id:` = seq, `data:` = event JSON). A heartbeat comment frame is sent every 15s.
3. The web app uses the native `EventSource` (or a thin fetch-based SSE reader) against the proxied API path; reconnect with `Last-Event-ID` resumes without gaps or duplicates.
4. Event payloads are built from whitelisted types with redaction rules (ARCHITECTURE.md §9.3) — no secrets ever traverse the stream.

## Alternatives considered

- **WebSocket / socket.io** — bidirectional capability we don't need (clients never send run data); socket.io adds a stateful protocol, sticky-session concerns, and a client dependency. Rejected as overkill.
- **Client polling of `GET /runs/:id/events?after=`** — simplest, but adds latency, request churn, and UI complexity for marginal ops savings; kept as the non-live fallback endpoint, not the primary channel.
- **Expose Redis pub/sub or Redis Streams directly to the browser** — impossible/insecure (no auth boundary, no replay semantics for browsers); rejected.
- **NATS / Kafka** — infrastructure far beyond a single-host product; rejected.

## Consequences

**Positive**

- Plain HTTP/1.1: works through the Next.js proxy, Docker networks, and reverse proxies without upgrade negotiation.
- Automatic browser reconnect + `Last-Event-ID` gives exactly-once-enough semantics with trivial client code.
- Persisted `ScanRunEvent` doubles as the run audit log and the post-mortem debugging surface — the live stream and history are the same data.
- One Redis channel per active run keeps pub/sub fan-out tiny; channels exist only while subscribed.

**Negative**

- SSE is one-way; run *control* (cancel) remains a normal POST — acceptable, they are separate concerns.
- HTTP/1.1 browser limit (~6 connections per origin) matters only if a user opens many run pages; mitigated by the web proxy using HTTP/1.1 keep-alive and by low client counts.
- Proxies must not buffer SSE (Next.js rewrites and nginx need buffering disabled for the stream route) — documented in the web app implementation notes.
- API holds one Redis subscriber connection per open stream; fine at single-operator scale, would need sharding at hundreds of concurrent viewers.

## Compliance notes

The stream is a redaction boundary: event builders use whitelisted payload types, and Pino redact paths cover cookie/proxy/secret keys (ARCHITECTURE.md §9.3). No user credentials, cookie values, or proxy URLs may appear in any SSE frame.
