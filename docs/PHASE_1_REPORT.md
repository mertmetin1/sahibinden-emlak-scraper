# PHASE 1 REPORT — Local Runtime Extraction

**Date:** 2026-09-14 · **Lead:** integration & review · **Agents:** A3 (engine), A8 (QA)
**Phase goal:** decouple the crawler from Apify with minimal crawling-behavior change; run locally from CLI.

## Acceptance criteria — evidence

| Criterion | Status | Evidence |
|---|---|---|
| `pnpm install` succeeds | ✅ | pnpm 12.4.1, 5 workspace projects; `ignoredBuiltDependencies` for esbuild/puppeteer (Chrome is installed locally; no browser download) |
| Crawler starts locally | ✅ | `pnpm crawl --config ./examples/fixture-offline-test.json` and live CDP run both SUCCEEDED |
| Configuration loads from JSON | ✅ | `packages/config` Zod schema, typed `CrawlConfig`, friendly validation errors |
| Same baseline fields as upstream | ✅ | Live CDP run + fixture run emit the exact 13-field contract (`docs/BASELINE_CONTRACT.md`); regression tests assert it |
| Results to local JSON dataset | ✅ | `JsonFileOutputRepository` → `storage/datasets/<run>-<ts>.json` |
| No Apify token required | ✅ | No `apify` dependency anywhere in the engine |
| No `Actor.*` in scraper core | ✅ | `tests/meta/no-apify.test.ts` greps sources (comment-stripped) — passes |
| Regression tests pass | ✅ | **61/61** (7 files, 24s): utils 17, category-normalize 10, config 8+, baseline-contract, fixture-parse (real Chrome `setContent`), e2e offline crawl ×3, no-apify meta |

## Gates

`lint` ✅ (0 errors) · `typecheck` ✅ (`tsc -b`, 0 errors) · `test` ✅ (61/61) · `build` ✅ (same as typecheck; runtime via tsx)

## What was built

```
packages/shared/          types (CrawlConfig, CategoryListing, CrawlError+taxonomy, ports, events) + pino logger w/ redaction
packages/config/          Zod schema + loadConfig (defaults per contract; SSRF allowedDomains default sahibinden.com)
packages/scraper-engine/  runCrawl(config, deps) — de-Apify'd Crawlee PuppeteerCrawler engine
  ├─ browser/             ManagedBrowserProvider (plain puppeteer, installed Chrome) | CdpBrowserProvider (attach :9222, close→disconnect override)
  ├─ engine/              run-crawl.ts, challenge.ts (detection only), errors.ts (typed taxonomy)
  ├─ parser/              category-page.ts: extractCategoryRawInPage (in-browser) + normalizeCategoryItems (pure node)
  └─ adapters/            JsonFileOutputRepository, FsDebugArtifactStore, Static/NullProxyProvider, File/StaticSessionProvider
apps/cli/                 `pnpm crawl --config <file>` — exit codes 0/2/3/1
examples/                 adana-test.json (CDP live), fixture-offline-test.json (offline)
tests/                    unit + regression + e2e + meta (A8)
```

## Migration ledger (before → after → tests → known differences)

1. **Apify runtime → injected ports.** 10 `Actor.*` call sites → `OutputRepository` / `DebugArtifactStore` / `ProxyProvider` / `SessionProvider` / `RuntimeLogger` / `EventSink` / `CancellationToken`. Tests: no-apify meta, e2e. Diff: dataset is a single JSON array file per run (not Crawlee dataset shards); Crawlee local storage still used for request queue (`CRAWLEE_STORAGE_DIR`).
2. **Anti-bot machinery removed (legal boundary, ADR-0002).** Stealth plugin, fingerprint overrides, UA rotation + header forging, PX auto-hold, CF auto-wait, session pre-warm, `_throwOnBlockedRequest` monkey-patch — all deleted. Replacement: detection + typed errors + **human-in-the-loop** wait when the browser is visible. Diff: managed-headless mode against sahibinden.com will now fail fast with `RATE_LIMIT`/`AUTH_REQUIRED` instead of attempting bypass — intended; CDP mode is the reference local runtime (ADR-0006).
3. **Silent data-loss holes fixed (audit §5).** Zero-row category page → `PARSER_CHANGED` (was: silent success); `failedRequestHandler` records into `result.errors` (was: log-only). Test: e2e zero-row case.
4. **Extraction split for testability.** Browser-side raw extraction (`innerText` semantics preserved) + node-side pure normalization. Same selectors, same output. Test: fixture-parse against sanitized real HTML (50 rows).
5. **DETAIL route fails loudly.** `UNSUPPORTED_LABEL` (upstream silently ran the category handler on detail URLs). Detail handler lands in Phase 3.
6. **Request-handler timeout vs human-solve race fixed** (audit §14.10): handler timeout = max(config, humanTimeout + 60s).
7. **SSRF policy added** (upstream had none): start URLs and pagination constrained to `allowedDomains`. Test: e2e off-domain rejection.
8. **Dependency hygiene:** puppeteer pinned `^24`, lockfile committed, no `latest`/`*` pins.

## Known differences / deferred

- `maxItems` overshoot race under concurrency (audit §14.9) preserved — acceptable for Phase 1; hard cap lands with the worker phase.
- Crawlee session pool still active in CDP mode (harmless; ARCHITECTURE §4.3 forces single sticky session when SessionPolicy arrives in Phase 5).
- BaseRow adapter not ported — replaced by local persistence in Phase 4 (audit §8.3: mostly-dead sink).
- Upstream `src/` remains in-repo as reference only; retired from the runtime path. Removal scheduled after Phase 3 parity sign-off.

## Live verification

2026-09-14 ~19:34 local: `pnpm crawl --config ./examples/adana-test.json` (CDP attach, real sahibinden.com) → **SUCCEEDED, 50/50 listings, 13.4s, zero challenges, zero Apify.**
