# SahibindenBot3 — Target Architecture

**Status:** Target design for the de-Apify migration (local-first rewrite of `tyegen/sahibinden-emlak-scraper`)
**Audience:** Implementation agents and engineers executing the 15-phase migration
**Source of truth conflict rule:** if implementation reality diverges from this document, update this document in the same PR.

---

## 0. Purpose, Scope and Hard Constraints

SahibindenBot3 is a **local-first, self-hosted** real-estate crawling and intelligence application for sahibinden.com. It replaces the upstream Apify Actor with a pnpm monorepo containing three deployable apps (`api`, `worker`, `web`) and five shared packages. It runs entirely on one Docker host via Docker Compose. No Kubernetes, no cloud dependencies, no microservices beyond the `api` / `worker` / `web` split.

### 0.1 Non-negotiable tech baseline

| Layer | Choice |
|---|---|
| Runtime | Node.js LTS (22.x), TypeScript 5.x strict, ESM |
| Package manager | pnpm 9.x workspaces |
| Frontend | Next.js (App Router) + Tailwind CSS + shadcn/ui |
| Backend | Fastify 5 + Zod |
| Scraper | Crawlee (`PuppeteerCrawler`) + Puppeteer (vanilla, **no** puppeteer-extra) |
| Database | PostgreSQL 16 + Prisma 5 |
| Queue | Redis 7 + BullMQ 5 |
| Logging | Pino |
| Live logs | Server-Sent Events (SSE) |
| Tests | Vitest (unit/integration), Playwright (app E2E) |
| Deploy | Docker Compose (`postgres`, `redis`, `api`, `worker`, `web`) |

### 0.2 Legal / compliance boundary (binding for all components)

**FORBIDDEN** — must not be implemented, re-introduced, or enabled via config:

- Automated solving of CAPTCHA / Cloudflare Turnstile / PerimeterX challenges (including the upstream "press-and-hold" auto-clicker `tryHoldPxButton`).
- Browser fingerprint spoofing intended to defeat access controls (including `puppeteer-extra-plugin-stealth` and the upstream `evaluateOnNewDocument` navigator/WebGL/screen overrides).
- Credential theft or use of credentials not explicitly supplied by the operating user.
- Defeating "reveal phone number" (or similar click-to-reveal) mechanisms. Phone numbers are stored **only** when present in the initially rendered page without any reveal interaction.

**ALLOWED:**

- User-supplied proxies and normal proxy rotation.
- Authorized, user-supplied cookies; session persistence.
- Rate limiting, retries with backoff, session health tracking.
- Normal browser automation (navigate, read DOM, paginate) in a managed browser **or** attached to the user's own real Chrome via CDP, where the human user solves any challenge manually in their own browser.

### 0.3 Proven operational fact driving browser design

Production testing (2026-09-14) established that sahibinden.com is protected by Cloudflare + PerimeterX; datacenter and residential proxies with automation-browser fingerprints get challenged. The only 100% reliable local method was **attaching via CDP to the user's real Chrome** (launched with `--remote-debugging-port=9222` and a dedicated profile directory), using authorized user-supplied cookies and **one manual human challenge solve** (see `scrape-real-chrome.mjs` in the repo root for the proof of concept). The architecture therefore defines **two browser acquisition modes behind one `BrowserProvider` interface** (§3.4).

---

## 1. System Overview

```
                                 Docker host (single machine, docker compose)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │                                                                                      │
 │   :3000                                                                             │
 │ ┌───────────┐   HTTP(S)   ┌─────────────┐   REST /api/v1 (loopback)                  │
 │ │   User    ├────────────►│  apps/web   ├───────────────┐                             │
 │ │ (browser) │◄────────────┤  (Next.js)  │               │                             │
 │ └───────────┘  HTML/SSR   └─────────────┘               ▼                             │
 │      ▲            ▲                         ┌────────────────────┐                    │
 │      │            └──── SSE (run events) ───│      apps/api      │                    │
 │      │                 via web proxy        │     (Fastify)      │                    │
 │      │                                      │ REST · Zod · SSE   │                    │
 │      │                                      └──┬─────────────┬───┘                    │
 │      │                                         │Prisma/SQL   │BullMQ commands         │
 │      │                                         │             │+ pub/sub subscribe     │
 │      │                                         ▼             ▼                        │
 │      │                                  ┌────────────┐  ┌─────────────┐               │
 │      │                                  │ PostgreSQL │  │    Redis    │               │
 │      │                                  │   :5432    │  │    :6379    │               │
 │      │                                  └─────▲──────┘  └──┬───────▲──┘               │
 │      │                                        │Prisma      │jobs   │pub/sub           │
 │      │                                        │repos       │       │run-events        │
 │      │                                        │            ▼       │                  │
 │      │                                        │      ┌────────────────────┐           │
 │      │                                        └──────│     apps/worker    │           │
 │      │                                              │ BullMQ + Crawlee   │           │
 │      │                                              │ (scraper-engine)   │           │
 │      │                                              └─────────┬──────────┘           │
 │      │                                                        │                      │
 └──────┼────────────────────────────────────────────────────────┼──────────────────────┘
        │                                                        │
        │                              managed mode: launch      │      cdp mode: attach to
        │                              local Chromium            │      user-launched real
        │                                                        │      Chrome (:9222)
        │                                                        ▼
        │                                            ┌────────────────────────┐
        │                                            │  User's real Chrome    │◄── user solves any
        │                                            │  (dedicated profile,   │    challenge ONCE,
        │                                            │   --remote-debugging-  │    manually, in their
        │                                            │   port=9222)           │    own browser
        │                                            └───────────┬────────────┘
        │                                                        │
        │        HTTP(S) — direct, or via user-supplied proxy (managed mode only)
        │                                                        ▼
        │                                            ┌────────────────────────┐
        └───────────────────────────────────────────►│     sahibinden.com     │
             (no traffic from the UI browser;        │  (Cloudflare +         │
              arrow shows crawl target only)         │   PerimeterX protected)│
                                                     └────────────────────────┘
```

**Data flow:** `web → api → postgres/redis ← worker → sahibinden.com`. **Live channel:** `worker → Redis pub/sub → api → SSE → web`.

- `apps/web` never talks to Postgres/Redis directly; it proxies `/api/*` to `apps/api`.
- `apps/api` is the only writer of run-control commands; `apps/worker` is the only process that opens browsers and the only writer of crawl results.
- Postgres is the **source of truth** for all run state; Redis is transport (queues, locks, pub/sub) only.

---

## 2. Monorepo Layout

```
SahibindenBot3/
├── package.json                    # private root, workspace scripts only
├── pnpm-workspace.yaml
├── tsconfig.base.json              # strict TS, project references
├── docker-compose.yml
├── .env.example
├── apps/
│   ├── api/                        # @sahibinden/api      — Fastify REST + SSE
│   ├── worker/                     # @sahibinden/worker   — BullMQ consumer + scheduler + crawler host
│   └── web/                        # @sahibinden/web      — Next.js + Tailwind + shadcn/ui
├── packages/
│   ├── scraper-engine/             # @sahibinden/scraper-engine     — site-agnostic crawl runtime
│   ├── parser-sahibinden/          # @sahibinden/parser-sahibinden  — sahibinden selectors + pure parsers
│   ├── database/                   # @sahibinden/database           — Prisma schema, client, repositories
│   ├── shared/                     # @sahibinden/shared             — types, events, errors, logger, crypto, contracts
│   └── config/                     # @sahibinden/config             — env loading + validation
└── docs/
    ├── ARCHITECTURE.md
    └── adr/
```

### 2.1 Package responsibilities and public APIs

