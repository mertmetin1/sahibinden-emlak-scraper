# Upstream Attribution

| | |
|---|---|
| **Repository** | https://github.com/tyegen/sahibinden-emlak-scraper |
| **Baseline commit** | `a14740c46d22998dea932c9aa673b61f11089b8c` ("docs: add AI assistant prompt and critical session cookie warning", 2026-05-04) |
| **License** | ⚠️ **No LICENSE file in upstream.** `package.json` declares `"license": "ISC"` but no license text exists; default copyright applies. See `RISK_REGISTER.md` R1. Attribution retained regardless. |
| **Upstream author** | `tyegen` (GitHub) |

## Files originally imported (upstream, unmodified unless noted)

| File | Status |
|---|---|
| `src/main.js` | **Modified locally** (2026-09-14): human-in-the-loop `waitForManualSolve`, iframe search in `tryHoldPxButton`, 4 manual-solve call sites in postNavigationHooks. Upstream version recoverable via `git show a14740c:src/main.js`. |
| `src/utils.js` | Unmodified |
| `src/baserow.js` | Unmodified |
| `package.json` | Unmodified |
| `README.md` | Unmodified (stale vs. code — see UPSTREAM_AUDIT §10.3) |
| `.actor/*` | Unmodified (Apify packaging — to be retired in Phase 4) |
| `.gitignore`, `.dockerignore` | Unmodified |

## Local additions (not upstream)

| File | Purpose |
|---|---|
| `scrape-real-chrome.mjs` | CDP real-Chrome experiment — proof-of-concept for the target architecture's CDP browser mode (ADR-0006). 1008 listings, 100% reliability. |
| `scripts/capture-fixtures.mjs` | Fixture capture via authorized browser session |
| `scripts/sanitize-fixtures.mjs` | Fixture sanitization (phones, names, member IDs) with verification pass |
| `scripts/inspect-*.mjs` | One-off fixture inspection helpers |
| `fixtures/**` | Sanitized HTML fixtures + baseline outputs (see BASELINE_CONTRACT.md §5) |
| `docs/**` | Project documentation |

## Local changes policy

Every behavior-changing migration step is logged in its `PHASE_REPORT.md` (before → after → tests → known differences), per `IMPLEMENTATION_PLAN.md`.
