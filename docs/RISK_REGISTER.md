# Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|----|------|-----------|--------|------------|-------|
| R1 | **No upstream LICENSE file** — repo declares `"license": "ISC"` in package.json but ships no LICENSE; derivative-work rights are ambiguous | High | Medium | Document in `docs/UPSTREAM.md`; keep attribution; consider contacting upstream author; treat code as reference implementation | Lead |
| R2 | **Anti-bot arms race** (Cloudflare + PerimeterX) — selector/behavior drift can break crawling silently | High | High | Versioned selector registry + PARSER_CHANGED classification + fixture tests + debug artifacts; CDP real-browser mode as primary local path (proven 100% reliable today) | A3/A4 |
| R3 | **Legal/ToS boundary** — automated challenge solving is out of scope | — | — | Enforced by construction: stealth plugin & PX auto-hold deleted (ADR-0002); human-in-the-loop only; authorized cookies only | A9 |
| R4 | **CDP mode operationally depends on user's Chrome** running with debug port; proxies/session pool don't apply (see ARCHITECTURE §3.4) | Medium | Medium | Managed-browser mode as alternative; clear UI indication of mode; health check detects CDP endpoint absence | A3/A10 |
| R5 | **Cookie expiry** — session cookies (e.g. `st`) live ~24h; PX tokens ~minutes | High | Low | CookieProfile expirySummary + validationStatus; UI warns on expiry; re-import flow | A5/A7 |
| R6 | **Account flagging** — aggressive crawling from a logged-in session may risk the user's sahibinden account | Medium | High | Rate limiting (delayMinMs/delayMaxMs), maxPages caps, incremental mode, SESSION_STICKY, conservative defaults; documented in TROUBLESHOOTING | A6 |
| R7 | **Silent data loss** (upstream holes: swallowed extraction errors, log-only failedRequestHandler) | — | — | Fixed by design: classified errors, per-item isolation, failed-request persistence in ScanRun | A3 |
| R8 | **Stale RUNNING runs after worker death** | Medium | Medium | Heartbeats + sweeper marks FAILED; `maxStalledCount: 0` (no auto re-run of side-effecting jobs) | A6 |
| R9 | **Secret leakage** via logs/UI/artifacts | Low | High | AES-256-GCM at rest, write-only API, Pino redaction paths, artifact rules (never cookies), tests scanning logs for secrets | A9 |
| R10 | **SSRF via arbitrary startUrls** | Medium | Medium | Allowed-domain policy (default: sahibinden.com only), Zod URL validation, no redirects to off-domain | A9 |
| R11 | **DB growth** — full-history price/seen records on frequent schedules | Medium | Low | Retention settings for artifacts; indexes; optional pruning job in maintenance queue | A5 |
| R12 | **Non-reproducible upstream builds** (`puppeteer: "*"`, no lockfile) | — | — | pnpm lockfile, pinned deps, dependency audit in CI | A10 |
| R13 | **Single-node assumption** — BullMQ + Postgres on one host; no HA | Accepted | Low | Documented; compose restart policies; backup script for Postgres | A10 |
| R14 | **Detail-page volume** — includeDetails multiplies requests ~50×/page; raises R6/R2 exposure | Medium | Medium | includeDetails off by default; detail concurrency separate & lower; incrementalMode skips known-unchanged | A3/A6 |

## Standing decisions

- **D1:** CDP real-Chrome mode is the reference local runtime (evidence: 2026-09-14, 1008/1008 listings, zero challenges after one human-in-the-loop solve).
- **D2:** Automated challenge solving code from upstream is removed and its re-introduction is a review-blocking violation (ADR-0002/0006).
- **D3:** Postgres is run-state truth; BullMQ is transport only.