| Package | Responsibility | Public API (entry point exports) | May depend on |
|---|---|---|---|
| `@sahibinden/shared` | Framework-free domain types, event names/payloads, error taxonomy, Pino logger factory, secret crypto primitives, Zod API contracts | `types/` (`CrawlConfig`, `CrawlResult`, `CategoryListing`, `DetailListing`, `ClassifiedError`, DTOs), `events/` (`RUN_EVENT_TYPES`, payload interfaces, `buildRunEvent()`), `errors/` (`CrawlErrorCode`, `CrawlError`), `logger/` (`createLogger(service)`), `crypto/` (`createSecretBox(key)`), `contracts/` (Zod request/response schemas) | — (no workspace deps) |
| `@sahibinden/config` | Single validated env/config object | `loadConfig(): AppConfig` (Zod-validated: `DATABASE_URL`, `REDIS_URL`, `APP_SECRET_KEY`, `APP_URL`, ports, `ARTIFACTS_DIR`, `LOG_LEVEL`, optional `CHROME_CDP_URL`, `CHROME_EXECUTABLE_PATH`) | `shared` |
| `@sahibinden/parser-sahibinden` | Pure, fixture-testable sahibinden parsing. HTML in → typed data + diagnostics out. Owns the versioned selector registry. No browser, no I/O. | `parseCategoryPage(html, url): CategoryPageParse`, `parseDetailPage(html, url): DetailPageParse`, `detectPageState(html, url): PageState` (`OK`/`CHALLENGE`/`LOGIN_REDIRECT`/`EMPTY_RESULTS`/`UNAVAILABLE_LISTING`/`UNKNOWN`), `SELECTORS` (versioned registry, §12), normalizers (`normalizePrice`, `normalizeCurrency`, `normalizeLocation`, `normalizeAttributes`, `classifySeller`, `normalizeCookies`) | `shared` |
| `@sahibinden/scraper-engine` | Site-agnostic crawl runtime: Crawlee `PuppeteerCrawler` wiring, browser acquisition (managed/CDP), request routing, retries/backoff, delays, cancellation, artifact capture, error classification. **Knows nothing about Postgres or sahibinden selectors** — parser and persistence are injected. | `runCrawl(config: CrawlConfig, deps: CrawlDeps): Promise<CrawlResult>`, `ManagedBrowserProvider`, `CdpBrowserProvider`, `InMemoryCancellationToken` (tests), `classifyError(err, ctx): CrawlErrorCode`, dep interfaces (`BrowserProvider`, `OutputRepository`, `DebugArtifactStore`, `ProxyProvider`, `SessionProvider`, `CrawlLogger`, `CancellationToken`, `EventSink`, `PageParser`) | `shared`, `config` |
| `@sahibinden/database` | Prisma schema/migrations, client singleton, repositories. Only package that imports `@prisma/client`. | `prisma` (singleton), `ListingRepository`, `ScanDefinitionRepository`, `ScanRunRepository`, `ScanRunEventRepository`, `ProxyRepository`, `CookieProfileRepository`, `SessionPolicyRepository`, `SettingsRepository` | `shared`, `config` |
| `@sahibinden/api` | HTTP edge. REST routes, Zod validation, SSE broker, dashboard aggregates, artifact file serving, health. **Never imports `scraper-engine` or `parser-sahibinden`.** | Fastify plugin per route domain (§7) | `shared`, `config`, `database` |
| `@sahibinden/worker` | Composition root for crawling. BullMQ workers (`crawl-queue`, `maintenance-queue`), cron dispatcher, cancellation token impl (Redis), event sink impl (Postgres + pub/sub), artifact store impl (fs), proxy/session providers impl (DB-backed), graceful shutdown. | `startWorker(): Promise<WorkerHandle>` | `shared`, `config`, `database`, `scraper-engine`, `parser-sahibinden` |
| `@sahibinden/web` | UI only. Talks REST + SSE to `api`. Imports **type-only** contracts from `shared`. | Next.js app | `shared` (type-only) |

### 2.2 Allowed dependency directions (enforced)

```
shared ◄── config
shared ◄── parser-sahibinden
shared ◄── database ◄── api
shared ◄── scraper-engine ◄── worker
config, database, parser-sahibinden ◄── worker
shared (type-only) ◄── web
```

Hard rules (enforce with `eslint-plugin-boundaries` or `dependency-cruiser` in CI):

1. `scraper-engine` **must not** import `database`, `parser-sahibinden`, `api`, or `worker`. The worker wires the parser and repositories into the engine via `CrawlDeps`.
2. `database` **must not** import `scraper-engine` or `parser-sahibinden`.
3. `api` **must not** import `scraper-engine`, `parser-sahibinden`, or `worker`.
4. `shared` and `config` import nothing from the workspace.
5. `web` imports only types from `shared` (erased at compile time).
6. Only `database` imports `@prisma/client`; only `worker` imports `puppeteer`/`crawlee` (via `scraper-engine`); only `api` imports `fastify`.

---

## 3. Scraper Engine Boundary

The engine is a pure runtime: it receives a fully-resolved, immutable `CrawlConfig` and a set of injected dependencies, and returns a typed `CrawlResult`. It performs **no** direct DB access and **no** env reads.

### 3.1 Entry signature

```ts
// packages/scraper-engine/src/index.ts
export async function runCrawl(config: CrawlConfig, deps: CrawlDeps): Promise<CrawlResult>;
```

```ts
// packages/shared/src/types/crawl.ts
export interface CrawlConfig {
  runId: string;
  scanDefinitionId: string;
  startUrls: string[];                     // resolved from snapshot
  maxItems: number | null;                 // caps DISCOVERED listings (detail requests are derived, not separately capped)
  maxPages: number | null;                 // caps CATEGORY pages
  includeDetails: boolean;
  incrementalMode: boolean;                // stop paginating a category when a full page of already-known listings is hit
  maxConcurrency: number;
  navigationTimeoutSeconds: number;
  requestHandlerTimeoutSeconds: number;
  maxRequestRetries: number;
  delayMinMs: number;                      // polite random delay between page loads
  delayMaxMs: number;
  debugMode: boolean;
  storeRawHtml: boolean;
  storeScreenshotsOnFailure: boolean;
  browserMode: 'MANAGED' | 'CDP';
  cdpEndpointUrl: string | null;           // e.g. http://host.docker.internal:9222 — required when browserMode = 'CDP'
  proxyProfileId: string | null;           // applied in MANAGED mode only (see §3.4 note)
  cookieProfileId: string | null;
  sessionPolicyId: string | null;
  timezone: string;                        // default 'Europe/Istanbul'
}

export interface CrawlResult {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  counters: CrawlCounters;                 // mirrors ScanRun counter columns (§5)
  errors: ClassifiedError[];               // top-level run errors, classified (§8)
  startedAt: string;                       // ISO 8601
  finishedAt: string;
  durationMs: number;
}

export interface CrawlCounters {
  pagesVisited: number;
  categoryPagesVisited: number;
  detailPagesVisited: number;
  itemsDiscovered: number;
  itemsInserted: number;
  itemsUpdated: number;
  pricesChanged: number;
  failedRequests: number;
  retryCount: number;
}

export interface ClassifiedError {
  code: CrawlErrorCode;                    // §8
  message: string;                         // redacted — never contains secrets
  url?: string;
  label?: RequestLabel;
  statusCode?: number;
}
```

### 3.2 Injected dependencies (`CrawlDeps`)

