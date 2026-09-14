# ADR 0005: AES-256-GCM Encryption for Secrets at Rest

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** Architecture Agent
- **Related:** ARCHITECTURE.md §10

## Context

The system stores two categories of user-supplied secrets in Postgres:

1. **Cookie profiles** (`CookieProfile.encryptedCookieJson`) — full session cookie exports for sahibinden.com; equivalent to a logged-in session.
2. **Proxy endpoint URLs** (`ProxyEndpoint.encryptedUrl`) — frequently embed `username:password` credentials.

A database dump, a leaked backup, or an over-permissive API response must not expose these. The product is self-hosted by a single operator, so a heavyweight external KMS is disproportionate; but plaintext-at-rest is unacceptable. The API must also be **write-only** for secrets: after save, no endpoint returns them.

## Decision

Encrypt secret columns with **AES-256-GCM** using a single application key:

- **Key:** `APP_SECRET_KEY` env var — 32 bytes, base64-encoded (`openssl rand -base64 32`). Validated at boot by `packages/config` (presence, base64, exact 32-byte length); the process refuses to start without it. Injected via `.env` / compose environment; never committed (`.env.example` documents it empty).
- **Envelope:** single text column, format `v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>` — fresh random 12-byte IV per record, 16-byte GCM auth tag. The `v1` prefix versions the scheme for future rotation/algorithm changes.
- **Implementation:** `createSecretBox(key)` in `packages/shared/src/crypto` — pure functions `encrypt(plaintext)` / `decrypt(envelope)` over Node `crypto`; the key is passed in by callers (`database` repositories / worker providers), so `shared` stays env-free.
- **Write-only API contract:** create/update endpoints accept secrets; all read endpoints return metadata only (`cookieCount`, `domainSummary`, `expirySummary`, `validationStatus`; proxy `host`/`port`/`protocol`). Decryption happens **only inside the worker** (cookies → `SessionProvider`, proxy URLs → `ProxyProvider`) and plaintext never crosses a process boundary or enters logs/events (`redactSecrets` utility + Pino redact paths, ARCHITECTURE.md §9.3).
- **Rotation:** `pnpm -C packages/database rotate-secrets` maintenance command — decrypt with old key, re-encrypt with new; run with both keys present (`APP_SECRET_KEY_OLD`).
- **Not encrypted:** non-secret operational data (listing content, run counters, proxy host metadata) — kept plaintext for search and display.

## Alternatives considered

- **Plaintext columns** — simplest; unacceptable leak blast radius for session cookies; rejected.
- **pgcrypto / Postgres TDE** — moves the key problem into the DB, complicates Prisma usage, and still returns plaintext to any client that can query; rejected.
- **HashiCorp Vault / cloud KMS** — correct at larger scale, but a heavy always-on dependency for a single-host self-hosted app; the envelope format allows migrating to a KMS-wrapped key later without changing column layout.
- **libsodium secretbox (XSalsa20-Poly1305)** — excellent primitive, but AES-256-GCM is native to Node `crypto` (no native dependency in the worker image) and hardware-accelerated; chosen for operability.
- **Per-record data keys (envelope encryption with KEK)** — stronger isolation, unnecessary complexity at single-tenant scale; `v1` prefix leaves the door open.

## Consequences

**Positive**

- DB dumps and backups are safe: secrets are useless without `APP_SECRET_KEY`.
- GCM authentication detects tampering/corruption of secret columns.
- Write-only API + redaction makes accidental secret exposure through the UI, SSE, or logs a code-review-visible event.
- Zero external dependencies; works fully offline (local-first requirement).

**Negative**

- Key loss = unrecoverable secrets (users must re-upload cookie profiles). Documented in operator docs; acceptable for re-exportable secrets.
- Key rotation is a manual maintenance command, not transparent.
- Single application key means any process holding it (api, worker) can decrypt — mitigated by the rule that only the worker ever calls `decrypt`, and by non-root containers.
- Encrypted proxy URLs cannot be searched/filtered by URL — mitigated by plaintext `host`/`port`/`protocol` metadata columns.

## Compliance notes

Supports the legal boundary's "authorized, user-supplied cookies" clause: cookies are user-provided, stored encrypted, used only for the user's own crawling runs, and never exposed back through the API. Redaction rules ensure secrets never appear in run events, logs, or debug artifacts (ARCHITECTURE.md §11 — artifacts never contain cookies or `Cookie`/`Authorization` headers).
