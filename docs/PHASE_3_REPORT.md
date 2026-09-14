# PHASE 3 REPORT — Database and Listing Intelligence

**Date:** 2026-09-14 · **Lead:** integration & review · **Agents:** A5 (database), A8 (DB integration tests)
**Phase goal:** PostgreSQL + Prisma persistence, canonical identity, listing intelligence.

## Acceptance criteria — evidence

| Criterion | Status | Evidence |
|---|---|---|
| Migration from zero works | ✅ | `prisma migrate deploy` on empty DB → `000000000000_init` applied (SQL generated offline via `migrate diff`, verified against live PG 17) |
| Seed command works | ✅ | `pnpm db:seed` → 20 listings; second run → inserted=0, unchanged=20 (idempotent) |
| Listing upsert idempotent | ✅ | 20× upsert of the same listing → exactly 1 Listing row, 20 seen-history rows, 20 run links |
| Price history test passes | ✅ | change → 1 history row + PRICE_CHANGED; same price → UNCHANGED, no new row; null↔value edges covered |
| Seen history test passes | ✅ | every observation writes ListingSeenHistory + ScanRunListing (runId, listingId, outcome) |
| Stale logic tests pass | ✅ | stale only after N=2 consecutive successful expected absences; resurrection on re-sight; failed/incremental runs don't advance staleness; never-expected listings untouched |
| Full suite | ✅ | **233/233 tests, 20 files** · lint ✅ · typecheck ✅ |

## What was built

### `packages/database` (A5)
- **Prisma schema — 15 models**: Listing, ListingImage, ListingAttribute, ListingPriceHistory, ListingSeenHistory, Seller, ScanDefinition, ScanRun, ScanRunEvent (BigInt autoincrement for SSE replay ordering), ScanRunListing, ProxyProfile, ProxyEndpoint, CookieProfile, SessionPolicy, AppSetting + 9 enums.
- **Canonical identity**: `@@unique([source, sourceListingId])`; `decideOutcome` pure function drives INSERTED/UPDATED/PRICE_CHANGED/UNCHANGED (unit-tested matrix).
- **Stale intelligence**: `missedRunCount` + `staleAfterSuccessfulRuns` per scan; `applySuccessfulRunStaleness` runs only for non-incremental SUCCEEDED runs; REMOVED only via explicit unavailable signal (`markRemoved`).
- **Seller resolution**: upsert by `(source, profileUrl)` with `''` sentinel for null profileUrl (documented).
- **Derived UI fields**: `listWithDerived` — filters (province/district/neighborhood/sellerType/listingType/propertyCategory/price/m2/rooms/dates/priceChanged/scanId/search), pagination, sort, + computed `priceChanged` and `latestPriceChangePercent` (last two history rows).
- **PrismaOutputRepository**: implements the shared `OutputRepository` port — the scraper engine stays Prisma-free; per-item failures isolated and classified 'DATABASE'.
- **RunRepository**: status machine fields, heartbeat, ordered events (`afterEventId` replay for SSE), `findStaleRunningRuns` for the Phase-4 sweeper.

### Infrastructure (Lead)
- `docker-compose.yml`: postgres:17-alpine + redis:7-alpine, healthchecks, named volumes. **Host note:** port 5433 (a local Windows PostgreSQL occupies 5432).
- `.env.example` + generated `.env` (APP_SECRET_KEY generated; gitignored).
- Root scripts: `db:generate`, `db:migrate`, `db:seed`, `db:studio`.

## Migration ledger

- Engine → DB boundary: engine emits via `OutputRepository` port only; `PrismaOutputRepository` adapts. No Prisma import outside `packages/database` (enforced by review; dependency-boundary lint rule lands in Phase 6 hardening).
- Seed doubles as an upsert smoke path (uses the real repository, not raw SQL).

## Known notes → next phases

- ProxyEndpoint/CookieProfile/SessionPolicy models exist but encryption + health flows land in Phase 5 (A9/A6).
- ScanRunEvent is written by repositories; the live SSE bridge (Redis pub/sub → API) lands with the API phase.
- `latestPriceChangePercent` computed in JS from last-2 history rows (no raw SQL) — fine at this scale; revisit with index-backed aggregation if listings grow past ~100k.