```ts
// packages/scraper-engine/src/deps.ts
export interface CrawlDeps {
  output: OutputRepository;        // persistence boundary (implemented by worker over @sahibinden/database)
  artifacts: DebugArtifactStore;   // debug HTML/screenshot capture
  proxies: ProxyProvider;          // endpoint selection + health reporting
  sessions: SessionProvider;       // cookie profile material + session lifecycle
  logger: CrawlLogger;             // pino child, pre-bound { runId, scanDefinitionId }
  browser: BrowserProvider;        // managed-launch vs CDP-attach (§3.4)
  cancellation: CancellationToken; // cooperative cancel
  events: EventSink;               // run event emission (§9)
  parser: PageParser;              // sahibinden parser injected by worker
}

export interface OutputRepository {
  saveListing(item: CategoryListing | DetailListing, ctx: { runId: string }):
    Promise<{ listingId: string; changeType: 'INSERTED' | 'UPDATED' | 'PRICE_CHANGED' | 'UNCHANGED' }>;
  markSeen(sourceListingId: string, ctx: { runId: string }): Promise<void>;
}

export interface DebugArtifactStore {
  saveHtml(runId: string, label: string, html: string): Promise<string>;      // returns artifact path
  saveScreenshot(runId: string, label: string, png: Buffer): Promise<string>;
}

export interface ProxyProvider {
  acquire(ctx: { sessionId?: string }): Promise<ProxyLease | null>;           // null = direct connection
  reportSuccess(endpointId: string, latencyMs: number): Promise<void>;
  reportFailure(endpointId: string, code: CrawlErrorCode): Promise<void>;
}

export interface SessionProvider {
  getCookieMaterial(): Promise<NormalizedCookie[]>;  // decrypted user-supplied cookies, normalized
  onSessionRetired(sessionId: string, reason: string): Promise<void>;
}

export interface CrawlLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  throwIfCancelled(): void;                 // throws CrawlError { code: 'CANCELLED' }
  onCancel(cb: () => void): void;
}

export interface EventSink {
  emit(event: RunEventInput): Promise<void>; // §9; worker impl persists then publishes
}

export interface PageParser {
  parseCategoryPage(html: string, url: string): CategoryPageParse;
  parseDetailPage(html: string, url: string): DetailPageParse;
  detectPageState(html: string, url: string): PageState;
}
```

### 3.3 CATEGORY / DETAIL routing contract

- Every enqueued request carries `request.userData.label: 'CATEGORY' | 'DETAIL'` (type `RequestLabel`).
- Start URLs are labeled by URL shape: contains `/ilan/` **and** `/detay` → `DETAIL`, else `CATEGORY` (same rule as upstream).
- Category handlers enqueue: next category page (`label: 'CATEGORY'`) and, when `includeDetails`, each discovered listing URL (`label: 'DETAIL'`, `userData.sourceUrl` = category page URL for Referer).
- The engine's router is exhaustive: an unknown/missing label throws `UnsupportedLabelError extends CrawlError { code: 'UNKNOWN' }` naming the offending label and URL. **Silent fallback to CATEGORY is forbidden** (upstream's `|| 'CATEGORY'` default is removed).
- `maxPages` caps CATEGORY requests; `maxItems` caps discovered listings; reaching either aborts remaining pagination but lets in-flight detail pages finish (then run ends `SUCCEEDED` or `PARTIAL` per §8 rules).

### 3.4 BrowserProvider — two acquisition modes, one interface

```ts
export interface BrowserProvider {
  readonly mode: 'MANAGED' | 'CDP';
  acquire(): Promise<BrowserHandle>;          // MANAGED: puppeteer.launch; CDP: puppeteer.connect({ browserURL })
  release(handle: BrowserHandle): Promise<void>; // MANAGED: browser.close(); CDP: browser.disconnect() ONLY
}
```

| | `ManagedBrowserProvider` | `CdpBrowserProvider` |
|---|---|---|
| How | `puppeteer.launch({ executablePath, headless, args })` — vanilla puppeteer, **no stealth plugin, no fingerprint overrides** | `puppeteer.connect({ browserURL: config.cdpEndpointUrl, defaultViewport: null })` |
| Browser lifecycle | Owned by worker; closed on release | Owned by **user**; worker only disconnects. Never `browser.close()`, never kill the process. |
| Challenge handling | Detected via `parser.detectPageState` → request fails with `AUTH_REQUIRED`/`RATE_LIMIT` after retries; **no auto-solve** | Detected → engine pauses and emits `AUTH_REQUIRED` event with "solve in your browser" instruction, polls until cleared (human-in-the-loop), else times out per `navigationTimeoutSeconds` |
| Cookies | Injected once per session from `SessionProvider` | Injected once at attach time from `SessionProvider` |
| Proxy | `proxyProfileId` honored (per-endpoint `--proxy-server` on launch, or per-page auth) | **Ignored** — an already-running Chrome uses the user's own network stack. Engine emits a warning event if a proxy profile is set in CDP mode. |
| Session pool | Crawlee `SessionPool` per `SessionPolicy` | Effectively single sticky session (`poolSize` forced to 1) — one real profile exists |
| Use case | Unprotected/low-protection targets, CI, tests | sahibinden.com production crawling (proven reliable path) |

Both modes use **normal browser automation only**: navigate, wait, read DOM, paginate. No `evaluateOnNewDocument` fingerprint patches, no header spoofing beyond a stable user agent per session, no challenge auto-solving (§0.2).

---

## 4. Configuration Model

### 4.1 `ScanDefinition` — full field list

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid PK | — | |
| `name` | string | — | required, unique per workspace |
| `description` | string? | null | |
| `enabled` | boolean | true | disabled definitions are never scheduled and cannot be started |
| `startUrls` | string[] (Json) | — | ≥1 URL; each labeled CATEGORY/DETAIL by URL shape |
| `schedule` | string (cron)? | null | 5-field cron, evaluated in `timezone`; null = manual only |
| `timezone` | string | `Europe/Istanbul` | IANA name |
| `maxItems` | int? | null | null = unlimited |
| `maxPages` | int? | null | null = unlimited |
| `includeDetails` | boolean | false | enqueue DETAIL requests for discovered listings |
| `incrementalMode` | boolean | false | stop paginating when a full page of known listings is hit (see §4.3) |
| `maxConcurrency` | int | 3 | 1–10 |
| `navigationTimeoutSeconds` | int | 90 | |
| `requestHandlerTimeoutSeconds` | int | 180 | |
| `maxRequestRetries` | int | 8 | |
| `delayMinMs` | int | 2000 | polite delay floor |
| `delayMaxMs` | int | 5000 | polite delay ceiling |
| `proxyProfileId` | FK → ProxyProfile? | null | MANAGED mode only |
| `cookieProfileId` | FK → CookieProfile? | null | |
| `sessionPolicyId` | FK → SessionPolicy? | null | null → workspace default policy |
| `debugMode` | boolean | false | capture HTML+screenshot on anomalies |
| `storeRawHtml` | boolean | false | store raw HTML for every parsed page |
| `storeScreenshotsOnFailure` | boolean | true | |
| `staleDetectionEnabled` | boolean | true | |
| `staleAfterSuccessfulRuns` | int | 3 | N consecutive successful runs missing the listing → STALE |
| `createdAt` / `updatedAt` | timestamp | — | |

### 4.2 Per-run `configurationSnapshot` semantics

- When a run is enqueued (manual, scheduled, test, or retry), the API **deep-copies** every execution-relevant field of the definition — plus the referenced `proxyProfileId` / `cookieProfileId` / `sessionPolicyId` and the effective `browserMode`/`cdpEndpointUrl` — into `ScanRun.configurationSnapshot` (Json).
- The worker builds `CrawlConfig` **exclusively from the snapshot**, never from the live definition row. **Runs never mutate when the definition changes mid-run or between queue and start.**
- Secret material is captured **by reference** (profile ids), resolved and decrypted by the worker at run start; secret values never enter the snapshot.
- Retry of a run reuses the original snapshot (retry = "same config, new attempt"), not the current definition.

