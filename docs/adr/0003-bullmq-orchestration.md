# ADR 0003: BullMQ Orchestration on Redis

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** Architecture Agent
- **Related:** ARCHITECTURE.md §6

## Context

Runs must be queued, deduplicated per scan definition, cancellable mid-flight, scheduled by cron (timezone-aware), and recoverable when a worker dies. The system already runs Redis (needed for pub/sub and locks), and the deployment target is a single Docker host — no Kubernetes, no extra infrastructure. Run state must survive Redis restarts, so Redis cannot be the source of truth.

## Decision

Use **BullMQ 5 on Redis** as the job transport, with **Postgres as the source of truth** for run state:

- Two queues: `crawl-queue` (job `execute-run { runId }`, jobId `run:{runId}` for dedup) and `maintenance-queue` (`schedule-dispatch`, `stale-run-sweeper`, `stale-evaluation`, `proxy-health-check`, `artifact-retention`, `cookie-expiry-check` as repeatable jobs).
- **Run state machine lives in Postgres** (`ScanRun.status`: QUEUED/STARTING/RUNNING/CANCELLING/CANCELLED/SUCCEEDED/PARTIAL/FAILED). BullMQ carries only `{ runId }`; the worker loads the immutable `configurationSnapshot` from Postgres. This gives full audit history and makes BullMQ job states irrelevant to the domain model.
- **Same-definition concurrency:** Redis `SET lock:scan:{scanDefinitionId} {runId} NX EX 21600` before enqueue; `409 RUN_ALREADY_ACTIVE` on contention; lock released in a worker `finally`.
- **Cancellation:** API sets `CANCELLING` + Redis key `run-control:{runId}:cancel`; the worker's `CancellationToken` polls it between page loads and aborts the Crawlee autoscaled pool; terminal state `CANCELLED` (ARCHITECTURE.md §6.2).
- **Worker-death recovery:** BullMQ stalled detection on (`stalledInterval: 30s`, `maxStalledCount: 0` — no automatic re-run of side-effecting jobs) plus a `stale-run-sweeper` that fails runs whose `heartbeatAt` is older than 120s and releases their locks. Manual retry reuses the stored snapshot.
- **Scheduling:** a 30-second `schedule-dispatch` tick evaluates each definition's cron in its own timezone (`lastScheduledAt` as double-fire guard). No missed-window backfill.
- Worker crawl concurrency defaults to **1** (browser-heavy); configurable via `WORKER_CRAWL_CONCURRENCY`.

## Alternatives considered

- **node-cron + in-process queue inside `api`** — no persistence, no cross-process visibility, dies with the API process, couples scheduling to the HTTP tier; rejected.
- **pg-boss (Postgres-backed queue)** — one less moving part and transactional enqueue, but weaker stalled-job tooling, smaller ecosystem, and we already need Redis for pub/sub + locks; rejected to avoid two job systems' worth of operational knowledge on top of an existing Redis.
- **Agenda (MongoDB)** — introduces Mongo solely for jobs; rejected.
- **Temporal / Cadence** — excellent durable workflows, but a heavy server + SDK footprint incompatible with "simple monolith-style apps on one host"; rejected.
- **BullMQ Pro (flows)** — not needed; single-job runs suffice.

## Consequences

**Positive**

- Durable, inspectable queues with retries, repeatable jobs, and stalled detection out of the box.
- Postgres-backed run history survives Redis loss; Redis remains disposable transport.
- Cancellation and locking are simple Redis primitives shared with the SSE/pub-sub design (ADR-0004).
- Horizontal headroom (more worker replicas) exists without design change, even if we run one.

**Negative**

- Two systems to reason about (BullMQ job state vs. Postgres run state) — mitigated by the rule "Postgres is truth, BullMQ is transport."
- Sweeper-based recovery means a dead worker's run is marked FAILED after up to ~2 minutes, not instantly.
- Cron evaluation is tick-based (30s granularity) — acceptable for crawling schedules.
- Redis persistence (AOF) is recommended so queued runs survive a Redis restart.

## Compliance notes

None specific. Rate limiting and retry/backoff policy (allowed behavior per the legal boundary) are enforced inside the crawl job via `CrawlConfig` (`delayMinMs`/`delayMaxMs`, `maxRequestRetries`), not by the queue layer.
