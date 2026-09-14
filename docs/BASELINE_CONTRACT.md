# Baseline Contract — Known-Working Upstream Behavior

**Upstream:** `tyegen/sahibinden-emlak-scraper @ a14740c46d22998dea932c9aa673b61f11089b8c`
**Captured:** 2026-09-14, via Apify cloud run (residential TR proxy + authorized session cookies) — run ID `bhCcU3D2JghRVdhwa`, dataset `tGQVvhlzy9QgBbY9h`, 20/20 items, SUCCEEDED.
**Purpose:** frozen behavioral reference. Any refactor of the crawler must reproduce this contract before new behavior is layered on.

---

## 1. Category-page output contract (regression baseline)

One dataset item per listing row (built at upstream `src/main.js:759-773`):

```json
{
    "id": "1334491628",
    "url": "https://www.sahibinden.com/ilan/emlak-konut-satilik-...-1334491628/detay",
    "title": "OPERA'DAN BEYLİKDÜZÜNDE %35 PEŞİN 36 AY VADELİ LÜX PROJE 1+1",
    "price": 4749000,
    "price_currency": "TL",
    "price_raw": "4.749.000 TL",
    "price_per_sqm": "",
    "area": "80",
    "location": "Beylikdüzü / Gürpınar",
    "date": "14 Eylül 2026",
    "image": "https://i0.shbdn.com/photos/49/16/28/lthmb_13344916286fx.jpg",
    "scrapedAt": "2026-09-14T15:03:26.477Z",
    "sourceUrl": "https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc"
}
```

### Field rules (preserve exactly)

| Field | Type | Missing-value rule | Notes |
|---|---|---|---|
| `id` | `string \| null` | `null` | `data-id` attr preferred; regex `/(\d{8,12})(?:\/|$)/` fallback |
| `url` | `string` | row skipped without it | absolute detail URL |
| `title` | `string` | row skipped without it | whitespace-collapsed, mojibake-fixed (`normalizeText`) |
| `price` | `number \| null` | `null` | Turkish format: dots = thousands (`4.749.000` → `4749000`) |
| `price_currency` | `string` | `'TL'` default | EUR/€, USD/$, GBP/£ detection; TL even when price null |
| `price_raw` | `string \| null` | `null` | raw cell text |
| `price_per_sqm` | `string` | `''` | `:nth-of-type(2)` price cell — column-order dependent |
| `area` | `string` | `''` | **first** attribute cell only (fragile — see risks) |
| `location` | `string` | `''` | newlines → `' / '` |
| `date` | `string` | `''` | newlines → `' '`; Turkish month names |
| `image` | `string \| null` | `null` | first `img` `src \|\| dataset.src` |
| `scrapedAt` | `string` | never null | ISO 8601 UTC |
| `sourceUrl` | `string` | never null | category page URL |

### Behavioral rules

- Rows lacking `title` or `url` are **silently skipped** (debug log only).
- Dataset write granularity: one batch push **per category page**.
- Pagination: follows `a.prevNextBut[title="Sonraki"]:not(.passive)` until absent; `maxItems` caps items (racy under concurrency — overshoot possible); hard cap `maxRequestsPerCrawl = maxItems*3` (default 1000).
- Dedup: none upstream within/across runs (dataset append-only). Our CDP experiment added `Set`-based ID dedup — carry that forward.

### Captured baseline files

| File | Source | Items |
|---|---|---|
| `fixtures/baseline/upstream-category-output-istanbul-20.json` | Upstream actor, Apify cloud run | 20 |
| `fixtures/baseline/cdp-category-output-adana-seyhan-1008.json` | Local CDP experiment (`scrape-real-chrome.mjs`) — **different shape** (`attrs[]`, no currency/scrapedAt/sourceUrl) | 1008 |

> The two baselines have **different shapes** — upstream contract (this doc) is the regression target; the CDP file is reference data for parser robustness.

## 2. Input contract (per code, not README)

| Field | Default | Required | Notes |
|---|---|---|---|
| `startUrls` | İstanbul satılık daire, date_desc | yes | strings or `{url}` objects; only `startsWith('http')` checked — **no domain validation upstream** (we add an allowed-domain policy) |
| `maxItems` | `null` (all) | no | drives `maxRequestsPerCrawl` |
| `maxConcurrency` | `3` | no | schema caps 1-10; code unbounded |
| `proxyConfiguration` | Apify RESIDENTIAL/TR | no | soft-forced; user can override |
| `sessionCookies` | `[]` | no | `name`/`key` + `expirationDate`/`expires` tolerated |
| `debugMode` | `false` | no | screenshots+HTML to KV store |
| `baseRow*` | — | no | all three required to activate BaseRow sink |

## 3. Challenge/edge behavior contract

- Login wall (`/giris` redirect) → error `Mandatory login required` (session cookies missing/expired).
- `/cs/tloading` interstitial → wait ≤30 s for JS redirect.
- 403/503/429 → challenge detection (CF/PX substrings) → *(upstream: auto-solve — REMOVED in our product per legal boundary)* → our contract: classify `AUTH_REQUIRED`/`RATE_LIMIT`, human-in-the-loop or fail the request, never auto-solve.
- Extraction failure of a whole page → upstream swallows (success + zero data). **Our contract: classify `PARSER_CHANGED` when zero rows on a non-empty results page; never silently succeed-empty.**
- Individual malformed row → skip row, continue page (isolated failure).

## 4. Detail-page contract (NEW — no upstream baseline)

Upstream removed detail scraping (`17ca197`); README still advertises it. Our detail contract is defined fresh in ARCHITECTURE.md §5 (generic `attributesRaw` extractor first, then normalized fields, seller classification with evidence, images as records).

**Critical parser finding (fixtures, 2026-09-14):** seller name and phone on detail pages are rendered via **CSS `:before` content obfuscation** (`<style>.css<uuid>:before{content:'…'}</style><span class="css<uuid>"></span>`) — the text is NOT in the DOM as text nodes. Detail parser must resolve CSS-content fields. Phones additionally appear masked in `data-encrypted` and full in `data-opened` attributes; per legal boundary we only read what the normally rendered authorized page shows, and never automate any reveal interaction.

## 5. Fixtures inventory (sanitized)

| Fixture | Captured | Sanitization |
|---|---|---|
| `fixtures/html/category-satilik-adana-seyhan.html` | 2026-09-14, real category page (50 rows) | account name masked |
| `fixtures/html/detail-sample-1.html` | office listing (gayrimenkul ofisi) | phone, office name, agent name, member ID masked |
| `fixtures/html/detail-sample-2.html` | office listing, full agent name variant | phone, office, agent, subdomain masked |
| `fixtures/html/detail-sample-3.html` | **individual owner** listing, CSS-obfuscated name/phone | owner name + phone masked |

Sanitizer: `scripts/sanitize-fixtures.mjs` (idempotent, verification pass included — must exit 0). Business store subdomains of third-party offices appearing incidentally in category-page links are kept as public commercial data (needed for seller-classification realism); all personal data is masked.
