# ADR 0002: Remove the Apify Runtime (and Upstream Evasion Code)

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** Architecture Agent
- **Related:** ARCHITECTURE.md §0.2, §3; ADR-0006

## Context

The upstream `tyegen/sahibinden-emlak-scraper` is an Apify Actor: `Actor.init()`, `Actor.getInput()`, `Actor.pushData()`, `Actor.createProxyConfiguration()`, and the Apify KV store for debug artifacts. It also bundles `puppeteer-extra-plugin-stealth`, an `evaluateOnNewDocument` fingerprint-override block (navigator/WebGL/screen spoofing), and `tryHoldPxButton()` — a programmatic PerimeterX "press-and-hold" solver.

The target product is **local-first and self-hosted**: Postgres instead of the Apify dataset, the filesystem instead of the KV store, user-managed proxies instead of Apify Proxy, BullMQ instead of the Actor lifecycle. Keeping the Apify SDK would drag a cloud-platform runtime into a product whose defining requirement is independence from it.

Separately, the project's **legal boundary** forbids CAPTCHA/Turnstile/PerimeterX auto-solving and fingerprint spoofing to defeat access controls. The stealth plugin and the PX auto-hold solver are squarely inside the forbidden zone.

## Decision

Remove the Apify runtime entirely and replace each capability with a local equivalent:

| Upstream (Apify) | Replacement |
|---|---|
| `Actor.init()` / `Actor.exit()` | `apps/worker` process lifecycle + BullMQ job wrapper (ARCHITECTURE.md §6) |
| `Actor.getInput()` | `ScanRun.configurationSnapshot` → `CrawlConfig` (§4.2) |
| `Actor.pushData()` | `OutputRepository.saveListing()` over Prisma/Postgres (§3.2, §5) |
| `Actor.createProxyConfiguration()` (Apify Proxy) | `ProxyProvider` over user-managed `ProxyProfile`/`ProxyEndpoint` rows (§5) |
| `Actor.setValue()` KV debug artifacts | `DebugArtifactStore` on a local filesystem volume (§11) |
| Apify dataset export | `GET /api/v1/listings/export?format=csv` (§7.3) |

In the same de-Apify pass, **delete** — do not port:

- `puppeteer-extra` and `puppeteer-extra-plugin-stealth` (vanilla `puppeteer` only).
- The `evaluateOnNewDocument` fingerprint-override block (navigator.webdriver, plugins, WebGL vendor, screen spoofing).
- `tryHoldPxButton()` and all automated challenge-solving code paths.
- The `_throwOnBlockedRequest` monkey-patch (internal Crawlee API abuse tied to the evasion flow).
- Cookie-value debug logging (replaced by redacted metadata logging, §9.3/§11).

Challenge pages are now *detected* (via `parser.detectPageState`) and surfaced as `AUTH_REQUIRED`/`RATE_LIMIT` errors or as a human-in-the-loop wait in CDP mode (ADR-0006) — never auto-solved.

## Alternatives considered

- **Keep the Apify SDK in "local mode"** — the SDK still assumes Actor storage semantics and adds a heavy dependency for capabilities we replace anyway; rejected.
- **Keep stealth but make it configurable** — a forbidden capability behind a flag is still a shipped forbidden capability; rejected on legal-boundary grounds.
- **Fork upstream and patch incrementally without removing Apify** — preserves the exact coupling (storage, proxy, lifecycle) the migration exists to remove; rejected.

## Consequences

**Positive**

- Zero cloud-platform coupling; the whole system runs from `docker compose up`.
- Persistence lands in a queryable relational model (price history, staleness, seller intelligence) instead of an opaque dataset.
- Codebase becomes compliant with the legal boundary by construction, not by policy.
- Removing the Crawlee internals monkey-patch unblocks safe Crawlee upgrades.

**Negative**

- We re-implement conveniences Apify provided (proxy rotation, KV artifacts, input schema) — accepted, as local versions are small and specified.
- Apify platform users cannot run the new system as an Actor (out of scope; different product).
- Without stealth, MANAGED browser mode will be challenged more often on sahibinden.com — mitigated by CDP mode (ADR-0006), which is the documented production path.

## Compliance notes

This ADR is a **legal-boundary action item**, not just a refactor. The upstream contains (a) a stealth/fingerprint-spoofing plugin and overrides whose purpose is to defeat bot access controls, and (b) an automated PerimeterX "Basılı Tutun" hold-solver. Both are **forbidden** by the project boundary and are removed here. What remains is explicitly allowed behavior only: normal browser automation, user-supplied authorized cookies, user-supplied proxies with rotation, rate limiting, retries/backoff, session persistence, and human-performed challenge solving in the user's own browser (CDP mode). Any future PR re-introducing automated challenge solving or fingerprint spoofing must be rejected on review against this ADR and ARCHITECTURE.md §0.2.
