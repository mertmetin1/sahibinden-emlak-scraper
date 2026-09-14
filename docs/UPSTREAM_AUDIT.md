# Upstream Audit — tyegen/sahibinden-emlak-scraper

**Purpose:** Complete audit of the upstream codebase driving the migration to a local-first crawling application.
**Upstream:** https://github.com/tyegen/sahibinden-emlak-scraper
**Baseline commit:** `a14740c46d22998dea932c9aa673b61f11089b8c` ("docs: add AI assistant prompt and critical session cookie warning", 2026-05-04) — verified as `HEAD` of this clone.
**Auditor:** Agent 1 (Upstream Archaeologist). No code files were modified.

> **Line-reference convention:** All `src/main.js` line numbers refer to the **current working tree** (855 lines), which includes today's local modifications. The local mods add a net **38 lines** (upstream `main.js` was 817 lines). Sections 15–16 isolate the local deltas; everything else describes upstream behavior. All other files are unmodified upstream.

---

## 0. Legal / license risk (read first)

- **No `LICENSE` file exists in the upstream repository.** Verified: `git ls-files` contains only the 10 files listed in §1; no `LICENSE*`, `COPYING*`, or `NOTICE*` exists.
- `package.json:21` declares `"license": "ISC"`, but a `package.json` field without an accompanying license text/grant is **not** a license grant. Default copyright ("all rights reserved") applies to the upstream code.
- **Risk:** The migration project copies/derives from upstream code without an explicit license. Mitigation options: (a) contact upstream author (`tyegen`, tyegen26@gmail.com per git history) for an explicit license; (b) treat upstream as reference-only and re-implement; (c) keep derivative work private. This must be resolved before any public distribution.
- Secondary note: upstream's own purpose (automated bypass of PerimeterX/Cloudflare bot protection) is legally sensitive in itself — see §11 for the mechanisms the project has already flagged **TO BE REMOVED per project legal boundary**.

---

## 1. File inventory

Tracked upstream files (verified via `git ls-files`):

| Path | LOC | Purpose |
|---|---|---|
| `src/main.js` | 855 (817 upstream + 38 local) | Entire crawler: Actor bootstrap, proxy/session/cookie setup, challenge handling, PuppeteerCrawler config, category-page extraction, pagination |
| `src/utils.js` | 128 | Helpers: `randomUserAgent`, `generateSessionId` (dead), `randomDelay`, `formatPrice`, `extractCurrency`, `parseYesNo` (dead), `normalizeText`, `extractListingId` |
| `src/baserow.js` | 214 | Optional BaseRow (hosted Baserow SaaS) sink: dedup-by-ID, create/update rows |
| `package.json` | 21 | ESM package; deps: `apify ^3.1.0`, `axios ^1.6.0`, `crawlee ^3.13.0`, `puppeteer *`, `puppeteer-extra latest`, `puppeteer-extra-plugin-stealth latest` |
| `README.md` | 132 | Apify-store-facing docs (significantly stale — see §10.3) |
| `.actor/actor.json` | 12 | Apify Actor metadata: `actorSpecification: 1`, template `js-crawlee-puppeteer-chrome`, pointers to input schema + Dockerfile |
| `.actor/input_schema.json` | 89 | Apify input schema (9 properties; `startUrls` required) |
| `.actor/Dockerfile` | 40 | Two-stage build on `apify/actor-node-puppeteer-chrome:20` (stage 1 is wasted — see §10.2) |
| `.gitignore` | 8 | Ignores `node_modules/`, `apify_storage/`, `crawlee_storage/`, `storage/`, IDE dirs, `*.log`, and curiously `sahibinden-emlak-scraper-plan.md` (line 8 — a planning doc existed but was never committed) |
| `.dockerignore` | 14 | Excludes IDE dirs, storage dirs, `node_modules`, `.git` from image |

**Not upstream (present in workspace):**

| Path | LOC | Status |
|---|---|---|
| `scrape-real-chrome.mjs` | 128 | **Local experiment** (untracked) — real-Chrome CDP scraper, see §16 |
| `package-lock.json` | — | Untracked, generated locally. **Upstream has no lockfile** → non-reproducible builds, aggravated by `puppeteer: "*"` and `latest` tags in `package.json:11-13` |
| `.chrome-debug-profile/`, `storage/`, `*.png`, `node_modules/` | — | Ignored per audit scope |

---

## 2. Apify dependency map (every `Actor.*` call site)

The `apify` package is imported only in `src/main.js:2` (`import { Actor } from 'apify'`) and `src/baserow.js:2` (`import { Actor, log } from 'apify'`). Complete call-site inventory:

| Call | Location | What it does |
|---|---|---|
| `Actor.init()` | `src/main.js:20` | Initializes the Actor runtime: reads Apify env vars, points Crawlee storage at Apify dataset/KV/request-queue (locally: `storage/` dir). Everything Crawlee does afterwards flows through this. |
| `Actor.getInput()` | `src/main.js:23` | Reads input JSON (`storage/key_value_stores/default/INPUT.json` locally); destructured at `main.js:24-38`. |
| `Actor.getInput()` | `src/baserow.js:201` | **Second, redundant read** of the same input inside `createBaseRowIntegration()` (the three `baseRow*` fields destructured at `main.js:33-35` are never used — dead destructure). |
| `Actor.createProxyConfiguration(finalProxyConfiguration)` | `src/main.js:54` | Builds Apify-proxy-aware proxy config; result passed to crawler at `main.js:239`. Returns `null` if neither Apify proxy nor custom URLs configured. |
| `Actor.setValue(`${key}-screenshot`, …, { contentType: 'image/png' })` | `src/main.js:218` | Debug artifact: full-page PNG → default KV store. Only when `debugMode` (guard at `main.js:213`). |
| `Actor.setValue(`${key}-html`, …, { contentType: 'text/html' })` | `src/main.js:225` | Debug artifact: page HTML → default KV store. |
| `Actor.pushData(results)` | `src/main.js:728` | Flush of the current page's batch when `maxItems` is hit mid-page (before aborting). |
| `Actor.pushData(results)` | `src/main.js:785` | Normal per-page batch write to the default dataset. **This is the only product-data sink besides BaseRow.** |
| `Actor.exit(1, 'No valid start URLs provided.')` | `src/main.js:848` | Hard exit when input yields zero valid URLs. |
| `Actor.exit()` | `src/main.js:855` | Normal exit (last line). |

