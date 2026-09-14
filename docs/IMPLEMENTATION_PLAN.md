# Implementation Plan — Sahibinden Local-First Crawler

**Lead:** Lead Software Architect (integration & merge owner)
**Upstream baseline:** `tyegen/sahibinden-emlak-scraper @ a14740c` — see [UPSTREAM_AUDIT.md](./UPSTREAM_AUDIT.md)
**Target architecture:** see [ARCHITECTURE.md](./ARCHITECTURE.md) + `docs/adr/`

## Rules of engagement (binding)

1. Phases execute **sequentially**; each phase leaves the repo runnable.
2. No pseudo-code, TODO placeholders, mocked production paths, empty handlers.
3. Phase exit gate: `test` + `lint` + `typecheck` + `build` green, docs updated, `PHASE_REPORT.md` written.
4. Upstream behavior is preserved until its local equivalent passes regression tests.
5. Legal boundary is enforced by construction: stealth plugin, PX auto-hold solver, and fingerprint overrides are **deleted, never ported** (ADR-0002/0006). Authorized user cookies, user proxies, session persistence, rate limiting, retries, normal browser automation are allowed.
6. Agents own disjoint file sets; Lead merges.

## Phase map

| # | Phase | Owner | Deliverables | Exit criteria |
|---|-------|-------|--------------|----------------|
| 0 | Audit & plan | A1, A2, Lead | UPSTREAM_AUDIT, ARCHITECTURE, ADRs, this plan, RISK_REGISTER | Docs reviewed ✅ |
| 1 | Known-working baseline | A3 (Scraper) + A8 (QA) | Upstream runs locally via CDP mode; baseline output captured (`fixtures/baseline/*.json`); baseline contract doc | Baseline JSON matches audit contract |
| 2 | Regression fixtures | A4 (Parser) + A8 | HTML fixtures: category, detail-normal, detail-missing-fields, detail-office, detail-owner, detail-many-attrs, malformed, unavailable; fixture README (no sensitive personal data) | Fixtures committed; loadable in Vitest |
| 3 | Abstraction boundaries | A3 | `packages/scraper-engine` ports: `runCrawl(config, deps)`, `OutputRepository`, `DebugArtifactStore`, `ProxyProvider`, `SessionProvider`, `CrawlLogger`, `BrowserProvider`, `CancellationToken`, `EventSink` | Engine compiles against ports only |
| 4 | De-Apify | A3 | All 10 `Actor.*` sites replaced; Apify SDK removed from engine deps; local adapters (FS dataset export, FS debug store) | Engine runs without `apify` package |
| 5 | Local parity | A3 + A8 | Category crawl via managed Chromium AND CDP mode; regression test: baseline fixture contract reproduced | Parity test green |
| 6 | CATEGORY/DETAIL split | A3 + A4 | Explicit label routing, `UnsupportedLabelError`, detail handler skeleton wired (no silent fallthrough) | Routing unit tests green |
| 7 | Detail extraction | A4 | `attributesRaw` generic extractor + normalized fields (per ARCHITECTURE §5), seller classification w/ evidence, images as records | Detail fixture tests green |
| 8 | Persistence | A5 (Backend) | `packages/database`: Prisma schema (15 models), migrations, repositories, dedup (`source+sourceListingId`), price history, seen history, stale-after-N rule | DB integration tests green |
| 9 | Orchestration | A6 (Queue) | `apps/worker`: BullMQ crawl+maintenance queues, same-scan lock, cancellation, stalled-run sweeper, heartbeats, graceful shutdown | Queue tests green (dup/retry/cancel/recovery) |
| 10 | Proxy/session config | A5 + A6 + A9 (Security) | ProxyProfile/Endpoint CRUD + health checks + quarantine; CookieProfile encrypted import (AES-256-GCM), metadata-only reads; SessionPolicy wired to Crawlee SessionPool | Secret redaction tests green |
| 11 | Web UI | A7 (Frontend) | `apps/web`: Dashboard, Listings (filter/sort/paginate/CSV), Listing detail, Scans CRUD + Run Now/Test/Duplicate/Disable, Runs w/ live SSE logs, Proxies, Sessions, Settings | Playwright E2E green |
| 12 | Scheduling | A6 + A7 | Cron per scan, Europe/Istanbul default, enable/disable, next-run preview | Schedule tests green |
| 13 | Observability | A5 + A6 | Pino everywhere, run event stream (persist→publish→SSE replay), health endpoints, debug artifact retention | Log/secret-scan tests green |
| 14 | Hardening | A8 + A9 | Full test suite, SSRF/allowed-domain policy, input validation audit, dependency audit, worker crash tests | Reliability report written |
| 15 | Docker & release | A10 (DevOps) | Dockerfiles (non-root, worker w/ Chromium deps), compose (postgres/redis/api/worker/web), healthchecks, `.env.example`, startup validation, all docs finalized | `docker compose up -d` → full DoD pass |

## Agent ↔ file ownership (no overlaps)

| Agent | Owns |
|-------|------|
| A3 Scraper Engine | `packages/scraper-engine/**` |
| A4 Parser | `packages/parser-sahibinden/**`, `fixtures/**` |
| A5 Backend | `packages/database/**`, `apps/api/**` |
| A6 Queue/Scheduler | `apps/worker/**` (queue parts) |
| A7 Frontend | `apps/web/**` |
| A8 QA | `**/*.test.ts`, `tests/**`, reliability reports |
| A9 Security | `packages/shared/security/**`, security review gates |
| A10 DevOps | `Dockerfile*`, `docker-compose.yml`, `scripts/**`, root configs |
| Lead | `docs/**`, root workspace files, merge decisions |

## Migration ledger (per-step documentation)

Every behavior-changing step records in its PHASE_REPORT: before → after → tests → known differences. Upstream attribution lives in `docs/UPSTREAM.md` (created in Phase 1).
