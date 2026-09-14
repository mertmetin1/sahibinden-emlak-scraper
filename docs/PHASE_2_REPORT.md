# PHASE 2 REPORT — Real CATEGORY / DETAIL Pipeline

**Date:** 2026-09-14 · **Lead:** integration & review · **Agents:** A4 (parser package), A3 (engine router), A8 (QA)
**Phase goal:** explicit CATEGORY/DETAIL routing, dedicated parser package, full detail extraction with raw survival.

## Acceptance criteria — evidence

| Criterion | Status | Evidence |
|---|---|---|
| CATEGORY parser tests pass | ✅ | `category-normalize.test.ts` (10) + `category-fixture-parse.test.ts` (real Chrome vs sanitized fixture, 50 rows) |
| DETAIL parser tests pass | ✅ | `detail-normalize.test.ts` (pure node, synthetic raws) + `detail-fixtures.test.ts` (6 sanitized fixtures in real Chrome) |
| Malformed optional fields don't crash | ✅ | `detail-malformed.html` + `detail-missing-optional.html` fixtures: null fields, intact `attributesRaw`, zero throws |
| DETAIL cannot run CATEGORY logic | ✅ | `router.ts` switch + `router.test.ts` (5 unit tests) + e2e isolation assertion (detail `sourceUrl` is the `/ilan/…/detay` URL; no category artifacts in detail records) |
| Normalized + raw both survive | ✅ | Live proof: 25-key `attributesRaw` alongside all normalized fields (see below) |
| Full suite | ✅ | **175/175 tests, 13 files, 59s** · lint ✅ · typecheck ✅ |

## What was built

### `packages/parser-sahibinden` (A4 — dedicated parser package)
- **Versioned selector registry** (`selectors/`, `SELECTOR_VERSION 2026-09-14.1`) — category + detail chains with fixture citations.
- **Category parser** moved from engine (behavior frozen per baseline contract; engine re-exports for compatibility).
- **Detail parser**: `extractDetailRawInPage` (in-browser, self-contained for `page.evaluate`) + `normalizeDetail` (pure node) + `isUnavailableDetailHtml`.
  - **Generic label/value extraction first** → `attributesRaw: Record<string,string>` (duplicate labels suffixed) — unknown future fields never lost.
  - **CSS-obfuscation resolution**: `buildCssContentMap` + `resolveObfuscatedText` defeat sahibinden's `<style>.cssUUID:before{content}</style>` rendering trick for seller name/phone (found during Phase 0 fixture analysis).
  - **Known-field normalization**: 20+ Turkish labels mapped (m² brüt/net, oda, bina yaşı, kat, ısıtma, banyo, balkon, eşyalı, kullanım, site, aidat, depozito, tapu, kredi, takas…); TR number/date parsing (`tr-text.ts`: `parseTurkishDate`, `parseTrNumber`, `TURKISH_MONTHS`).
  - **Evidence-based seller classification** (`classifySeller`): store block → REAL_ESTATE_OFFICE; individual block → OWNER; 'İnşaat' in office name → CONSTRUCTION_COMPANY; else UNKNOWN with `sellerTypeEvidence: null`. Never guesses.
  - **Phone policy enforced**: `pickPublicContactPhone` reads only already-rendered DOM (`data-opened`); masked-only → `null`; no reveal interaction anywhere.
- **Derived sanitized fixtures** (+`detail-missing-optional`, `detail-malformed`, `detail-unavailable`) + `fixtures/html/README.md`.

### `packages/scraper-engine` (A3 — router & detail pipeline)
- Explicit router (`router.ts`): `CATEGORY` → category handler, `DETAIL` → detail handler, else `CrawlError('UNSUPPORTED_LABEL')`.
- Category handler: `includeDetails=true` → enqueue dedup'd DETAIL requests (`userData.listingData` carries the category row for merging), maxItems/maxPages/allowedDomains respected.
- Detail handler: ready-selector wait → unavailable detection (event, no write, no error) → in-page extract → normalize (category merge) → `upsertDetails` → `DETAIL_PARSED`. Extraction throw → `INVALID_PAGE`, isolated per listing.
- `JsonFileOutputRepository.upsertDetails` → `<run>-details-<ts>.json` (written only when non-empty); `CrawlResult` gained optional `detailPagesVisited`/`detailsWritten`.
- `maxRequestsPerCrawl` accounts for details when `includeDetails`.

## Live verification (real sahibinden.com via CDP, 2026-09-14 ~20:25)

`pnpm crawl --config ./examples/adana-detail-test.json` → SUCCEEDED: 3 category rows → 3 detail pages, **zero challenges**:
- `1334058004` → **CONSTRUCTION_COMPANY** (evidence: office name contains 'İnşaat' + Kimden='Emlak Ofisinden')
- `1328504133`, `1334419789` → **REAL_ESTATE_OFFICE**
- Sample record: 100/85 m², 2+1, Adana/Seyhan/Bahçeşehir, 15 images, ISO listing date, 25 raw attributes, category merge present.

## Migration ledger notes

- Parser ownership moved engine → `parser-sahibinden`; engine re-exports keep Phase-1 tests untouched (green without modification).
- `utils.ts` split: parsing helpers → parser package; `randomDelay` stays in engine (crawling concern).
- Unavailable-listing semantics: **not an error** — `DETAIL_UNAVAILABLE` event, nothing written, run continues (pinned by e2e test).

## Known gaps → next phases

- Persistence is still JSON files → Phase 3/4 (PostgreSQL/Prisma, dedup by source+id, price history).
- Detail concurrency shares the category pool → SessionPolicy phase.
- `pricePerSquareMeter` normalized on detail only when the attribute exists; category `price_per_sqm` string stays raw (contract-frozen).