### 4.3 Interaction rules (explicit, to resolve spec tensions)

- `incrementalMode = true` runs are **excluded from stale detection** (early stop makes absence data unreliable). Only non-incremental `SUCCEEDED` runs count toward `staleAfterSuccessfulRuns`.
- `maxItems` counts **discovered listings**, not requests; detail requests derived from discovered listings are not separately capped (bounded by `maxItems`).
- In CDP browser mode, `proxyProfileId` is ignored (warning event emitted) and session pooling collapses to one sticky session (§3.4).

---

## 5. Data Model (Prisma-level)

Schema lives in `packages/database/prisma/schema.prisma`. All models have `createdAt`/`updatedAt` unless noted. Money is `Decimal @db.Decimal(14,2)`; ids are `String @id @default(uuid())` unless noted.

```prisma
enum ListingStatus   { ACTIVE STALE REMOVED }   // REMOVED only on explicit site signal ("yayından kaldırıldı"), never on absence
enum SellerType      { OWNER REAL_ESTATE_OFFICE CONSTRUCTION_COMPANY OTHER UNKNOWN }
enum ScanRunStatus   { QUEUED STARTING RUNNING CANCELLING CANCELLED SUCCEEDED PARTIAL FAILED }
enum ScanRunTrigger  { MANUAL SCHEDULED TEST RETRY }
enum ProxyStrategy   { ROUND_ROBIN SESSION_STICKY }
enum ProxyHealth     { UNKNOWN HEALTHY DEGRADED UNHEALTHY DISABLED }
enum ProxyAffinity   { NONE PER_SESSION }
enum CookieValidationStatus { UNVALIDATED VALID EXPIRED INVALID }
enum RunListingChangeType   { DISCOVERED INSERTED UPDATED PRICE_CHANGED UNCHANGED }

model Listing {
  id                       String        @id @default(uuid())
  source                   String        @default("sahibinden")
  sourceListingId          String                            // data-id attribute / id from URL
  url                      String
  title                    String
  status                   ListingStatus @default(ACTIVE)
  priceAmount              Decimal?      @db.Decimal(14, 2)
  priceCurrency            String?                           // ISO-ish: TRY, USD, EUR, GBP
  priceRaw                 String?                           // as displayed, e.g. "4.750.000 TL"
  pricePerSqmRaw           String?
  areaRaw                  String?
  roomCountRaw             String?
  locationText             String?                           // "İstanbul / Kadıköy / Moda"
  city                     String?
  district                 String?
  neighborhood             String?
  listedAtRaw              String?                           // date text as shown on site
  coverImageUrl            String?
  sellerId                 String?
  seller                   Seller?       @relation(fields: [sellerId], references: [id])
  firstSeenAt              DateTime
  lastSeenAt               DateTime
  firstSeenRunId           String
  lastSeenRunId            String
  lastPriceChangedAt       DateTime?
  detailFetchedAt          DateTime?                         // null = category-row data only
  missedSuccessfulRunCount Int           @default(0)         // informational cache; §5.1 rule lives in maintenance job
  staleAt                  DateTime?
  images                   ListingImage[]
  attributes               ListingAttribute[]
  priceHistory             ListingPriceHistory[]
  seenHistory              ListingSeenHistory[]
  runListings              ScanRunListing[]

  @@unique([source, sourceListingId])
  @@index([status, lastSeenAt])
  @@index([city, district])
  @@index([priceAmount])
}

model ListingImage {
  id          String   @id @default(uuid())
  listingId   String
  listing     Listing  @relation(fields: [listingId], references: [id], onDelete: Cascade)
  url         String
  position    Int      @default(0)
  firstSeenAt DateTime
  lastSeenAt  DateTime
  @@unique([listingId, url])
}

model ListingAttribute {
  id        String  @id @default(uuid())
  listingId String
  listing   Listing @relation(fields: [listingId], references: [id], onDelete: Cascade)
  key       String                     // normalized Turkish label, e.g. "Oda Sayısı", "m² (Brüt)"
  value     String
  source    String                     // 'CATEGORY' | 'DETAIL'
  @@unique([listingId, key, source])
  @@index([key])
}

model ListingPriceHistory {
  id            String   @id @default(uuid())
  listingId     String
  listing       Listing  @relation(fields: [listingId], references: [id], onDelete: Cascade)
  runId         String
  priceAmount   Decimal  @db.Decimal(14, 2)
  priceCurrency String
  priceRaw      String?
  changedAt     DateTime @default(now())
  @@index([listingId, changedAt])
}

model ListingSeenHistory {             // append-only sighting log (timelines, stale recomputation)
  id        BigInt   @id @default(autoincrement())
  listingId String
  listing   Listing  @relation(fields: [listingId], references: [id], onDelete: Cascade)
  runId     String
  seenAt    DateTime @default(now())
  @@index([listingId, seenAt])
  @@index([runId])
}

model Seller {
  id             String     @id @default(uuid())
  sellerKey      String     @unique    // normalized-name hash for cross-listing dedupe
  name           String
  type           SellerType @default(UNKNOWN)
  typeEvidence   String?               // matched on-page phrase, e.g. "Emlak Ofisinden"
  typeConfidence Float?                // 0.0–1.0, from classifySeller()
  profileUrl     String?
  phone          String?               // ONLY if visible in initial HTML; reveal interactions are forbidden (§0.2)
  firstSeenAt    DateTime
  lastSeenAt     DateTime
  listings       Listing[]
}

model ScanDefinition {
  id                          String    @id @default(uuid())
  name                        String    @unique
  description                 String?
  enabled                     Boolean   @default(true)
  startUrls                   Json                             // string[]
  schedule                    String?                          // cron, in `timezone`
  timezone                    String    @default("Europe/Istanbul")
  maxItems                    Int?
  maxPages                    Int?
  includeDetails              Boolean   @default(false)
  incrementalMode             Boolean   @default(false)
  maxConcurrency              Int       @default(3)
  navigationTimeoutSeconds    Int       @default(90)
  requestHandlerTimeoutSeconds Int      @default(180)
  maxRequestRetries           Int       @default(8)
  delayMinMs                  Int       @default(2000)
  delayMaxMs                  Int       @default(5000)
  proxyProfileId              String?
  proxyProfile                ProxyProfile?  @relation(fields: [proxyProfileId], references: [id])
  cookieProfileId             String?
  cookieProfile               CookieProfile? @relation(fields: [cookieProfileId], references: [id])
  sessionPolicyId             String?
  sessionPolicy               SessionPolicy? @relation(fields: [sessionPolicyId], references: [id])
  debugMode                   Boolean   @default(false)
  storeRawHtml                Boolean   @default(false)
  storeScreenshotsOnFailure   Boolean   @default(true)
  staleDetectionEnabled       Boolean   @default(true)
  staleAfterSuccessfulRuns    Int       @default(3)
  lastScheduledAt             DateTime?                      // dispatcher double-fire guard
  runs                        ScanRun[]
}

model ScanRun {
  id                     String         @id @default(uuid())
  scanDefinitionId       String
  scanDefinition         ScanDefinition @relation(fields: [scanDefinitionId], references: [id])
  triggerType            ScanRunTrigger
  status                 ScanRunStatus  @default(QUEUED)
  configurationSnapshot  Json                          // §4.2 — immutable execution config
  queuedAt               DateTime       @default(now())
  startedAt              DateTime?
  finishedAt             DateTime?
  durationMs             Int?
  heartbeatAt            DateTime?                     // worker updates every 15s while RUNNING
  workerId               String?                       // hostname/pid of owning worker
  bullmqJobId            String?
  pagesVisited           Int @default(0)
  categoryPagesVisited   Int @default(0)
  detailPagesVisited     Int @default(0)
  itemsDiscovered        Int @default(0)
  itemsInserted          Int @default(0)
  itemsUpdated           Int @default(0)
  pricesChanged          Int @default(0)
  failedRequests         Int @default(0)
  retryCount             Int @default(0)
  errorCode              String?                       // CrawlErrorCode of fatal error, if any
  errorSummary           String?                       // redacted, human-readable
  events                 ScanRunEvent[]
  runListings            ScanRunListing[]
  @@index([scanDefinitionId, status])
  @@index([status, heartbeatAt])
  @@index([queuedAt])
}

model ScanRunEvent {
  id        BigInt   @id @default(autoincrement())     // doubles as ordering seq
  runId     String
  type      String                                     // §9 event names
  payload   Json                                       // redacted per §9.3
  createdAt DateTime @default(now())
  @@index([runId, id])
}

model ScanRunListing {                                 // per-run change journal
  runId      String
  listingId  String
  listing    Listing  @relation(fields: [listingId], references: [id], onDelete: Cascade)
  changeType RunListingChangeType
  createdAt  DateTime @default(now())
  @@id([runId, listingId])
  @@index([listingId])
}

model ProxyProfile {
  id        String         @id @default(uuid())
  name      String         @unique
  strategy  ProxyStrategy  @default(ROUND_ROBIN)
  enabled   Boolean        @default(true)
  notes     String?
  endpoints ProxyEndpoint[]
  scanDefinitions ScanDefinition[]
}

model ProxyEndpoint {
  id                  String      @id @default(uuid())
  profileId           String
  profile             ProxyProfile @relation(fields: [profileId], references: [id], onDelete: Cascade)
  label               String?
  encryptedUrl        String                          // AES-256-GCM envelope (§10) — contains creds
  host                String                          // plaintext metadata for display/health
  port                Int
  protocol            String                          // 'http' | 'https' | 'socks5'
  health              ProxyHealth @default(UNKNOWN)
  successCount        Int         @default(0)
  failureCount        Int         @default(0)
  consecutiveFailures Int         @default(0)
  lastLatencyMs       Int?
  avgLatencyMs        Int?                            // rolling average (last 20 checks)
  lastCheckedAt       DateTime?
  lastUsedAt          DateTime?
  quarantinedUntil    DateTime?                       // skipped by ProxyProvider while in future
  disabledReason      String?
  @@index([profileId, health])
}

model CookieProfile {
  id                 String   @id @default(uuid())
  name               String   @unique
  encryptedCookieJson String                          // AES-256-GCM envelope of the cookie JSON array
  cookieCount        Int      @default(0)
  domainSummary      String?                          // e.g. ".sahibinden.com (28), .google.com (2)"
  expirySummary      Json?                            // { earliest, latest, sessionCookies }
  validationStatus   CookieValidationStatus @default(UNVALIDATED)
  lastValidatedAt    DateTime?
  notes              String?
  scanDefinitions    ScanDefinition[]
}

model SessionPolicy {
  id                       String        @id @default(uuid())
  name                     String        @unique
  poolSize                 Int           @default(10)
  maxUsageCount            Int           @default(50)
  maxAgeMinutes            Int           @default(60)
  persistCookiesPerSession Boolean       @default(true)
  proxyAffinity            ProxyAffinity @default(NONE)   // PER_SESSION = pin session to one endpoint
  retireOnNetworkFailures  Boolean       @default(true)
  failureThreshold         Int           @default(3)
  isDefault                Boolean       @default(false)
  scanDefinitions          ScanDefinition[]
}

model AppSetting {
  key       String   @id                 // e.g. 'browser.mode', 'browser.cdpUrl', 'scheduler.enabled',
  value     Json                         // 'artifacts.retentionDays', 'scheduler.tickSeconds'
  updatedAt DateTime @updatedAt
}
```

