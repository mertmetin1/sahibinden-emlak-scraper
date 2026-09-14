# PHASE 4 REPORT — Durable Job Engine, Proxy and Session Profiles

**Date:** 2026-09-14 · **Lead:** integration & review · **Agents:** A9 (security/profiles), A3 (engine proxy/session), A6 (worker), A5 (API)
**Phase goal:** Redis+BullMQ durable jobs, encrypted proxy/cookie profiles, session policies, minimal API.

## Acceptance criteria — evidence

| Criterion | Status | Evidence |
|---|---|---|
| Multiple proxy endpoints configurable | ✅ | `ProxyProfile`/`ProxyEndpoint` + bulk import (4 conventional formats) + health testing; unit-tested |
| Session profile assignable to scan | ✅ | `ScanDefinition.sessionPolicyId` → worker wires `sessionPolicy` into engine deps |
| Cookie profile assignable to scan | ✅ | `ScanDefinition.cookieProfileId` → worker decrypts → `StaticSessionProvider` |
| Secrets not retrievable via GET API | ✅ | `secrets.test.ts`: deep-scans API responses for password/cookie material — none; metadata-only reads (`hasPassword`, `cookieCount`, `domainSummary`…) |
| Queue survives API restart | ✅ | **Live:** run QUEUED → API killed → restarted → run still QUEUED (Redis-backed BullMQ) |
| Worker executes queued scan | ✅ | **Live:** API → Redis → worker picked up → RUNNING with heartbeats → engine via CDP |
| Cancel works | ✅ | **Live, both paths:** queued → CANCELLED immediately; running → CANCELLING → cooperative drain → CANCELLED in <20s |
| Failed jobs classified | ✅ | Engine taxonomy (NETWORK/TIMEOUT/AUTH_REQUIRED/PARSER_CHANGED/RATE_LIMIT/PROXY_ERROR/…) persisted to `ScanRun.errorSummary`; BullMQ `attempts: 2` + classified final failure |
| Secret-redaction tests | ✅ | `security.test.ts` (encrypt/decrypt/tamper/wrong-key/redact matrix) + API `secrets.test.ts` |

**Suite:** 381/381 tests, 36 files · typecheck ✅ · lint ✅

## What was built

### Security (A9) — `packages/shared/src/security.ts`
- AES-256-GCM envelope `v1:<iv>:<authTag>:<ciphertext>`, per-record 12-byte IV; `loadMasterKey` fail-fast env validation (ADR-0005).
- `redactProxyUrl` (credentials stripped), `redactSecrets` (deep, circular-safe, key-pattern + URL based).
- `normalizeCookieExport` (EditThisCookie / Cookie-Editor / raw-header shapes) + `summarizeCookies` (metadata only).
- Profile repositories: `PrismaProxyProfileRepository` (endpoints, bulk import, health bookkeeping w/ DEGRADED/UNHEALTHY transitions + 15-min quarantine, decryption only via `getEndpointCredentials`), `PrismaCookieProfileRepository` (import/replace encrypted; metadata-only reads; `getCookiesDecrypted` single decryption path), `PrismaSessionPolicyRepository` (plain CRUD).

### Engine proxy/session (A3)
- `ProfileProxyProvider`: plain endpoints → Crawlee `ProxyConfiguration`; ROUND_ROBIN (Crawlee rotation) vs SESSION_STICKY (session-consistent assignment); credential-safe `describe()`.
- `ProxyHealthChecker`: connectivity-only checks (default target `api.ipify.org` — **never the target site**, per legal boundary), latency, error classification (`timeout/connect-refused/auth/dns/tls/unsupported-protocol`); hermetic tests with a local forward-proxy.
- `crawlConfigFromSnapshot`: ScanDefinition snapshot → typed `CrawlConfig`.
- `CrawlDeps.sessionPolicy` (optional) wires pool size/usage/persist into Crawlee SessionPool.

### Worker (A6) — `apps/worker`
- BullMQ `Worker` (concurrency 1) on `crawl-queue`; run lifecycle QUEUED→STARTING→RUNNING→terminal; 15s heartbeats; counters + classified `errorSummary` persisted (Postgres = truth).
- **Scheduler**: 30s tick, croner + per-scan timezone (default Europe/Istanbul), due-window + already-fired + already-running guards.
- **Sweeper**: stale RUNNING (heartbeat lost >60s) → FAILED; orphaned CANCELLING → CANCELLED.
- **Cancellation**: Redis cancel key polled by token (2s) → cooperative engine drain.
- **DbRedisEventSink**: ScanRunEvent insert → Redis publish (`run-events:{runId}`) — persist-then-publish (ADR-0004), `redactSecrets` defensive pass.
- **Graceful shutdown**: SIGTERM → stop scheduler/sweeper → pause worker → cancel active run → 25s budget → close worker/queue/prisma/redis; second signal forces exit.

### API (A5) — `apps/api` (Fastify 5)
- Routes: `/health` (real db/redis pings), `/api/scans` CRUD + duplicate + toggle, run control (`run`/`test`/`cancel`/`retry`), `/api/runs` list+detail+events, proxy profiles + endpoints + bulk import, cookie profiles (import/replace/toggle/delete — metadata-only responses), session policies CRUD.
- Zod edge validation (domain policy, cdp-requires-cdpUrl, cron validity, profile existence), consistent error shape, security headers, CORS localhost-only.
- Queue producer implementing the frozen contract (run-row-first, `jobId scan:{id}:{runId}`, duplicate guard DB + Redis NX race guard).

## Live smoke log (2026-09-14 ~22:00)

1. `POST /api/scans` (disabled) → `POST /test` refused `SCAN_DISABLED` ✅ → toggle → test run QUEUED ✅
2. API killed & restarted → run still QUEUED ✅ (queue survival)
3. Worker start → job picked up → RUNNING + heartbeats ✅
4. sahibinden 403 (scan had **no cookie profile** + 4h-decayed debug session) → engine emitted `HUMAN_SOLVE_REQUESTED` correctly through the worker; timed out per config when unsolved ✅ (flow works; operational note below)
5. `POST /runs/:id/cancel` while RUNNING → CANCELLING → CANCELLED in <20s ✅

## Operational note (not a defect)

A sahibinden scan needs a **cookie profile** assigned (authorized session) — the smoke scan deliberately had none. With the profile assigned (or a fresh human solve), the same pipeline crawls cleanly (proven in Phase 1/2 live runs).

## Known gaps → next phases

- `itemsInserted` vs `itemsUpdated` split is approximate when the output adapter doesn't expose per-outcome counts (documented in worker code; Phase 6 observability pass will exact it).
- SSE bridge (Redis pub/sub → API → web) lands with Phase 6 web UI.
- Proxy health auto-scheduling (periodic re-checks) lands with the maintenance queue's UI-driven triggers.