**apify/crawlee coupling points (beyond `Actor.*`):**

- `log` used in `main.js` comes from **crawlee** (`main.js:3`); `log` in `baserow.js` comes from **apify** (`baserow.js:2`). Functionally equivalent (apify re-exports crawlee's log), but a migration must pick one.
- `crawler.autoscaledPool?.abort()` — `main.js:735` and `main.js:811`: reaches into the crawler's autoscaled pool to stop scheduling when `maxItems` is reached. Semi-public API.
- `crawler._throwOnBlockedRequest` override — `main.js:634-644`: **private-API monkey-patch** (underscore-prefixed). Suppresses Crawlee's built-in session-retire-on-403/503 so the `postNavigationHook` gets a chance to solve challenges first. Breaks silently on Crawlee upgrades.
- Crawlee `Session` object API: `session.userData` (custom state: `cookiesInjected`, `warmedUp`, `userAgent`), `session.markBad()`, `session.markGood()` — see §6.
- `enqueueLinks` from the handler context (`main.js:606`, used at `main.js:803`) — Crawlee request-queue enqueue.
- `crawler.addRequests(startRequests)` — `main.js:844`; `crawler.run()` — `main.js:852`.
- `proxyConfig.usesApifyProxy` — `main.js:78` (logging only).

**Migration surface:** 10 `Actor.*` call sites + the items above. A thin local adapter (init/getInput/pushData/setValue/exit/createProxyConfiguration) fully de-Apifies the code.

---

## 3. Crawlee / Puppeteer usage

### 3.1 Crawler configuration (`new PuppeteerCrawler({...})`, `src/main.js:238-631`)

| Option | Line | Value | Notes |
|---|---|---|---|
| `proxyConfiguration` | 239 | `proxyConfig` (from `Actor.createProxyConfiguration`) | See §7 |
| `maxConcurrency` | 240 | input `maxConcurrency` (default 3) | Unbounded in code (schema caps at 10) |
| `maxRequestsPerCrawl` | 241 | `maxItems ? maxItems * 3 : 1000` | Arbitrary 3× heuristic; hard-caps pagination |
| `maxRequestRetries` | 242 | **8** | See §5 |
| `navigationTimeoutSecs` | 243 | 90 | Also mirrored via `gotoOptions.timeout = 90000` at line 495 |
| `requestHandlerTimeoutSecs` | 244 | 180 | **Collides with local `waitForManualSolve` 180 s timeout — see §13.9** |
| `useSessionPool` | 246 | `true` | |
| `persistCookiesPerSession` | 247 | `true` | Browser cookies persisted into Crawlee sessions |
| `sessionPoolOptions.maxPoolSize` | 249 | 10 | |
| `sessionPoolOptions.sessionOptions.maxUsageCount` | 251 | 50 | Session retired after 50 uses regardless of health |
| `browserPoolOptions.retireBrowserAfterPageCount` | 256 | 20 | Fresh browser every 20 pages |
| `launchContext.launcher` | 260 | `puppeteer` (**puppeteer-extra**, stealth plugin applied at line 17) | |
| `launchContext.launchOptions.headless` | 262 | `process.env.HEADLESS !== 'false'` | `HEADLESS=false` → headed mode (used by local manual-solve mod) |
| `launchContext.launchOptions.args` | 263-273 | `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-blink-features=AutomationControlled`, `--disable-infobars`, `--window-size=1920,1080`, `--start-maximized`, `--disable-features=IsolateOrigins,site-per-process`, `--disable-site-isolation-trials` | Line 267 is an anti-detection flag (§11) |
| `launchContext.launchOptions.ignoreDefaultArgs` | 274 | `['--enable-automation']` | Removes the automation banner/flag — anti-detection (§11) |
| `launchContext.useChrome` | 276 | `true` | Uses installed **Chrome** (not bundled Chromium) |

### 3.2 `preNavigationHooks` (`main.js:279-498`) — responsibilities

Runs before every navigation; signature `async ({ page, request, session }, gotoOptions)` (line 280):

1. **Cookie injection, once per session** (lines 285-331): guarded by `session.userData.cookiesInjected` (checked 286, set 322). Normalizes `key`→`name` (291), drops nameless/expired cookies (292-303, expiry from `expirationDate ?? expires`), formats for Puppeteer (311-319: domain default `.sahibinden.com`, `secure !== false`, `httpOnly === true`, `sameSite` `no_restriction`→`None`), `page.setCookie(...)` at 320.
2. **cf_clearance validity check** (333-346): reads `page.cookies('https://www.sahibinden.com')`, treats missing/`-1`/future `expires` as valid (336-338). Log-only.
3. **Session pre-warm** (348-383): if no valid `cf_clearance` and `!session.userData.warmedUp`, navigates to the homepage first (`page.goto('https://www.sahibinden.com', { waitUntil: 'networkidle2', timeout: 60000 })`, 353-356) to *earn* a cf_clearance; if a challenge page appears, waits up to 30 s for auto-resolution (362); sets `warmedUp` (376); `randomDelay(1500, 3000)` (377).
4. **UA pinning per session** (385-395): `session.userData.userAgent` assigned once from `randomUserAgent()` (389-392), applied via `page.setUserAgent(ua)` (394). Comment (386-388) explains why: cf_clearance is bound to the UA that earned it.
5. **Header forging** (399-427): derives `sec-ch-ua` from the UA's Chrome version (399, 419-424 — skipped for Firefox/Safari UAs); sets `Accept-Language: tr-TR,…`, `Sec-Fetch-*` headers (409-417); **detail-page special-casing** (404-418, 429-431): `Sec-Fetch-Site: same-origin` + `Referer: <category URL>` + extra 4-8 s delay for `label === 'DETAIL'` — **vestigial**, see §10.1.
6. **Viewport** (432): `1920×1080`.
7. **Fingerprint overrides** (435-491): `page.evaluateOnNewDocument` injecting `navigator.webdriver` removal, fake `window.chrome`, permissions-query patch, `languages/platform/hardwareConcurrency/deviceMemory/maxTouchPoints` spoofs, screen-geometry spoofs, fake `PluginArray`, WebGL `getParameter` spoof (`37445`→`'Intel Inc.'`, `37446`→`'Intel Iris OpenGL Engine'`). **Security-sensitive — §11.**
8. **goto options** (493-496): forces `waitUntil: 'networkidle2'`, `timeout: 90000`.

### 3.3 `postNavigationHooks` (`main.js:500-603`) — responsibilities

Signature `async ({ page, response, request, session })` (line 501). Flow:

1. Logs status (503). If status is **403/503/429** (505):
   - `saveDebugInfo(page, '<status>-initial')` (507), 5-10 s delay (509), random mouse moves (511-514).
   - **PX hold challenge?** (`isPxHoldChallenge`, 518) → `tryHoldPxButton(page)` (522). On failure → *(local mod: `waitForManualSolve`, 526)* → else `session.markBad()` (528) + `throw 'PerimeterX hold challenge not resolved'` (529).
   - **Cloudflare challenge?** (`isChallengedPage`, 532) → wait for navigation up to 45 s (536); re-check content (539): PX-hold-after-CF branch (540-550), still-challenged branch (551-558, throws `'Cloudflare Turnstile challenge requires manual verification'`), resolved branch (560). Navigation timeout → catch (562-571): rethrows Turnstile/PerimeterX errors (563), else *(local mod: manual solve, 566)* → `markBad` (568) + `throw 'Cloudflare challenge timeout'` (569).
   - **Unrecognized 403** (572-577): `markBad` + `throw 'Blocked with status <code>'`.
2. **tloading page** (`/cs/tloading`, 581-591): waits 30 s for the JS redirect; else `markBad` (588) + throw (589).
3. **Login redirect** (`/giris` or `secure.sahibinden.com`, 594-597): `markBad` (596) + `throw 'Mandatory login required…'` (597) — means session cookies are missing/expired.
4. **2xx** (600-602): `session.markGood()` (601).

All throws propagate → Crawlee retries the request with a (retired/replaced) session, up to `maxRequestRetries: 8`.

### 3.4 `requestHandler` (`main.js:606-624`)

- Reads `request.userData.label || 'CATEGORY'` (607), logs, `randomDelay(2000, 5000)` (610).
- `page.waitForSelector('body', { timeout: 45000 })` (613).
- **Always** calls `handleCategoryPage(page, request, enqueueLinks)` (615) — there is **no detail handler** (§10.1).
- On error: logs + **rethrows** (617-623) → counts against `maxRequestRetries`.

### 3.5 `failedRequestHandler` (`main.js:626-630`)

Logs the URL and `request.errorMessages` only. **No dataset record, no dead-letter queue — permanently failed URLs are silently lost.**

### 3.6 The `_throwOnBlockedRequest` override hack (`main.js:633-644`)

```text
crawler._throwOnBlockedRequest = function (session, statusCode) {
    if (statusCode === 403 || statusCode === 503) { return; }  // suppress
    return originalThrowOnBlocked(session, statusCode);
};
```

Suppresses Crawlee's built-in "blocked request" handling for 403/503 (which would instantly retire the session and retry) so the `postNavigationHook` can attempt challenge resolution first. **429 is not suppressed** — Crawlee's default still applies to it. Uses a private (underscore) API → brittle across Crawlee versions; `?.bind` guard (634) silently skips if Crawlee removes the method.

---

## 4. Complete selector inventory

### 4.1 Listing extraction selectors (`handleCategoryPage`, `main.js:652-659`, quoted exactly)

| Selector | Line | Purpose |
|---|---|---|
| `tbody.searchResultsRowClass > tr.searchResultsItem` | 652 | Primary: listing rows (waited 15 s at 663, queried at 664) |
| `td.searchResultsTitleValue a.classifiedTitle` | 653 | Title text + detail URL (`el.href`), used at 740-742 |
| `td.searchResultsPriceValue span` | 654 | Price text, used at 749 |
| `td.searchResultsPriceValue:nth-of-type(2)` | 655 | Price-per-m² cell (2nd `<td>` of its type), used at 750 — **column-order-dependent** |
| `td.searchResultsAttributeValue` | 656 | Area — `$eval` takes the **first** match only (751); sahibinden rows contain several attribute cells |
| `td.searchResultsDateValue` | 657 | Date (`innerText`, `\n`→space), used at 753 |
| `td.searchResultsLocationValue` | 658 | Location (`innerText`, `\n`→`' / '`), used at 752 |
| `a.prevNextBut[title="Sonraki"]:not(.passive)` | 659 | Next-page link (Turkish title attribute "Sonraki" = "Next"), used at 799 |
| `img` (within row) | 754 | First image: `el.src \|\| el.dataset?.src` |
| `data-id` attribute (within row) | 756 | Listing ID — preferred over URL regex (fallback `extractListingId` at 757) |

### 4.2 Fallback chain when the primary row selector fails (`main.js:676-682`)

Tried in order, first non-empty wins (loop 685-692):

1. `table.searchResultsTable tr.searchResultsItem`
2. `.searchResultsRowClass .searchResultsItem`
3. `tr.searchResultsItem`
4. `.classified-list-item`
5. `[data-id]` — **dangerously broad**: matches *any* element with a data-id anywhere on the page
6. `.searchResults .result-item`
7. `table tr[data-id]`

If all fail: debug dump of `table`/`tr`/`tbody` counts (695-698) and a page-wide class-name scan (700-715), then `throw new Error('No listing elements found with any selector')` (717) — **which is swallowed by the outer catch** (§13.4).

### 4.3 PerimeterX hold-button selectors (`tryHoldPxButton`, `main.js:125-130`)

`'#px-captcha'`, `'.px-captcha-container'`, `'div[id^="px-captcha"]'`, `'button'` — the last is a **catch-all that matches the first `<button>` on any page** (risk of holding/clicking an unrelated button). Local mod searches these in the main frame **and all iframes** (133-144).

### 4.4 Challenge-detection signatures (string matching, not selectors)

- `isChallengedPage(html)` (`main.js:97-107`): `'Just a moment'`, `'Checking your browser'`, `'cf-browser-verification'`, `'challenge-platform'`, `'Güvenlik doğrulaması gerçekleştirme'`, `'Bir dakika lütfen'`, `'Uyumsuz tarayıcı eklentisi'` ("incompatible browser extension").
- `isPxHoldChallenge(html)` (`main.js:110-119`): `'Basılı Tutun'` ("Press and hold"), `'px-captcha'`, `'_pxCaptcha'`, `'PerimeterX'`, `'Bağlantınız kontrol ediliyor'` ("your connection is being checked"), `'human-challenge'`.
- URL heuristics: `'/cs/tloading'` (581), `'/giris'` + `'secure.sahibinden.com'` (594).

### 4.5 Other

- `'body'` wait (613); debug-only `table`/`tr`/`tbody` counts (695-697).

---

## 5. Retry logic

- `maxRequestRetries: 8` (`main.js:242`). Crawlee retries any request whose handler/hook throws.
- **Error classification: essentially none.** Every thrown error (challenge failure, login redirect, tloading timeout, extraction rethrow) follows the same path: retry with a rotated session. The only differentiation is *which* error message is thrown in the postNavigationHook.
- `session.markBad()` call sites (7): `main.js:528, 547, 556, 568, 575, 588, 596` — always immediately before a throw, retiring the session so the retry uses a fresh one (new proxy IP under Apify proxy, new UA, re-injected cookies).
- `session.markGood()` (1): `main.js:601` — on any 2xx.
- **Retry hole #1:** `handleCategoryPage` catches **all** its own errors and only logs a warning (`main.js:813-816`) — selector failures / extraction explosions produce a "successful" request with zero data and **no retry**.
- **Retry hole #2:** `failedRequestHandler` (626-630) only logs — after 8 retries the URL is gone.
- The `_throwOnBlockedRequest` override (633-644) prevents double-punishment for 403/503 (Crawlee would otherwise retire the session before the hook runs).

---

## 6. Session logic

- **Pool:** `useSessionPool: true`, `persistCookiesPerSession: true` (246-247); `maxPoolSize: 10` (249); `maxUsageCount: 50` (251) — sessions retired after 50 uses regardless of health.
- **Cookie injection — once per session** (285-331): flag `session.userData.cookiesInjected` (checked 286, set 322). Rationale in comment (281-284): re-injecting on every request would overwrite the *fresh* CF/PX cookies the browser earned with the stale originals. Normalization: `name ?? key` (291); expiry filter via `expirationDate ?? expires` (297-301); defaults `domain: '.sahibinden.com'`, `path: '/'`, `secure: true` unless explicitly false, `httpOnly` only if true, `sameSite` mapping `no_restriction → None` (311-319). Injection log at 321. All-expired → warning (324).
- **Pre-warm** (348-383): once per session (`session.userData.warmedUp`, set 376). Triggered only when no valid `cf_clearance` (350). Homepage goto (353), challenge wait (358-372), 1.5-3 s settle delay (377).
- **cf_clearance validity** (334-338): valid if `expires` missing, `-1`, or in the future. Lifetime is otherwise **not tracked** — an expiring clearance is only discovered via the next 403/challenge.
- **UA pinning** (385-395): one UA per session (`session.userData.userAgent`), because cf_clearance is UA-bound (comment 386-388). `sec-ch-ua` headers derived from the UA's Chrome version (399, 419-424).
- **Cookie flow summary:** user cookies injected once → browser earns fresh CF/PX cookies → `persistCookiesPerSession` carries them across pages of the same session → session retired on `markBad`/50 uses → next session re-injects the originals.

---

## 7. Proxy logic

- Defaults (`main.js:28-32`) and forced merge (41-46): `{ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], countryCode: 'TR', ...(proxyConfiguration || {}) }`. **The input spread comes last, so "forced" is soft** — a user can override groups/country or even `useApifyProxy: false`.
- Re-enforcement only when empty: groups → `['RESIDENTIAL']` if missing/empty (47-49); `countryCode` → `'TR'` if falsy (50-52).
- `Actor.createProxyConfiguration(...)` at 54; passed to crawler at 239.
- Startup logging (56-84): cookie-name inventory, `hasCfClearance`/`hasPerimeterXCookies` flags (57-58), PX-cookie absence warning with manual-bypass instructions (70-74), proxy type log (76-81).
- **Without proxy:** if the user disables Apify proxy and provides no `proxyUrls`, `proxyConfig` is `null` → warning *"Sahibinden.com requires RESIDENTIAL proxy!"* (83) and the crawl continues **unproxied** — near-certain instant block. No hard fail.

---

## 8. Storage logic

### 8.1 Dataset (product data)

- `Actor.pushData(results)` per category page batch (`main.js:785`) and on mid-page `maxItems` abort (`main.js:728`). Nothing else writes product data. Record shape: §12.

### 8.2 Key-value store (debug artifacts only)

- `saveDebugInfo(page, label)` (`main.js:211-235`), gated by `debugMode` (213). Keys: `DEBUG-NNN-<label>-screenshot` (full-page PNG, 217-218) and `DEBUG-NNN-<label>-html` (224-225), `NNN` zero-padded counter (214-215). Also logs a truncated cookie summary (first 20 chars of each value, 230-233) — **cookie fragments land in logs**.
- Labels used: `prewarm-challenge`, `prewarm-challenge-unresolved`, `<status>-initial`, `<status>-px-hold`, `<status>-px-hold-failed`, `<status>-challenge`, `<status>-cf-then-px`, `<status>-challenge-still-blocked`, `<status>-challenge-timeout`, `<status>-unknown-block`, `category-loaded`, `category-selector-failed`.

### 8.3 BaseRow integration (`src/baserow.js`)

- **Activation:** `createBaseRowIntegration()` (200-213) re-reads `Actor.getInput()` (201) and requires all three of `baseRowApiToken`, `baseRowTableId`, `baseRowDatabaseId` (204-208); constructor re-validates and throws (17-21), caught in `main.js:90-92` (warn + continue without BaseRow). **Env vars: none** — configuration is via Actor input only.
- **Endpoint:** hardcoded `https://api.baserow.io/api` (25) — **self-hosted Baserow is unsupported**. Auth header `Token <apiToken>` (29), axios client (26-32).
- **Write path:** called per page batch from `main.js:730` (maxItems flush) and `main.js:787-791` (normal path); errors swallowed with a warning (731, 789-790). `storeListings` (67-82) loops **sequentially, one listing at a time** — no batch API → 1 GET + 1 POST/PATCH **per listing** (rate-limit exposure).
- **Dedup:** `_findExistingListing(listingId)` (90-108) does `GET /database/rows/table/<tableId>/?search=<listingId>&user_field_names=true` then filters client-side `row.listing_id === listingId` (102). Fragile: Baserow `search` is full-text and may not return the row; `listingId` may be `null` (searches for `"null"`); search matches across all fields.
- **Create/update:** `_createRow` POST (116-128), `_updateRow` PATCH `/<rowId>/` (137-148), both `user_field_names=true`.
- **Table schema assumptions** (`_prepareRowData`, 157-193) — 25 named fields must exist in the table: `listing_id, url, title, price, price_currency, location, description, date, rooms, size, building_age, floor, total_floors, heating, furnished, usage_status, in_site, dues, deed_status, credit_eligible, seller, images, all_info, scraped_at, last_updated`.
- **Stale mapping:** `rooms/size/building_age/...` read from `data.info['Oda Sayısı']` etc. (169-180) and `description/images/seller` (166, 181) — **none of these exist in the category-page output** since detail scraping was removed (commit `17ca197`), so those columns are always `''`/`[]`. `price: data.price || 0` (162) turns unparseable prices into `0`. `databaseId` is collected but never used in any API call (only logged, 34).

---

## 9. (Reserved — see §10 for dead code, §11 for security)

---

## 10. Dead code / unused code / README↔implementation inconsistencies

### 10.1 Dead code in the implementation

| Item | Location | Finding |
|---|---|---|
| `generateSessionId()` | `src/utils.js:42-44` | Exported, **never imported** anywhere. |
| `parseYesNo()` | `src/utils.js:92-100` | Exported, **never imported**. Was for detail-page attributes ("Evet"/"Hayır"), orphaned by commit `17ca197`. |
| `baseRowApiToken / baseRowTableId / baseRowDatabaseId` destructure | `src/main.js:33-35` | Destructured from input but **never used** in `main.js`; `baserow.js:201` re-reads input itself. |
| **DETAIL label routing** | `main.js:839-840` (label assignment), `404-431` (detail headers/Referer/4-8 s delay) | Start URLs containing `/ilan/` + `/detay` are labeled `DETAIL`, and the preNavigationHook still forges detail-navigation headers for them — **but `requestHandler` (606-624) always calls `handleCategoryPage`; no detail handler exists.** A DETAIL start URL is processed as a category page, finds no listing rows, and the error is swallowed (§13.4). Vestigial remnant of removed detail scraping. |
| `isDetailPage`/`sourceUrl` logic | `main.js:404-418` | Only reachable via the dead DETAIL path above. |
| Dockerfile `intermediate` stage | `.actor/Dockerfile:2-14` | Stage `AS intermediate` installs deps and copies source, then the final stage (17) starts **fresh from the base image** and redoes everything — **nothing is ever `COPY --from=intermediate`**. Pure build-time waste; template leftover. |
| `databaseId` | `src/baserow.js:23, 25, 34` | Required by constructor, never used in any API call. |

### 10.2 Dependency/build hygiene

- `package.json:11-13`: `"puppeteer": "*"`, `"puppeteer-extra": "latest"`, `"puppeteer-extra-plugin-stealth": "latest"` — unpinned.
- **No `package-lock.json` upstream** (untracked locally) → non-reproducible installs; the Dockerfile's `COPY package*.json` (lines 8, 23) tolerates but encourages this.
- `package.json:21` `"license": "ISC"` vs **no LICENSE file** (§0).
- `.actor/actor.json:6` version `"1.0"` vs `package.json:3` `"1.0.0"` (cosmetic).
- Dockerfile CMD (40): `./start_xvfb_and_run_cmd.sh && npm run start:prod --silent` — Xvfb makes headed mode possible in-container; `start` and `start:prod` scripts are identical (`package.json:16-17`).

### 10.3 README ↔ implementation inconsistencies (README is stale; code is truth)

| # | README claim | Location | Reality |
|---|---|---|---|
| 1 | `includeDetails` input parameter (Boolean, default false) | `README.md:35`, also 39, 56, 110 | **Removed from code and input schema in commit `17ca197`** ("CF Turnstile blocks all detail pages"). Not in `.actor/input_schema.json`, never read in code. |
| 2 | "Detail Pages — Optional: scrape full property details, photos, and seller info" feature bullet | `README.md:24` | False — no detail handler exists. |
| 3 | Detailed output schema: `description, images, seller, rooms, size, buildingAge, floor, totalFloors, heating, furnished, usage, inSite, dues, deedStatus, creditEligible, info` | `README.md:56-83` | **Never produced.** Category handler emits none of these fields. |
| 4 | "Extracts property details including price, location, **size, rooms, building age**, and more" | `README.md:17` | `rooms`/building age never extracted; `area` (m²) is, but only the first attribute cell. |
| 5 | Basic output example fields | `README.md:40-53` | **Omits `price_raw`, `price_per_sqm`, `area`** which the code *does* emit (`main.js:765-767`). Documented example is an incomplete subset. |
| 6 | Input table lists only `startUrls, maxItems, includeDetails, maxConcurrency, proxyConfiguration` | `README.md:31-37` | Missing: `sessionCookies` (prose only, lines 10-15, 117-119), `debugMode` (**nowhere in README**), `baseRowApiToken/baseRowTableId/baseRowDatabaseId` (only a feature bullet, line 26). |
| 7 | BaseRow integration bullet | `README.md:26` | Exists in code, but writes mostly-empty rows (§8.3 stale mapping) — undocumented behavior. |
| 8 | "Random … viewport sizes" | `README.md:27` | Viewport is **fixed** 1920×1080 (`main.js:432`). Only UA/delay vary. |

---

## 11. Security-sensitive mechanisms present upstream

> **All items below are marked "TO BE REMOVED per project legal boundary."** They exist to defeat third-party bot-detection systems. Documented neutrally for completeness.
> **Explicitly ALLOWED and to be PRESERVED:** injection of **user-supplied, authorized session cookies** (`main.js:285-331`) — the user exports their own browser session; this is the sanctioned mechanism.

| # | Mechanism | Location | What it does |
|---|---|---|---|
| 1 | `puppeteer-extra-plugin-stealth` | `src/main.js:5, 17` (`puppeteer.use(StealthPlugin())`) | Industry-standard fingerprint-spoofing plugin stack applied to every page. |
| 2 | Manual fingerprint overrides | `src/main.js:435-491` (`evaluateOnNewDocument`) | Removes `navigator.webdriver`; fakes `window.chrome`; patches `permissions.query`; spoofs `languages`, `platform: 'Win32'`, `hardwareConcurrency: 8`, `deviceMemory: 8`, `maxTouchPoints: 0`, screen geometry, a fake `PluginArray`; spoofs WebGL vendor/renderer (`37445`/`37446` → Intel). |
| 3 | `tryHoldPxButton` | `src/main.js:122-188` | **Automated solving of the PerimeterX "Basılı Tutun" press-and-hold challenge**: locates the hold element (incl. iframes — local mod), moves the mouse in steps, holds `mouse.down()` for **10 s** (169-171), waits for navigation. |
| 4 | Automated Cloudflare challenge waiting | `src/main.js:358-372` (pre-warm), `532-571` (post-nav) | Detects CF interstitials and waits for auto-resolution (30-45 s), including CF→PX chains. |
| 5 | Anti-automation browser flags | `src/main.js:267` (`--disable-blink-features=AutomationControlled`), `274` (`ignoreDefaultArgs: ['--enable-automation']`) | Hides automation signals from the browser itself. |
| 6 | UA rotation + `sec-ch-ua` forging | `src/main.js:389-395, 399, 419-424`; `src/utils.js:7-36` | Random desktop UA per session; client-hint headers forged to match. |
| 7 | Forced residential-proxy rotation | `src/main.js:41-54` | RESIDENTIAL/TR Apify proxy to evade IP-based blocking; session rotation (markBad) cycles IPs. |
| 8 | Header forging for navigation context | `src/main.js:409-427` | `Sec-Fetch-*`/`Referer` values chosen to make automated navigations look organic. |

**Human-in-the-loop alternative (local mod, §15):** `waitForManualSolve` (`main.js:192-209`) pauses for a *human* to solve the challenge in a visible browser — categorically different from automated solving.

---

## 12. Baseline output contract (regression baseline)

One dataset item per listing row, built at `src/main.js:759-773`:

```json
{
    "id": "1234567890",
    "url": "https://www.sahibinden.com/ilan/emlak-konut-satilik-3plus1-1234567890/detay",
    "title": "3+1 Satılık Daire Kadıköy",
    "price": 4500000,
    "price_currency": "TL",
    "price_raw": "4.500.000 TL",
    "price_per_sqm": "32.143 TL/m²",
    "area": "140",
    "location": "İstanbul / Kadıköy",
    "date": "21 Şubat 2026",
    "image": "https://i0.shbdn.com/.../thmb.jpg",
    "scrapedAt": "2026-02-21T12:00:00.000Z",
    "sourceUrl": "https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc"
}
```

| Field | Type | Nullability | Source |
|---|---|---|---|
| `id` | `string \| null` | **Nullable** (both `data-id` attr (756) and regex fallback (757) can fail) | row `data-id`, else `extractListingId(url)` = `/(\d{8,12})(?:\/|$)/` (`utils.js:126`) |
| `url` | `string` | Never null — rows without title/URL are **skipped** (744-746) | `a.classifiedTitle` href |
| `title` | `string` | Never null (skip guard), whitespace-collapsed, mojibake-fixed | `normalizeText` (`utils.js:108-114`) |
| `price` | `number \| null` | Nullable when unparseable | `formatPrice` (`utils.js:62-72`) |
| `price_currency` | `string` | Never null; **defaults `'TL'` even when `price_raw` is null** | `extractCurrency` (`utils.js:79-85`): EUR/€, USD/$, GBP/£, else TL |
| `price_raw` | `string \| null` | Nullable | raw cell text |
| `price_per_sqm` | `string` | **Never null — `''` when missing** (`normalizeText(null) → ''`) | `:nth-of-type(2)` price cell |
| `area` | `string` | `''` when missing | first `searchResultsAttributeValue` cell |
| `location` | `string` | `''` when missing; newlines → `' / '` | location cell `innerText` |
| `date` | `string` | `''` when missing; newlines → `' '` | date cell `innerText` |
| `image` | `string \| null` | Nullable | first `img` `src \|\| dataset.src` |
| `scrapedAt` | `string` | Never null | `new Date().toISOString()` |
| `sourceUrl` | `string` | Never null | category page URL (`request.url`) |

**Contract notes for regression testing:**
- Rows lacking `title` or `url` never appear (silent skip, debug log at 745).
- Mixed nullability: `price_per_sqm`/`area`/`location`/`date` use `''`-for-missing; `id`/`price`/`price_raw`/`image` use `null`. Preserve this exactly.
- `price` is a float; Turkish `4.500.000 TL` → `4500000` (dots stripped as thousands separators).
- Dataset write granularity: one `pushData` per page (array), not per item.
- The local experiment (`scrape-real-chrome.mjs`) emits a **different** shape (`attrs` array instead of `area`; no `price_currency`, `price_per_sqm`, `scrapedAt`, `sourceUrl`; no `normalizeText`) — do not confuse the two baselines.

---

## 13. Input contract (per code, not README)

Destructured at `src/main.js:23-38`; schema at `.actor/input_schema.json` (enforced only by the Apify platform — **the code performs almost no validation**).

| Field | Code default | Schema | Validation gaps |
|---|---|---|---|
| `startUrls` | `[{ url: 'https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc' }]` (25) | array, **required**, `requestListSources` editor, prefilled | Accepts strings or `{url}` objects (823-831); only checks `startsWith('http')` (834). **No domain check** — any URL is crawlable. Non-array coerced via `[startUrls]` (823). |
| `maxItems` | `null` (26) | integer, min 1, nullable | Not type-checked in code; a string would break `>=` comparisons subtly. Drives `maxRequestsPerCrawl = maxItems*3` (241). |
| `maxConcurrency` | `3` (27) | integer, 1-10, default 3 | **No code-side bounds** — schema-only. |
| `proxyConfiguration` | `{ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], countryCode: 'TR' }` (28-32) | object, `proxy` editor, prefilled | Spread-merged over defaults (45); can fully override the "forced" residential/TR policy. |
| `sessionCookies` | `[]` (36) | array, `json` editor, default `[]` | Free-form items; code tolerates `name`/`key` and `expirationDate`/`expires` variants (291, 297) but never validates `value` presence. |
| `debugMode` | `false` (37) | boolean, default false | — |
| `baseRowApiToken` / `baseRowTableId` / `baseRowDatabaseId` | — (33-35) | strings; token `isSecret` | All three required for BaseRow activation (baserow.js:204); destructured-but-unused in `main.js`. |
| ~~`includeDetails~~ | — | — | **Documented in README, absent from schema and code** (removed `17ca197`). |

Labeling of start requests (`main.js:839-840`): URL containing `/ilan/` **and** `/detay` → `userData.label = 'DETAIL'` (dead route, §10.1), else `'CATEGORY'`.

---

## 14. Known fragilities

1. **Selector brittleness (primary risk, acknowledged by upstream):** README:132 admits sahibinden changes HTML to break extraction. Primary row selector `tbody.searchResultsRowClass > tr.searchResultsItem` (652) is class-name dependent; fallback chain includes `[data-id]` (680) which can match arbitrary non-listing elements and then produce garbage rows or silent skips.
2. **`price_per_sqm` selector is column-order-dependent:** `td.searchResultsPriceValue:nth-of-type(2)` (655) breaks if sahibinden reorders/adds columns; also only present on some categories.
3. **`area` takes only the first attribute cell** (656, 751): sahibinden rows have multiple `searchResultsAttributeValue` cells (m², room count, building age…); which is "first" varies by category (land vs. apartment). The local experiment's `attrs` array (§16) is the more robust pattern.
4. **Extraction errors are swallowed:** `handleCategoryPage`'s outer catch (813-816) logs a warning and returns — "No listing elements found" (717) and any mid-loop explosion yield a *successful* request with partial/zero data, **no retry** (§5).
5. **Price parsing edge cases** (`utils.js:62-72`): strips all `.` as thousands separators then converts `,`→`.`. Turkish `4.500.000 TL` ✓ → `4500000`; but US-formatted `1,500,000` → `1.500.000` → `parseFloat` → **`1.5`**; mixed `4.500.000,50` ✓ → `4500000.5`. `extractCurrency` defaults to `'TL'` on null input.
6. **Mojibake fix is a hack** (`utils.js:113`): `decodeURIComponent(escape(result))` uses deprecated `escape()`; correct Unicode input throws inside and is returned as-is (caught silently) — works, but fragile and opaque.
7. **`extractListingId` regex** (`utils.js:126`): `/(\d{8,12})(?:\/|$)/` matches the *first* 8-12 digit run followed by `/` or end — a slug containing an earlier 8+ digit number would mis-extract. Mitigated by `data-id` preference (756) but the fallback remains.
8. **Pagination termination** depends on the Turkish title attribute `a.prevNextBut[title="Sonraki"]:not(.passive)` (659, 799): a locale change, rename, or markup change silently ends crawling. No absolute page cap besides `maxRequestsPerCrawl` (241) — with no `maxItems`, crawling stops at 1000 requests regardless of remaining pages.
9. **`maxItems` enforcement is racy:** global `scrapedItemsCount` (94) checked at 725 (mid-loop → flush + `autoscaledPool.abort()` at 735), 798 (pagination gate), 809-811 (post-loop abort). With `maxConcurrency > 1`, in-flight pages interleave between the `await`s → **overshoot beyond `maxItems` is possible**; `autoscaledPool.abort()` is cooperative, not immediate.
10. **`requestHandlerTimeoutSecs: 180` vs `waitForManualSolve` 180 s (local mod):** a full-length manual solve races the handler timeout — Crawlee can kill the request at the same moment the human finishes. Also pre-warm (60 s) + challenge waits (45 s) + PX hold (10 s) + delays can approach 180 s even upstream.
11. **`_throwOnBlockedRequest` private-API override** (634-644): silently stops working if Crawlee renames/removes the method (guarded by `?.`, so failure is *silent* — 403s would suddenly retire sessions before challenge handling).
12. **UA/browser mismatch:** `randomUserAgent()` includes Firefox and Safari UAs (`utils.js:18-27`) while the browser is always Chrome (`useChrome: true`, 276) — a Chrome browser presenting a Firefox UA (with no `sec-ch-ua`) is trivially detectable. ~4/12 of the UA pool is mismatched.
13. **cf_clearance lifetime unmanaged:** validity is checked only at request start (334-338); expiry mid-session surfaces as a 403 storm → 8 retries → lost URL (§5 hole #2).
14. **`button` catch-all in `tryHoldPxButton`** (129): if PX markup isn't found, the code may press-and-hold an arbitrary page button for 10 s.
15. **Challenge detection by substring** (97-119): page content containing e.g. "PerimeterX" or "Just a moment" in a listing description would false-positive (low probability, non-zero).
16. **BaseRow dedup via full-text `search`** (baserow.js:96-102): can miss existing rows (→ duplicates) or match wrong rows; `null` IDs search for `"null"`.
17. **Login-wall detection by URL substring** (594): `/giris` anywhere in the URL (including query strings of legitimate pages) triggers session retirement.

---

## 15. Local modifications (today, uncommitted — NOT upstream)

`git status`: ` M src/main.js` (only modified file). Verified via `git diff` against `a14740c`. Net **+38 lines**. Three logical changes:

### 15.1 `waitForManualSolve(page, timeoutMs = 180000)` — new function (`main.js:190-209`)

- Active **only when `process.env.HEADLESS === 'false'`** (193) — i.e., headed mode with a visible browser.
- Logs a Turkish prompt asking the human to solve the verification ("Basılı Tutun" / "robot değilim"), then polls every 3 s (197) until the page is no longer a PX/CF challenge and the URL is not `/giris` (201) → returns `true`. Times out after 3 min → warning + `false` (206, 208). Headless mode → immediate `false`.
- **Human-in-the-loop, not automated bypass** — aligned with the project's legal boundary.

### 15.2 iframe search inside `tryHoldPxButton` (`main.js:133-144`)

- Upstream searched only the main frame (`page.$(sel)`). Local mod builds `[page, ...page.frames().filter(f => f !== page.mainFrame())]` (134) and tries every selector in every frame (135-144), logging which frame matched (139). Motivation (comment, 133): PX captcha often renders inside an iframe.

### 15.3 `waitForManualSolve` call sites in `postNavigationHooks` — **FOUR sites** (not three)

At each site, upstream's immediate `session.markBad(); throw …` was wrapped: try automated solve → **then offer manual solve** → only markBad+throw if the human also fails/times out:

| # | Line | Failure point | Upstream behavior |
|---|---|---|---|
| 1 | 526 | PX hold challenge, automated hold failed (`<status>-px-hold-failed`) | `markBad` + throw `'PerimeterX hold challenge not resolved'` |
| 2 | 545 | CF resolved into a PX hold, automated hold failed (`<status>-cf-then-px`) | `markBad` + throw `'PerimeterX hold challenge not resolved after CF'` |
| 3 | 554 | CF challenge navigated to another challenge (`<status>-challenge-still-blocked`) | log *"…Marking session bad."* + `markBad` + throw `'Cloudflare Turnstile challenge requires manual verification'` |
| 4 | 566 | CF challenge navigation timeout (`<status>-challenge-timeout`) | log *"…Retrying."* + `markBad` + throw `'Cloudflare challenge timeout'` |

Also two log-message changes: line 552 *"Marking session bad."* → *"Waiting for manual solve..."*; line 564 *"Retrying..."* → *"Waiting for manual solve..."*.

**Unchanged upstream behavior:** the `<status>-unknown-block` branch (572-577), tloading branch (581-591), and login-redirect branch (594-597) still markBad+throw immediately with no manual-solve offer.

---

## 16. Local experiment: `scrape-real-chrome.mjs` (128 LOC, untracked)

**Not upstream.** A standalone script that proved a fundamentally different architecture.

### Approach

1. **Attaches to the user's real, running Chrome** via CDP: `puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })` (line 43) — Chrome started with `--remote-debugging-port=9222` and the user's real profile (`.chrome-debug-profile/`).
2. Uses **plain `puppeteer`** (line 2) — no puppeteer-extra, **no stealth plugin, no proxy, no fingerprint spoofing, no UA rotation**.
3. Reads `sessionCookies` from the Apify-style `storage/key_value_stores/default/INPUT.json` (10-11) and injects them simplified (48-56: name/value/domain/path/secure only — no expiry filtering, no sameSite).
4. Challenge handling = **human-in-the-loop only**: `isChallenge` regex (16-19, adds `Press & Hold`, `Olağan dışı erişim`, `/olagan-disi-kullanim` vs. upstream's list) + `waitClear` (22-34) polls every 2.5 s until a human resolves any challenge in the visible window.
5. Paginates category pages with the **same core selectors** (`tr.searchResultsItem` at 68/80; `a.prevNextBut[title="Sonraki"]:not(.passive)` at 114), 4-8 s random delays (8, 119), `domcontentloaded` navigations (60, 120).
6. Extraction (80-98): `id` from `data-id`; `attrs` = **all** `td.searchResultsAttributeValue` cells as an array (more robust than upstream's first-cell-only `area`); dedup by `id` via `Set` (64, 101-103); `parsePrice` duplicates `utils.formatPrice` logic (36-41).
7. Output: plain JSON file (`storage/adana-seyhan-ilanlar.json` by default, 7, 124). Shape differs from upstream baseline (§12): `{ id, url, title, price_raw, price, location, date, attrs[], image }` — no `price_currency`, `price_per_sqm`, `scrapedAt`, `sourceUrl`, no `normalizeText`.
8. Env-var driven: `SCRAPE_URL`, `SCRAPE_MAX`, `SCRAPE_OUT` (5-7).

### Proven result

**1008 listings scraped with 100% reliability — zero bot-detection challenges encountered** (real browser + real profile + authorized cookies + human present).

### Why it matters for the future architecture

- **Real-browser CDP mode sidesteps the entire anti-bot arms race.** Every security-sensitive mechanism in §11 (stealth plugin, fingerprint overrides, PX auto-hold, CF auto-wait, residential proxies, UA forging) exists solely to make a *fake* browser look real. Attaching to an *actual* browser makes all of it unnecessary — technically simpler **and** legally cleaner.
- The Apify/Crawlee machinery (session pool, proxy configuration, request queue, `_throwOnBlockedRequest` hack) is mostly there to support that arms race; a CDP-attached design needs only: connect → inject authorized cookies → navigate politely (delays, pagination) → extract → write local storage.
- The `attrs`-array extraction and `Set`-based ID dedup are concrete improvements over upstream worth carrying into the migration.
- Gaps to address in the migrated design: output-shape parity with the §12 baseline, `normalizeText`/currency handling, structured storage (vs. one JSON file), and graceful resume.

---

## 17. Migration-relevant summary — top 10 facts for the architect team

1. **Thin Apify surface.** Only 10 `Actor.*` call sites (§2 table) plus Crawlee's `Session`/`enqueueLinks`/`log` APIs stand between this code and local-first. A small adapter (init/getInput/pushData/setValue/exit/createProxyConfiguration) fully de-Apifies it.
2. **The regression baseline is 13 category-page fields** (`id, url, title, price, price_currency, price_raw, price_per_sqm, area, location, date, image, scrapedAt, sourceUrl`, §12) with quirky mixed nullability (`''` vs `null`) — preserve it exactly. Detail-page scraping was removed upstream (commit `17ca197`) and the README still advertises it — **README is not a spec** (8 inconsistencies, §10.3).
3. **All anti-bot machinery is disposable.** Stealth plugin, fingerprint overrides, PX auto-hold, CF auto-waiting, residential-proxy forcing (§11) are TO BE REMOVED per legal boundary — and the local experiment proved (1008 listings, 100% reliability) that **real-Chrome CDP attachment eliminates the need for every one of them** (§16).
4. **Authorized cookie injection is the one keeper** (`main.js:285-331`): once-per-session, `key→name` normalization, expiry filtering, `.sahibinden.com` default domain. Preserve semantics even if the transport changes.
5. **Retry/error handling has two silent-loss holes:** `handleCategoryPage` swallows all extraction errors (no retry, `main.js:813-816`) and `failedRequestHandler` only logs (626-630). The migration must decide deliberately how to record failures.
6. **DETAIL routing is dead weight:** label assignment (839-840) + detail-header forging (404-431) exist, but no detail handler does. Drop it or re-implement it — don't port the vestige.
7. **The code monkey-patches Crawlee internals** (`_throwOnBlockedRequest`, 634-644; `autoscaledPool.abort()`, 735/811). These are version-fragile and unnecessary in a CDP-attached design — do not carry them over.
8. **Session pinning exists because cf_clearance is UA- and cookie-bound** (once-per-session injection, `warmedUp` pre-warm, per-session UA, `persistCookiesPerSession`). If any headless/Crawlee mode survives, this coupling must survive with it; in real-browser mode the user's profile handles it natively.
9. **Legal hygiene is unresolved upstream:** no LICENSE file (despite `"license": "ISC"` in package.json), no lockfile, wildcard/`latest` dependency pins. The migration should not inherit these ambiguities.
10. **BaseRow is a replaceable, mostly-dead sink:** hardcoded hosted `api.baserow.io`, sequential per-row GET+POST/PATCH dedup via full-text search, and a 25-column schema of which ~15 columns are always empty since detail scraping was removed. Local storage (SQLite/JSONL) is a strict improvement.

---

*Audit complete. Findings verified against working tree at commit `a14740c` + uncommitted local modifications, 2026-09-14.*