### 5.1 Listing staleness rule (normative)

A listing is **never** marked inactive/stale because of a single absence. The `stale-evaluation` maintenance job (and a backstop sweep) computes, per `ScanDefinition` with `staleDetectionEnabled`:

1. Take the definition's last `staleAfterSuccessfulRuns` runs with `status = SUCCEEDED` **and** `configurationSnapshot.incrementalMode = false`. If fewer than that exist, do nothing.
2. A listing previously seen by this definition (present in `ScanRunListing` for any of its runs) that appears in **none** of those runs' `ScanRunListing` rows → `status = STALE`, `staleAt = now()`, `missedSuccessfulRunCount` incremented.
3. A STALE listing re-seen → `status = ACTIVE`, `staleAt = null`, `missedSuccessfulRunCount = 0`, `lastSeenAt` updated (resurrection).
4. `REMOVED` is set **only** when a detail page explicitly signals unavailability (`detectPageState = UNAVAILABLE_LISTING`), never from absence.

---

## 6. Queue & Scheduler Design

### 6.1 Queues (BullMQ, connection from `REDIS_URL`)

| Queue | Jobs | Producer | Consumer |
|---|---|---|---|
| `crawl-queue` | `execute-run` `{ runId }`, jobId = `run:{runId}` (dedupes double-enqueue) | api (manual/test/retry), worker dispatcher (scheduled) | worker, concurrency `WORKER_CRAWL_CONCURRENCY` (default **1** — browser-heavy) |
| `maintenance-queue` | `schedule-dispatch`, `stale-run-sweeper`, `stale-evaluation`, `proxy-health-check`, `artifact-retention`, `cookie-expiry-check` | repeatable jobs registered by worker at boot | worker |

### 6.2 Run lifecycle

```
POST /scans/:id/runs ─► ScanRun(QUEUED, snapshot) ─► BullMQ execute-run
                                                          │
                                              worker picks job ─► status STARTING
                                                          │ browser acquire + session init
                                                          ▼
                                                       RUNNING (heartbeatAt every 15s)
                                                          │
              ┌───────────────┬───────────────────────────┼──────────────────────┐
              ▼               ▼                           ▼                      ▼
         all done       some requests               fatal error            cancel requested
              │          failed (≥1)                      │                (CANCELLING →
              ▼               ▼                           ▼                 cooperative stop)
         SUCCEEDED        PARTIAL                      FAILED                    CANCELLED
```

- **Same-definition concurrency lock:** before enqueue, api executes `SET lock:scan:{scanDefinitionId} {runId} NX EX 21600`. If the key exists → `409 Conflict { code: 'RUN_ALREADY_ACTIVE' }`. The worker deletes the lock in a `finally` after terminal status. (BullMQ jobId dedupes identical `runId`; the Redis lock serializes per definition.)
- **Manual / scheduled / test runs:** identical pipeline; `triggerType` differs. Test runs additionally force `maxItems ≤ 25`, `maxPages ≤ 2`, `debugMode = true` (overridden in the snapshot, definition untouched).
- **Cancellation flow:** `POST /runs/:id/cancel` → api sets `status = CANCELLING`, sets Redis key `run-control:{runId}:cancel = 1` (TTL 1h) and publishes on channel `run-control`. The worker's `CancellationToken` checks the key between page loads (≤2s granularity) and on pub/sub message → `crawler.autoscaledPool.abort()` → in-flight page finishes or times out → counters persisted → `status = CANCELLED`, lock released, `RUN_COMPLETED` emitted. Cancelling a `QUEUED` run removes the BullMQ job and goes straight to `CANCELLED`.
- **Stale RUNNING recovery (worker death):** BullMQ `stalledInterval: 30000`, `maxStalledCount: 0` (a re-run would duplicate side effects). The `stale-run-sweeper` maintenance job (every 60s) finds runs in `STARTING`/`RUNNING`/`CANCELLING` with `heartbeatAt < now() - 120s` → marks `FAILED` with `errorCode = UNKNOWN`, `errorSummary = 'worker heartbeat lost'`, releases the definition lock, emits `RUN_COMPLETED`. Operator retries manually (or auto-retry via future setting).
- **Scheduler:** `schedule-dispatch` repeatable job every 30s: for each `enabled` definition with `schedule`, compute due in the definition's `timezone` using `lastScheduledAt` as the double-fire guard; create run + enqueue. Missed windows while the worker was down are **not** backfilled (next tick only) — deliberate simplicity.

