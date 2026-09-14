# ADR 0001: pnpm Monorepo (apps + packages)

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** Architecture Agent
- **Related:** ARCHITECTURE.md §2

## Context

The upstream project is a single Apify Actor script. The target system has three deployable processes — `api` (Fastify), `worker` (BullMQ + Crawlee), `web` (Next.js) — that share domain types, event names, error codes, Zod contracts, the Prisma client, and the scraper runtime. We need:

- One repository with atomic cross-component changes (e.g. adding an event field touches `shared`, `worker`, `api`, `web` in one commit).
- Strict package boundaries so the scraper engine cannot accidentally depend on the database, and the API cannot depend on Puppeteer.
- Fast, disk-efficient installs with exact dependency isolation (Puppeteer/Chromium must land only in the worker image; Next.js only in the web image).
- TypeScript project references for fast incremental builds.

## Decision

Use a **pnpm 9 workspaces monorepo**:

- `apps/api`, `apps/worker`, `apps/web` — deployables.
- `packages/scraper-engine`, `packages/parser-sahibinden`, `packages/database`, `packages/shared`, `packages/config` — libraries.
- All workspace packages named `@sahibinden/*`, consumed via `workspace:*` protocol.
- `tsconfig.base.json` at root (strict, `noUncheckedIndexedAccess`); per-package `tsconfig.json` with project references.
- Dependency-direction rules (ARCHITECTURE.md §2.2) enforced in CI with `eslint-plugin-boundaries` / `dependency-cruiser`.
- Plain pnpm scripts for orchestration (`pnpm -r build`, `pnpm --filter @sahibinden/worker test`); no Turborepo/Nx at this size.
- Lockfile-driven, multi-stage Docker builds using `pnpm fetch` / `--filter ... --prod` so each image contains only its own dependency closure.

## Alternatives considered

- **Single package, path aliases** — simplest, but no enforceable boundaries; the worker's Puppeteer would leak into the api image; rejected.
- **npm/yarn workspaces** — workable, but slower installs, less strict about phantom dependencies, heavier node_modules; pnpm's strictness is a feature for boundary discipline.
- **Turborepo / Nx on top** — real benefits (remote caching, task graphs) but premature for 8 packages on one machine; can be added later without restructuring.
- **Polyrepo** — version-skew pain across shared types; rejected for a single-operator product.

## Consequences

**Positive**

- Shared types/events/contracts have exactly one definition; API and UI can never drift.
- Boundary rules are machine-enforced, keeping `scraper-engine` site- and DB-agnostic (testable with fakes).
- Small, purpose-built Docker images; Chromium deps exist only in the worker image.
- One `pnpm install`, one lockfile, reproducible CI.

**Negative**

- pnpm's strict node_modules layout occasionally surfaces phantom-dependency errors in third-party tooling (fix: declare deps explicitly).
- Docker builds need pnpm-aware Dockerfiles (more boilerplate than `COPY . && npm install`).
- Cross-package refactors require building referenced projects (`tsc -b`) rather than ad-hoc ts-node runs.

## Compliance notes

None specific — structural decision. Boundary enforcement (rule: engine must not import `database`) indirectly supports the legal boundary by keeping challenge-handling and browser code isolated and reviewable in one package.
