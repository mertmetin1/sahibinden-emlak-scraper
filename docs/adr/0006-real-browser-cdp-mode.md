# ADR 0006: Real-Browser CDP Attach Mode (Dual-Mode BrowserProvider)

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** Architecture Agent
- **Related:** ARCHITECTURE.md §0.2, §0.3, §3.4; ADR-0002

## Context

Production testing on 2026-09-14 established that sahibinden.com is protected by **Cloudflare + PerimeterX**. Datacenter *and* residential proxies, combined with automation-browser fingerprints, get challenged (see `cloud-blocked.png` in the repo root). The only 100% reliable local method found was:

1. The user launches their **own real Chrome** with `--remote-debugging-port=9222` and a dedicated profile directory (`.chrome-debug-profile`).
2. The crawler attaches via CDP (`puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })`) — proof of concept: `scrape-real-chrome.mjs`.
3. Authorized, user-supplied cookies are injected once; if a challenge appears, the **human user solves it once, manually, in their own browser**; the crawler then proceeds with normal automation (navigate, read DOM, paginate with polite delays).

At the same time, the system needs a conventional managed-browser mode for development, CI, tests, and any future low-protection targets. One acquisition interface must hide both modes so the crawl runtime, configuration, and UI stay mode-agnostic.

## Decision

Define a single **`BrowserProvider`** interface in `packages/scraper-engine` with two implementations, selected per run via `browserMode` (`AppSetting` `browser.mode`, captured into the run's `configurationSnapshot`):

- **`ManagedBrowserProvider`** — `puppeteer.launch()` of a local Chromium/Chrome with vanilla options. Honors `proxyProfileId` (per-launch `--proxy-server` / per-page auth), the full `SessionPolicy` pool, and headless operation. **No stealth plugin, no fingerprint overrides** (removed in ADR-0002).
- **`CdpBrowserProvider`** — `puppeteer.connect({ browserURL: cdpEndpointUrl, defaultViewport: null })` against the user-launched real Chrome. Behavioral contract:
  - The browser process is **user-owned**: on release the worker calls `browser.disconnect()` only — never `browser.close()`, never kills the process.
  - Cookies from the referenced `CookieProfile` are injected once at attach time.
  - On challenge detection (`parser.detectPageState` → `CHALLENGE`), the engine **pauses and waits**, emitting an `AUTH_REQUIRED`-flavored event instructing the user to solve the challenge in their browser window; it polls until the page clears or the navigation timeout expires. **No automated solving is attempted.**
  - `proxyProfileId` is **ignored** in this mode (an already-running Chrome uses the user's own network stack); a warning event is emitted if one is set. Session pooling collapses to a single sticky session (`poolSize` forced to 1) because one real profile exists.
  - Pages opened by the crawler are closed at run end; the user's other tabs are untouched.

Both modes perform **normal browser automation only**: navigate, wait for selectors, read the DOM, paginate with `delayMinMs`/`delayMaxMs` jitter, honor retries/backoff and session health. The CDP endpoint URL is operator configuration (`CHROME_CDP_URL` env / `browser.cdpUrl` setting; `host.docker.internal` mapping provided in compose for Chrome running on the Docker host).

## Alternatives considered

- **Stealth plugins / fingerprint spoofing (upstream approach)** — forbidden by the legal boundary and empirically unreliable against CF+PX; rejected (removed in ADR-0002).
- **Automated challenge solving (upstream `tryHoldPxButton`, solver services)** — explicitly forbidden; rejected.
- **Residential-proxy-only managed mode** — tested; still challenged; also adds recurring cost; rejected as the primary path, retained as an allowed option within MANAGED mode.
- **Playwright with stealth patches / undetected-chromedriver** — same forbidden fingerprint-evasion category; rejected.
- **Remote browserless / headless-browser SaaS** — violates local-first and reintroduces datacenter fingerprints; rejected.
- **CDP-only (drop managed mode)** — would break CI, unit/E2E tests, and future unprotected sources; rejected.

## Consequences

**Positive**

- Production crawling of sahibinden.com actually works — it is the only empirically verified path — while staying inside the legal boundary: the browser is the user's own, cookies are user-supplied and authorized, and any challenge is solved by the human user themselves.
- One interface keeps the engine, config model, and UI mode-agnostic; switching modes is a setting, not a code change.
- No stealth/fingerprint code remains to maintain, audit, or break on Chrome upgrades.
- MANAGED mode preserves a fully automated path for tests/CI and low-protection targets.

**Negative**

- CDP mode requires a manual operator step: launch Chrome with the debug flag and dedicated profile, and occasionally solve a challenge by hand. Documented as an operator runbook item.
- CDP mode is single-session and single-machine (the Chrome must be reachable from the worker container); no proxy rotation and no horizontal scaling in this mode.
- Attaching to a real browser carries hygiene risks (crawler pages share the profile); mitigated by mandating a **dedicated profile directory**, closing only crawler-created pages, and never touching other tabs.
- Chrome must keep the debug port open during runs; port exposure is mitigated by binding guidance (localhost / host-only) in operator docs.

## Compliance notes

This ADR exists **because of** the legal boundary. CDP mode is deliberately designed as *normal browser automation with authorized user-supplied cookies*: it contains **no** CAPTCHA/Turnstile/PerimeterX auto-solving (challenge resolution is a manual act by the human operator in their own browser), **no** fingerprint spoofing (the browser is a genuine, unmodified Chrome with its real fingerprint — nothing is forged), **no** credential theft (cookies are exported and supplied by the user themselves), and **no** defeat of click-to-reveal mechanisms (phone numbers are stored only when visible in the initially rendered page, ARCHITECTURE.md §0.2/§5 `Seller.phone`). The upstream's stealth plugin and PX auto-hold solver were removed in ADR-0002 and must not be re-introduced as a "CDP enhancement."