### 6.3 Graceful shutdown contract (worker)

On `SIGTERM` (Docker stop):

1. `worker.pause()` — stop fetching new jobs (both queues).
2. Active crawl run: trigger the same cooperative-cancel path as §6.2 with a **25s budget** — finish the current page, persist counters, set `CANCELLED` with `errorSummary = 'worker shutdown'`, release lock, emit `RUN_COMPLETED`.
3. Crawler teardown: close pages; `ManagedBrowserProvider` → `browser.close()`; `CdpBrowserProvider` → `disconnect()` only (**never** kill the user's Chrome).
4. `prisma.$disconnect()`.
5. BullMQ `worker.close()`, Redis `quit()`. Exit 0.
6. Second `SIGTERM`/`SIGKILL` (compose `stop_grace_period: 40s`) → immediate exit; sweeper cleans up.

API shutdown: stop accepting requests (`fastify.close()`), drain SSE clients, close Redis/Prisma.

---

## 7. API Surface (Fastify, REST)

Base path `/api/v1`. JSON everywhere except CSV export and SSE. Every route validates `body`/`query`/`params` with **Zod schemas from `packages/shared/src/contracts`** (single source shared with web forms). Error format is uniform:

```json
{ "error": { "code": "VALIDATION_ERROR | NOT_FOUND | CONFLICT | RUN_ALREADY_ACTIVE | INTERNAL", "message": "...", "details": {} } }
```

### 7.1 Scan definitions

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/scans` | list, `?enabled=&q=&page=&pageSize=` |
| POST | `/api/v1/scans` | create (full field validation, cron + timezone checked) |
| GET | `/api/v1/scans/:id` | detail incl. last run summary |
| PATCH | `/api/v1/scans/:id` | partial update; never touches existing runs (snapshot semantics) |
| DELETE | `/api/v1/scans/:id` | 409 while a run is active |

### 7.2 Run control

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/scans/:id/runs` | start; body `{ "type": "manual" \| "test" }`; creates snapshot, enforces definition lock → 409 `RUN_ALREADY_ACTIVE` |
| GET | `/api/v1/runs` | filter `?scanId=&status=&triggerType=&from=&to=&page=` |
| GET | `/api/v1/runs/:id` | status, counters, snapshot, errorSummary |
| POST | `/api/v1/runs/:id/cancel` | §6.2 flow |
| POST | `/api/v1/runs/:id/retry` | new run, **same snapshot**, `triggerType = RETRY` |
| GET | `/api/v1/runs/:id/events` | persisted events, paginated (`?after=<seq>`) |
| GET | `/api/v1/runs/:id/events/stream` | **SSE** live stream (§9.4) |
| GET | `/api/v1/runs/:id/listings` | join via `ScanRunListing`, `?changeType=` |
| GET | `/api/v1/runs/:id/artifacts/:file` | debug artifact download (path-traversal guarded; metadata lists only allowed names) |

### 7.3 Listings & export

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/listings` | `?q=&status=&city=&district=&sellerType=&minPrice=&maxPrice=&currency=&dateFrom=&dateTo=&hasPriceHistory=&page=&pageSize=&sort=` (`priceAmount`, `lastSeenAt`, `firstSeenAt`, `listedAtRaw`; prefix `-` for desc) |
| GET | `/api/v1/listings/:id` | detail incl. images, attributes, seller |
| GET | `/api/v1/listings/:id/history` | price history + seen history |
| GET | `/api/v1/listings/export` | `?format=csv` + same filters as list; streamed CSV, capped at 50k rows |

### 7.4 Proxies, cookies, session policies

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/v1/proxy-profiles` | list/create |
| GET/PATCH/DELETE | `/api/v1/proxy-profiles/:id` | |
| POST | `/api/v1/proxy-profiles/:id/endpoints` | body `{ label?, url }` — url encrypted before persist; response returns metadata only |
| PATCH/DELETE | `/api/v1/proxy-endpoints/:id` | |
| POST | `/api/v1/proxy-endpoints/:id/health-check` | synchronous single check |
| GET/POST | `/api/v1/cookie-profiles` | POST body `{ name, cookieJson, notes? }`; `cookieJson` validated, normalized, encrypted; **never returned again** |
| GET/PATCH/DELETE | `/api/v1/cookie-profiles/:id` | GET returns **metadata only**: `cookieCount`, `domainSummary`, `expirySummary`, `validationStatus`, `lastValidatedAt` |
| POST | `/api/v1/cookie-profiles/:id/validate` | offline validation (shape + expiry), sets `validationStatus` |
| GET/POST | `/api/v1/session-policies` | |
| GET/PATCH/DELETE | `/api/v1/session-policies/:id` | one `isDefault` enforced |

### 7.5 Dashboard, settings, health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/dashboard/summary` | `{ activeListings, staleListings, runsToday, failedRunsToday, successRate7d, priceChanges24h, newListings24h, queueDepth, activeRuns }` |
| GET | `/api/v1/dashboard/run-stats?days=30` | per-day run counts by status (chart series) |
| GET/PATCH | `/api/v1/settings` | `AppSetting` keys (browser mode, cdpUrl, scheduler toggle, retention) |
| GET | `/health/live` | process up |
| GET | `/health/ready` | checks Postgres (`SELECT 1`) + Redis (`PING`); compose healthcheck uses this |

---

## 8. Error Taxonomy

`CrawlErrorCode` (defined in `packages/shared/src/errors`, used everywhere):

| Code | Meaning | Typical classification site |
|---|---|---|
| `NETWORK` | socket/DNS/connection reset | engine `classifyError` (crawlee/puppeteer errors) |
| `TIMEOUT` | navigation/handler timeout | engine `classifyError` |
| `AUTH_REQUIRED` | login redirect or challenge page detected and not cleared | engine via `parser.detectPageState` |
| `INVALID_PAGE` | unexpected page shape, no explicit empty marker, not a parser-signature change | engine via parser diagnostics |
| `PARSER_CHANGED` | all selector fallbacks failed, or required-field yield below threshold (§12) | parser diagnostics → engine |
| `PROXY_ERROR` | proxy connect/auth failure | engine → `ProxyProvider.reportFailure` |
| `RATE_LIMIT` | HTTP 429 / 403-throttled patterns | engine `classifyError` |
| `DATABASE` | persistence failure in `OutputRepository` | worker (wraps Prisma errors) |
| `CANCELLED` | cooperative cancellation | engine `CancellationToken` |
| `UNKNOWN` | anything else | fallback |

**Storage:** per-request failures → `ScanRunEvent` of type `REQUEST_FAILED` with `{ code, message(redacted), url, label, statusCode?, attempt }` and counter `failedRequests`/`retryCount`. Run-fatal errors → `ScanRun.errorCode` + `ScanRun.errorSummary`. **Run outcome rule:** `FAILED` = fatal error before any useful work or worker loss; `PARTIAL` = completed with ≥1 failed request; `SUCCEEDED` = zero failed requests; `CANCELLED` = user/shutdown stop.

---

## 9. Event Model

### 9.1 Types and payloads

`RunEventType` (in `packages/shared/src/events`). Every event: `{ type, runId, scanDefinitionId, at: ISO, payload }`; persistence assigns `seq = ScanRunEvent.id`.

| Event | Payload |
|---|---|
| `RUN_STARTED` | `{ triggerType, browserMode, startUrlCount, maxItems, maxPages, includeDetails }` |
| `CATEGORY_STARTED` | `{ url, pageNumber }` |
| `CATEGORY_PARSED` | `{ url, pageNumber, listingsFound, newListings, nextPageEnqueued, durationMs, selectorVersion }` |
| `LISTING_DISCOVERED` | `{ sourceListingId, url, title, priceAmount, priceCurrency, isNew }` |
| `DETAIL_STARTED` | `{ sourceListingId, url }` |
| `DETAIL_PARSED` | `{ sourceListingId, url, attributesCount, imagesCount, sellerType, durationMs, selectorVersion }` |
| `LISTING_INSERTED` | `{ listingId, sourceListingId }` |
| `LISTING_UPDATED` | `{ listingId, sourceListingId, changedFields: string[] }` |
| `PRICE_CHANGED` | `{ listingId, sourceListingId, oldPriceAmount, newPriceAmount, priceCurrency }` |
| `REQUEST_RETRY` | `{ url, label, attempt, maxRetries, errorCode }` |
| `REQUEST_FAILED` | `{ url, label, errorCode, message, statusCode? }` |
| `SESSION_RETIRED` | `{ sessionId, reason, usageCount }` |
| `PROXY_FAILURE` | `{ endpointId, host, errorCode }` |
| `RUN_COMPLETED` | `{ status, counters: CrawlCounters, durationMs, errorCode?, errorSummary? }` |

### 9.2 Transport

```
worker EventSink.emit()
   ├─ 1) INSERT INTO ScanRunEvent (transaction with counter update)   ← ordering + durability
   └─ 2) PUBLISH redis channel `run-events:{runId}` (serialized event incl. seq)
api SSE broker
   ├─ on client connect: replay ScanRunEvent WHERE runId = :id AND id > :lastEventId
   └─ SUBSCRIBE `run-events:{runId}` → forward as SSE `data:` frames (id: = seq)
```

Persist-then-publish guarantees no gaps: a client that misses pub/sub messages (reconnect) replays from Postgres via `Last-Event-ID`.

### 9.3 Redaction rules (hard)

Payloads are built from whitelisted field sets only. **Never** in any event/log/artifact: cookie names+values (cookie events carry `cookieProfileId` + `cookieCount` only), proxy URLs or credentials (`endpointId` + `host` only), `APP_SECRET_KEY`, request/response headers containing `Cookie`/`Authorization`. `packages/shared/src/logger` registers these keys as Pino redact paths; event builders live next to the whitelist types so adding a field is a conscious act.

---

## 10. Secrets Management

- **Algorithm:** AES-256-GCM. Key from env `APP_SECRET_KEY` — 32 bytes, base64-encoded (`openssl rand -base64 32`). Validated at boot by `packages/config`; missing/invalid key = fail fast.
- **Envelope format** (single text column): `v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>` — fresh random 12-byte IV per record, 16-byte auth tag. Implemented as `createSecretBox(key)` in `packages/shared/src/crypto` (pure; key injected by caller). Used for `CookieProfile.encryptedCookieJson` and `ProxyEndpoint.encryptedUrl`.
- **Write-only API:** secrets are accepted on create/update and **never returned** afterward — list/detail endpoints expose metadata only (§7.4). Decryption happens exclusively inside `worker` (cookies → `SessionProvider`; proxy URLs → `ProxyProvider`) and never crosses a process boundary in plaintext.
- **Redaction utility:** `redactSecrets(value)` in shared; applied in loggers, event builders, and error messages.
- **Key rotation:** decrypt-with-old → encrypt-with-new maintenance command (`pnpm -C packages/database rotate-secrets`); `v1` prefix allows future algorithm/version upgrades.
- **`.env.example` contract** (committed; real `.env` gitignored):

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sahibinden
REDIS_URL=redis://localhost:6379
APP_SECRET_KEY=                 # 32-byte base64 — openssl rand -base64 32
APP_URL=http://localhost:3000
API_PORT=3001
WORKER_HEALTH_PORT=3002
ARTIFACTS_DIR=./storage/artifacts
LOG_LEVEL=info
# Optional — CDP mode:
# CHROME_CDP_URL=http://host.docker.internal:9222
# CHROME_EXECUTABLE_PATH=/usr/bin/chromium   # MANAGED mode override
```

---

## 11. Observability

- **Structured logs:** Pino JSON, `LOG_LEVEL` env, base bindings `{ service: 'api'|'worker', version }`; child loggers bind `{ runId, scanDefinitionId }` inside runs and `{ reqId }` per HTTP request. Redact paths from §9.3 registered globally.
- **Run event stream:** the `ScanRunEvent` table + SSE stream *is* the primary run observability surface (§9); the web run-detail page renders it live.
- **Health checks:** api `/health/live`, `/health/ready` (DB+Redis); worker exposes `:3002/health` (BullMQ connection + active run id + uptime) used by the compose healthcheck; postgres `pg_isready`; redis `redis-cli ping`.
- **Debug artifacts:** written by `DebugArtifactStore` to `ARTIFACTS_DIR/{runId}/{seq}-{label}.{html,png}` (shared volume, served read-only by api). **Retention policy** (`artifact-retention` daily job): failure artifacts kept 14 days, `debugMode` artifacts 7 days, max 50 artifacts per run (oldest pruned first); `storeRawHtml` pages count toward the cap. Retention configurable via `AppSetting` `artifacts.retentionDays`.
- **Artifact content rules:** page HTML, screenshot PNG, page title, final URL, HTTP status, selector diagnostics. **NEVER** cookies, `localStorage`, or request headers containing `Cookie`/`Authorization` (upstream's cookie-dump debug logging is removed).

---

## 12. Selector Resilience

- **Versioned registry** at `packages/parser-sahibinden/src/selectors/index.ts`: every extraction target declares `primary` + ordered `fallbacks`, and the registry carries a semver-ish `registryVersion` (e.g. `2026.09.1`) stamped into parse results and `*_PARSED` events.

```ts
export const SELECTORS = {
  registryVersion: '2026.09.1',
  category: {
    listingRow:  { primary: 'tbody.searchResultsRowClass > tr.searchResultsItem',
                   fallbacks: ['table.searchResultsTable tr.searchResultsItem', 'tr.searchResultsItem'] },
    titleLink:   { primary: 'td.searchResultsTitleValue a.classifiedTitle', fallbacks: ['a.classifiedTitle'] },
    price:       { primary: 'td.searchResultsPriceValue span', fallbacks: ['td.searchResultsPriceValue'] },
    location:    { primary: 'td.searchResultsLocationValue', fallbacks: [] },
    nextPage:    { primary: 'a.prevNextBut[title="Sonraki"]:not(.passive)', fallbacks: ['a.prevNextBut:not(.passive)'] },
    emptyMarker: { primary: '.searchNoResult, .no-results', fallbacks: [] },  // explicit "no results" state
  },
  detail: { /* title, price, attributes table, gallery, seller block, unavailable marker … */ },
} as const;
```

- **Classification:** a required selector failing primary *and* all fallbacks → `PARSER_CHANGED`. Required-field yield below 50% of rows on a category page → `PARSER_CHANGED`. Zero listings **with** the explicit empty marker → legitimate empty page (success); zero listings **without** it → `INVALID_PAGE`. **No silent empty-success.**
- Fallback usage is logged (`warn`) and emitted in `CATEGORY_PARSED`/`DETAIL_PARSED` diagnostics so selector rot is visible before it breaks.
- Fixture tests pin every selector against recorded pages (§14); a site change fails CI with the exact registry key that rotted.

---

## 13. Docker Compose Topology

```yaml
# docker-compose.yml (shape — exact file produced in the hardening phase)
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_DB: sahibinden, POSTGRES_USER: postgres, POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres} }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, timeout: 3s, retries: 20 }
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes: [redisdata:/data]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, timeout: 3s, retries: 20 }
  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    env_file: .env
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_healthy } }
    ports: ["3001:3001"]
    volumes: [artifacts:/app/storage/artifacts]
    healthcheck: { test: ["CMD", "wget", "-qO-", "http://localhost:3001/health/ready"], interval: 10s, timeout: 5s, retries: 12 }
  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }   # installs Chromium + deps (libnss3, libatk1.0-0, libgbm1, fonts…)
    env_file: .env
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_healthy }, api: { condition: service_started } }
    volumes: [artifacts:/app/storage/artifacts]
    shm_size: 1gb                          # Chromium /dev/shm
    stop_grace_period: 40s                 # §6.3 shutdown budget
    extra_hosts: ["host.docker.internal:host-gateway"]   # reach user Chrome on the Docker host (CDP mode)
    healthcheck: { test: ["CMD", "wget", "-qO-", "http://localhost:3002/health"], interval: 15s, timeout: 5s, retries: 8 }
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    environment: { API_INTERNAL_URL: http://api:3001 }
    depends_on: { api: { condition: service_healthy } }
    ports: ["3000:3000"]
volumes: { pgdata: {}, redisdata: {}, artifacts: {} }
```

Rules: all app containers run **non-root** (`USER node` / uid 1001; worker's Chromium therefore launches with `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` — acceptable inside the container boundary); single internal bridge network, only `web` (3000) and optionally `api` (3001) publish ports; Postgres/Redis reachable only on the internal network; multi-stage builds (pnpm fetch → build → slim runtime); worker image pins a Chromium build matching the puppeteer version.

---

## 14. Testing Strategy Map

| Layer | Tool | Location | What |
|---|---|---|---|
| Parser fixtures | Vitest | `packages/parser-sahibinden/test/fixtures/` | HTML fixtures → golden parse output. **Required fixtures:** (1) category page, (2) normal detail, (3) detail with missing optional fields, (4) seller = real-estate office, (5) seller = individual owner, (6) detail with many attributes, (7) malformed listing row, (8) unavailable/removed listing. Plus challenge page + login-redirect fixtures for `detectPageState`. |
| Unit | Vitest | `packages/*/test/unit/` | price/currency parsing (`4.750.000 TL`, `$ 250,000`), location split (city/district/neighborhood), attribute normalization, seller classification evidence/confidence, cookie normalization (`key`→`name`, expiry filtering, sameSite mapping), proxy URL parsing/masking, cron-due evaluation, secret box round-trip, redaction. |
| Engine | Vitest | `packages/scraper-engine/test/` | `runCrawl` with fake `PageParser` + in-memory deps: routing contract (incl. `UnsupportedLabelError`), cancellation, retry classification, counter correctness, CDP-vs-managed provider behavior (mocked puppeteer). |
| DB integration | Vitest + Postgres (compose service or testcontainers) | `packages/database/test/` | migrations apply clean; unique `[source, sourceListingId]` upsert; price-history write only on change; stale-evaluation rule (§5.1) incl. resurrection and incremental-run exclusion. |
| Queue | Vitest + Redis | `apps/worker/test/` | duplicate-start protection (lock + jobId), retry flow reuses snapshot, cancel flow QUEUED→CANCELLED and RUNNING→CANCELLING→CANCELLED, sweeper marks heartbeat-lost runs FAILED, dispatcher double-fire guard. |
| API | Vitest + `fastify.inject` | `apps/api/test/` | every route: Zod rejection shapes, CRUD happy paths, run control 409 lock, cookie profile never returns secrets, CSV export, SSE replay with `Last-Event-ID`. |
| E2E (app) | Playwright | `apps/web/e2e/` | create definition → start test run (mocked worker or fixture-backed) → watch live events → listings appear → export CSV. |
| Live smoke | Vitest (gated) | `apps/worker/test-live/` | `pnpm test:live` — requires `LIVE_TEST=1` + `CHROME_CDP_URL=http://127.0.0.1:9222`; crawls ONE category page with `maxItems=5` against the real site via CDP; asserts ≥1 parsed listing. Manual/nightly only, **never in CI**. |

CI runs everything except `test:live`. Coverage gates: parser ≥90% lines; shared ≥85%.

---

## 15. Phasing Hook — Architecture ↔ 15-Phase Migration Map

| # | Phase | Architecture components delivered | Exit criteria |
|---|---|---|---|
| 1 | Audit | docs only (this file, ADRs) | upstream behaviors catalogued against §3/§12 |
| 2 | Baseline | monorepo skeleton (§2), config, shared, CI | `pnpm install && pnpm build` green |
| 3 | Fixtures | parser fixture corpus (§14) | 8+ fixtures recorded & loading |
| 4 | Abstractions | `CrawlDeps` interfaces, error taxonomy, event types (§3.2, §8, §9) | shared + engine types compile |
| 5 | De-Apify | engine without `apify` SDK / stealth / PX auto-hold (ADR-0002) | upstream logic ported behind deps |
| 6 | Local parity | `ManagedBrowserProvider`, in-memory deps, `runCrawl` green in tests | engine unit tests pass |
| 7 | Category/detail split | routing contract (§3.3), category parser | category fixtures green |
| 8 | Detail extraction | detail parser, seller classification (§5 `Seller`) | detail fixtures green |
| 9 | Persistence | Prisma schema (§5), repositories, `OutputRepository` impl | DB integration tests green |
| 10 | Orchestration | BullMQ queues, run lifecycle, cancellation, sweeper, shutdown (§6) | queue tests green |
| 11 | Proxy/session config | proxy profiles/endpoints, cookie profiles, session policies, secret box (§5, §10) | secret round-trip + provider tests green |
| 12 | Web UI | Next.js app: scans CRUD, run monitor, listings, settings (§7 consumers) | Playwright E2E happy path |
| 13 | Scheduling | cron dispatcher, timezone handling, test-run mode (§6.2) | scheduler tests green |
| 14 | Observability | SSE stream, dashboard aggregates, artifact store + retention, health endpoints (§7.5, §9, §11) | live run visible in UI; healthchecks green |
| 15 | Hardening | Docker Compose (§13), non-root images, `test:live`, coverage gates, docs finalization | `docker compose up` full system; live smoke passes via CDP |

---

## Appendix A — Naming & conventions

- All DB tables snake_case via Prisma `@@map` optional; TypeScript fields camelCase exactly as in §5.
- Event names SCREAMING_SNAKE; route paths kebab-case plural nouns; Redis keys `lock:scan:{id}`, `run-control:{runId}:cancel`, channels `run-events:{runId}`, `run-control`.
- Every package ships `tsconfig.json` extending `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), builds with `tsup` or `tsc -b`, and is tested with Vitest.
