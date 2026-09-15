# PHASE 5 REPORT — Backend API

**Date:** 2026-09-15 · **Lead:** integration & review · **Agent:** A5 (backend)
**Phase goal:** complete the Fastify REST API — dashboard, listings intelligence, exports, SSE, OpenAPI.

## Acceptance criteria — evidence

| Criterion | Status | Evidence |
|---|---|---|
| API tests pass | ✅ | 405/405 total (42 files) — incl. new dashboard/listings/listing-detail/export/sse/openapi suites |
| Filters combine | ✅ | `listings.test.ts`: province+district+sellerType+price range+search composed at DB level (Prisma where — never load-all) |
| Pagination stable | ✅ | page 1/2/3 no-overlap assertions, exact totalPages, sort asc/desc |
| CSV export works | ✅ | Streaming (500-row DB pages, never full-buffer), UTF-8 BOM, escaping tested (comma/quote/newline titles), 50k cap; live smoke: 19 rows for `priceMin=4000000` |
| SSE reconnect works | ✅ | `sse.test.ts`: live pub/sub order + `Last-Event-ID` replay from Postgres (ADR-0004 persist-then-publish), terminal `RUN_END` closes stream |
| Secrets redacted | ✅ | `secrets.test.ts` deep-scans responses; metadata-only profile reads |
| Invalid target domains rejected | ✅ | Scan create/update Zod + allowed-domain policy (engine SSRF guard double-enforces) |
| OpenAPI | ✅ | OpenAPI 3.1 at `/api/openapi.json` (31 paths, tagged), UI at `/api/docs`; `openapi.test.ts` validates shape |

**Gates:** typecheck ✅ · lint ✅ (0 errors) · test ✅ 405/405

## Route map (final)

| Area | Routes |
|---|---|
| system | `GET /health` · `GET /api/openapi.json` · `GET /api/docs` |
| dashboard | `GET /api/dashboard` (totals, today counters, seller split, proxy health summary, recent runs) |
| listings | `GET /api/listings` (16 combinable filters + sort + pagination) · `GET /api/listings/:id` (full detail: seller, images, attributes, price/seen history, runs) · `GET /api/listings/:id/price-history` (+summary) · `GET /api/listings/export.csv` (streaming) |
| scans | CRUD + duplicate + toggle + run/test (Phase 4) |
| runs | list/detail + cancel/retry (Phase 4) + `GET /api/runs/:id/events` (paginated replay) + `GET /api/runs/:id/events/stream` (SSE) |
| proxies | profiles + endpoints + bulk import + toggle (Phase 4) |
| cookies | profiles import/replace/toggle/delete, metadata-only (Phase 4) |
| sessions | session-policies CRUD (Phase 4) |
| settings | `GET/PATCH /api/settings` (whitelisted keys only) |

## Live smoke (2026-09-15 ~10:05)

`/health` → ok/db+redis up · `/api/dashboard` → 20 listings aggregates · `/api/listings?sort=price&order=desc` → 20 rows, correct order · `export.csv?priceMin=4000000` → 19 rows + BOM · `openapi.json` → 31 paths.

## Notes → next phases

- SSE bridge is API-side complete; the web UI consumes it in Phase 6.
- `export.maxRows` setting honored via Settings whitelist.
- Dashboard aggregates are Prisma count/groupBy — no full-table loads.
