# Cloudflare Workers → Self-hosted Docker Migration

> **Status:** Handoff doc · written 2026-06-14, refreshed 2026-07-16
> **Audience:** Receiving engineering team
> **Goal:** Reproduce the current Cloudflare Workers production app on Docker
> (PostgreSQL + S3-compatible storage + direct Gemini API + Redis), keeping
> all user-visible behavior identical.
>
> **Production reference:** https://ocr-web-service.jiatuntiwong.workers.dev
> **Owner contact:** project owner (GitHub: jiatuntiwong-svg)
> **Target deadline:** ~2 weeks from handoff — **re-baseline this against
> the actual handoff date**, this doc has sat 5+ weeks since it was
> originally written and a full OCR Stabilization sprint shipped in the
> meantime (see the 2026-07-16 refresh notes below).
>
> **2026-07-16 refresh notes (what changed since this doc was written):**
> - AI calls are no longer "just Gemini" — `src/lib/ai-handler.ts` now
>   dispatches across **4 providers** (`gemini`, `openai`, `openrouter`,
>   `vertex_ai`), admin-configurable, no code change needed to add a key.
>   §4.3 below undersells this; preserve the provider dispatch, don't
>   collapse it back to a single hardcoded Gemini call.
> - Credit charging goes through a shared helper,
>   `chargeCreditsAtomic()` in `src/lib/credits.ts`, used by **both**
>   `/api/upload` and `/api/v1/extract` — and the credit *model* itself
>   (`per_page` default / `field_formula` / `per_file`) is a runtime
>   switch read from `system_settings`, not a code constant. See §4.1 and
>   §5 updates below.
> - `/api/upload` and `/api/v1/extract` both gained a `mode=fulldoc` path
>   (whole-document transcription instead of field extraction) — same
>   D1/R2/AI call shape, just a different prompt profile and response
>   shape. No new abstraction needed, but don't assume "OCR" only ever
>   means field-extraction when refactoring these routes.
> - A v2 OCR workspace (stepper UI, `ENABLE_OCR_WORKSPACE_V2` flag) and a
>   v2-native batch view are live in prod — pure frontend, no bearing on
>   this migration's backend scope, but if the receiving team is also
>   asked to verify UI parity, know that "the OCR page" now means the v2
>   shell, not the original single-panel layout this doc's screenshots
>   (if any existed) would have shown.
>
> None of the above changes the migration's shape (still D1→Postgres,
> R2→MinIO, `env.AI`→direct SDK calls, `ctx.waitUntil`→BullMQ) — they're
> additive within the same call sites already described below. Treat the
> file-by-file map in §4 as still correct; the notes above are things to
> not accidentally regress.

---

## 1. Why this migration

Move from Cloudflare Workers to the company's internal server stack for:
- Performance for in-network users (LAN latency beats CF edge for office-only traffic)
- Data sovereignty (Thailand-located server, full DC control)
- Removing CF vendor lock-in for future enterprise contracts

User-visible behavior **must stay identical** to the CF version. The owner
will run the acceptance walkthrough described in
[`BEHAVIOR_REFERENCE.md`](BEHAVIOR_REFERENCE.md) against your Docker build.

---

## 2. Current architecture (Cloudflare Workers)

```
[Browser]
   │
   ▼
[Cloudflare Worker / OpenNext-Next.js]
   ├── env.DB              → Cloudflare D1 (SQLite-on-edge)
   ├── env.BUCKET          → Cloudflare R2 (S3-API object storage)
   ├── env.AI              → Cloudflare Workers AI (proxy to Gemini)
   ├── env.ASSETS          → Cloudflare static asset binding
   ├── caches.default      → Cloudflare edge cache (compare-result cache)
   ├── ctx.waitUntil(...)  → Background job after response
   └── crypto.subtle       → Web Crypto (PBKDF2, HMAC)
```

Bindings + config live in [`wrangler.jsonc`](../wrangler.jsonc).
Secrets live in `.dev.vars` locally and `wrangler secret put` in production:
- `GEMINI_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ENTERPRISE`

---

## 3. Target architecture (Docker)

```
[Browser]
   │   (HTTPS via Nginx reverse proxy)
   ▼
[Nginx]
   │
   ▼
[Next.js (standalone build) — Node.js 20]
   ├── lib/db        → PostgreSQL 16 (via Drizzle or Prisma)
   ├── lib/storage   → MinIO (S3-API) — swappable to AWS S3
   ├── lib/ai        → Google Generative AI SDK (direct REST)
   ├── lib/cache     → Redis 7 (compare-result cache + rate limit)
   ├── lib/queue     → BullMQ on Redis (async OCR work)
   └── node:crypto   → Built-in crypto (PBKDF2, HMAC)
```

Recommended `docker-compose.yml` services:
```
  app          Next.js standalone container
  postgres     PostgreSQL 16
  minio        MinIO (S3-compatible)
  redis        Redis 7
  nginx        Reverse proxy + SSL termination
```

---

## 4. File-by-file refactor map

### 4.1 Database access — `env.DB.prepare(...).bind(...).run()`

All occurrences need to swap to a Postgres-backed query layer. The D1 query
shape is roughly compatible with parameterised SQL, but type returns differ
(D1 returns objects directly, Postgres drivers return `{ rows: [...] }`).

**Recommended approach:** introduce a thin `db` abstraction module:
```ts
// src/lib/db/index.ts (new)
export interface DB {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}
// src/lib/db/postgres.ts (new) — wrap `pg` or Drizzle
// src/lib/db/d1.ts (new) — preserve current CF path during transition
```

Then refactor each `env.DB.prepare(...)` call site. Approx 30 call sites,
mostly in `src/app/api/**/*.ts`. The largest are:
- [`src/lib/credits.ts`](../src/lib/credits.ts) — `chargeCreditsAtomic(env, userId, amount)`,
  the single guarded-UPDATE helper shared by **both**
  [`src/app/api/upload/route.ts`](../src/app/api/upload/route.ts) and
  [`src/app/api/v1/extract/route.ts`](../src/app/api/v1/extract/route.ts)
  as of the BILL-1 sprint task — port this one function and both routes'
  credit-safety follows, rather than reimplementing the guard twice.
- [`src/app/api/compare/route.ts`](../src/app/api/compare/route.ts) — credit check + post-run adjust
- [`src/app/api/admin/users/route.ts`](../src/app/api/admin/users/route.ts) — admin user list + edit

**Runtime-switchable config lives in `system_settings`, not just static
tables.** Two D1 rows matter beyond the obvious business tables:
`system_settings.CREDIT_MODEL` (`per_page` / `field_formula` / `per_file`,
read by `getActiveCreditModel(env)`) and `system_settings.AI_POWER_CONFIG`
(JSON array of provider configs — keys, models, which provider is active).
Both are admin-editable at runtime with no redeploy on Cloudflare; the
Postgres port needs the same "read config from DB, not from env/code" path
preserved, or admins lose the ability to switch credit models / AI
providers without a deploy.

### 4.2 Object storage — `env.BUCKET`

R2 is S3-compatible API at the binding level (CF-specific) but the *protocol*
(GET / PUT / DELETE on URLs) is identical to S3. Swap behind an interface:
```ts
// src/lib/storage/index.ts (new)
export interface Storage {
  put(key: string, body: ArrayBuffer | Uint8Array | Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  presignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
// src/lib/storage/s3.ts (new) — uses @aws-sdk/client-s3, MinIO endpoint
// src/lib/storage/r2.ts (new) — preserves env.BUCKET path
```

Call sites:
- `src/app/api/upload/route.ts` — `env.BUCKET.put(...)` for file upload
- `src/app/api/upload/route.ts` — `env.BUCKET.delete(...)` for cleanup after OCR

### 4.3 AI calls — `env.AI` and `generateWithAI`

CF Workers AI provides a binding that proxies to several model providers.
The current code in [`src/lib/ai-handler.ts`](../src/lib/ai-handler.ts)
already calls model providers directly (not through the CF binding) when
keys are provided — so this is the *cleanest* swap. Replace any
`env.AI.run(...)` paths (search for `env.AI`) with the existing direct
path.

**Important — this is multi-provider, not just Gemini.** `generateWithAI(req)`
dispatches on a `provider` string across **four** paths: `gemini` (`@google/generative-ai`
SDK), `openai` (fetch), `openrouter` (fetch), and `vertex_ai` (fetch to the
Vertex Express endpoint, `x-goog-api-key` header — added after this doc was
first written, see `pm/reports/AI-1.md`). Provider + model + key are stored
per-config in `system_settings.AI_POWER_CONFIG` (D1), editable in Admin →
API Settings, with keys always returned masked to the client and never
logged in the clear (`src/lib/redactSecrets.ts`). Preserve this whole
abstraction — don't refactor it down to a single hardcoded Gemini call, and
carry the masking/no-logging behavior into whatever settings UI the Docker
build ships.

### 4.4 Edge cache — `caches.default`

The compare route caches AI JSON responses keyed by `(files + fields + model)`
to avoid re-running AI for identical inputs. See `cacheUrl` and `cf.match` in
`src/app/api/compare/route.ts`.

Replacement: store the same JSON in Redis with the SHA-256 cache key as the
Redis key + 1-day TTL.
```ts
// src/lib/cache/index.ts (new)
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
```

### 4.5 Background work — `ctx.waitUntil(...)`

In CF Workers, `ctx.waitUntil(promise)` lets a handler return immediately
while a Promise continues in the background (typical CF limit ~30s).

The OCR route uses this to: respond with `{ documentId }` immediately, then
run the AI extraction asynchronously, write back to D1 when done.

On Docker / Node, there is no equivalent runtime primitive — but we have a
real process to use. Replace with BullMQ:
```ts
// src/lib/queue/index.ts (new)
export interface Queue {
  enqueue(jobName: string, payload: unknown): Promise<void>;
  process(jobName: string, handler: (payload: unknown) => Promise<void>): void;
}
```

Workflow:
1. Upload route enqueues `ocr-extract` job with `{ docId, fileKey }`.
2. A Node worker process (separate container or same container, separate
   thread) listens on the queue and runs the AI call + DB write.
3. Frontend continues to poll `/api/status?id={docId}` as it does today
   — no client-side change needed.

### 4.6 Crypto — `crypto.subtle`

Code in [`src/lib/passwordHash.ts`](../src/lib/passwordHash.ts) uses Web
Crypto. **Web Crypto is available in modern Node.js (≥20) as global.** No
change needed unless target Node version is older.

### 4.7 OpenNext adapter — `next.config.ts`, `wrangler.jsonc`

These are CF-specific build artifacts:
- `npm run build` → standard `next build` (with `output: 'standalone'` in
  `next.config.ts`)
- `npm run deploy` → replace with `docker build` + push to registry
- `wrangler.jsonc` — keep for reference but no longer used at runtime

### 4.8 Context access — `getCloudflareContext()`

Throughout the codebase, server routes call `getCloudflareContext()` to
fetch `env` (the bindings) and `ctx` (the execution context). On Docker
this function won't exist.

**Recommended:** wrap it in a `getServerContext()` adapter that returns the
new abstractions (`db`, `storage`, `ai`, `cache`, `queue`) regardless of
runtime. During the transition, both CF and Docker can use the same
adapter.

---

## 5. Database schema port (SQLite → PostgreSQL)

Source: [`db/schema.sql`](../db/schema.sql) +
[`db/migrations/`](../db/migrations/).

Type mapping required:
| SQLite | PostgreSQL |
|--|--|
| `TEXT` | `TEXT` |
| `INTEGER` | `INTEGER` or `BIGINT` |
| `REAL` | `DOUBLE PRECISION` or `NUMERIC(p, s)` |
| `DATETIME DEFAULT CURRENT_TIMESTAMP` | `TIMESTAMPTZ DEFAULT now()` |
| `BLOB` | `BYTEA` |
| `AUTOINCREMENT` | `SERIAL` / `BIGSERIAL` / `GENERATED AS IDENTITY` |
| `INTEGER PRIMARY KEY` (rowid) | `BIGSERIAL PRIMARY KEY` |

Migrations are forward-only and named by feature, not timestamped. Run in
this order on Postgres:
```
db/schema.sql
db/migrations/user_preferences.sql
db/migrations/feedback.sql
db/migrations/default_templates.sql
db/migrations/confidence_and_notifications.sql
```

**Important — atomic credit charge:** both the upload route and the public
`/api/v1/extract` route rely on a guarded UPDATE (drain `credits_remaining`
first, then spill into `extra_credits`, `WHERE (credits_remaining +
extra_credits) >= ?`) so parallel requests can't overdraw a user's balance.
This is now centralized in `chargeCreditsAtomic(env, userId, amount)` at
[`src/lib/credits.ts`](../src/lib/credits.ts) rather than duplicated inline
per route (it wasn't, prior to the BILL-1 sprint task — `/api/v1/extract`
had its own unguarded `UPDATE ... - 1` that has since been fixed to call
the same helper as `/api/upload`). Port this one function; both call sites
inherit the fix. Postgres supports the same `MAX(...)`-style guard and
`RETURNING` syntax — no rewrite needed, just make sure the driver passes
`RETURNING` results back.

---

## 6. Data migration (one-shot, after Docker stack stable)

Once the Docker build passes the acceptance walkthrough on synthetic data,
do the production data move:

1. **Pause writes** on CF production (maintenance banner).
2. **Dump D1** → `wrangler d1 export ocr-db --remote --output=dump.sql`.
3. **Convert SQL** for Postgres (types from §5).
4. **Restore** to the Docker Postgres: `psql -f dump.converted.sql`.
5. **Sync R2 → MinIO**:
   ```
   rclone sync r2:ocr-images minio:ocr-images
   ```
6. **DNS cutover** to Docker host (lower TTL the day before).
7. **Verify** acceptance walkthrough on Docker.
8. **Unfreeze writes**.

Plan a maintenance window of 30–60 min.

---

## 7. Risk areas (likely time sinks)

1. **PDF/image processing native deps** — `pdfjs-dist`, `tesseract.js` may
   need extra system packages in the Docker image (libstdc++, fonts). Use a
   `debian:slim` base instead of `alpine` to avoid musl issues.
2. **Stripe webhook signature** — must use the **raw request body** (not
   the JSON-parsed one) to compute the HMAC. Make sure the Next.js route
   reads raw body via `await request.text()` before parsing.
3. **Long-running OCR** — single large PDFs can take 30–60s. Queue handler
   must have generous timeouts.
4. **Compare cache key** — uses SHA-256 of `(file bytes + fields + model)`.
   Migrating from edge cache to Redis is fine, but include cache version in
   the key (see `PROMPT_VERSION` in compare route).
5. **Thai OCR quality** — Tesseract worker is configured for `tha+eng`.
   Make sure the language data files (`tha.traineddata`, `eng.traineddata`)
   are present in the Docker image (or download on first run).

---

## 8. Acceptance criteria

The owner will accept the Docker version when **all** of these are true:

1. Every user-visible flow in [`BEHAVIOR_REFERENCE.md`](BEHAVIOR_REFERENCE.md)
   passes on the Docker build.
2. The compare-result cache works (rerunning the same compare against the
   same files returns from cache + does not charge credits).
3. OCR for a 5-page Thai PDF completes within 15s (matching CF baseline).
4. Stripe checkout → webhook → credit grant works end-to-end on test mode.
5. Background OCR survives a single app container restart (job re-runs
   from queue, not lost).
6. Concurrent uploads from the same user cannot overdraw credits (atomic
   charge holds).
7. Admin can edit a user's password, the user can log in with the new
   password, and the password is stored as `pbkdf2$…` (not plaintext).
8. Notification bell shows in-app notifications after triggering events
   (low_confidence OCR, credit_low, new_user, login_fail_spike).
9. `docker-compose down && docker-compose up` brings the stack back without
   data loss (volumes persist).
10. Backups: `pg_dump` runs nightly via cron in a container and writes to
    the company backup location.

---

## 9. Public API hardening (in scope — fold into migration work)

`/api/v1/extract` is the only public-facing API endpoint today. It works
behind the admin-only gate but is **NOT** safe to open to external customers
in its current shape. The owner wants it customer-ready after the Docker
migration. Bundle these fixes into the same sprint — they touch the same
files the migration team will be refactoring anyway.

### 9.1 Current shape (auditable in `src/app/api/v1/extract/route.ts`)

- **Auth:** `email` + `password` sent in every form-data body. Password is
  verified against the PBKDF2 hash and silently rehashed on success.
- **Access gate:** admin role only + tier feature flag `public_api`.
- **Credit charge:** ⚠️ **updated since this doc was first written** — now
  charged atomically **before** the AI call via `chargeCreditsAtomic()`
  (`src/lib/credits.ts`, shared with `/api/upload`, landed in BILL-1), and
  **refunded atomically via `refundCreditsAtomic()` if the AI call fails**
  (quota/429, timeout, malformed response — landed in API-4b, 2026-07-12).
  So the race condition from the original audit is fixed and credits are no
  longer silently burned on AI failure — but note the mechanism is
  charge-then-refund-on-failure, not the originally-suggested
  pre-authorize-then-charge-on-success. There is still a narrow window where
  a crashed request (process killed between charge and refund) could leave
  credits deducted with no result — worth deciding during the migration
  whether the Postgres/queue version should move to true
  pre-authorize/capture instead.
- **Response:** synchronous JSON (AI runs inline, can hit Worker 30s limit).
- **Error format:** `fail()` from `src/lib/apiResponse.ts` with `detail`
  redacted via `src/lib/redactSecrets.ts` before logging (added in AI-1) —
  `detail` is not returned to the client on this route already, only
  logged server-side, and is now scrubbed of API keys/headers there too.
- **No rate limit, no idempotency key, no request-size guard, no audit log,
  no CORS, no SDK, no OpenAPI doc.** (Still true as of 2026-07-16 — API-5,
  the public self-service API, is queued but not started; see
  `docs/PENDING_FEATURES_BACKLOG.md`.)
- Prompt is hardcoded Thai-first (see line 96-102 of the route), though
  `mode=fulldoc` (added in API-4) now also accepts a full-document
  transcription request on this same route alongside field-extraction.

### 9.2 Critical fixes (MUST land before opening to external customers)

| # | Issue | Suggested fix |
|--|--|--|
| 1 | Email + password auth on every call | Add `api_keys` table (id, user_id, prefix, hash, scopes, created_at, last_used_at, revoked_at). Accept `Authorization: Bearer sk_xxx`. Hash the secret half (don't store plaintext). Add Settings UI for users to create / revoke. |
| 2 | Credit charged before AI call | ✅ **Mitigated 2026-07-12 (API-4b)** — atomic charge before the call, atomic refund if the call fails. Still not true pre-authorize/capture (see note in §9.1); consider finishing that during the migration if a queue-based async path makes it easy. |
| 3 | Non-atomic credit deduction (race) | ✅ **Done 2026-07-09 (BILL-1)** — both `/api/upload` and `/api/v1/extract` now call the same `chargeCreditsAtomic()` guarded UPDATE. See §5 "atomic credit charge". |
| 4 | No rate limit | Per-API-key sliding window. Recommend storing counters in Redis (post-migration) with TTL = window. Limits per tier: e.g. Pro = 60/min / 1000/day. Return `X-RateLimit-Remaining` / `X-RateLimit-Reset`. |
| 5 | No request-size guard | Reject `file.size > N` before reading. Tier-dependent cap (e.g. Pro 10MB, Enterprise 50MB). Return `413 Payload Too Large`. |

### 9.3 High-priority fixes (should land before public launch)

| # | Issue | Suggested fix |
|--|--|--|
| 6 | Synchronous timeout on large files | Add async sibling endpoint: `POST /api/v1/extract/async` returns `{ jobId }`, results retrieved via `GET /api/v1/jobs/{jobId}`. Background work via BullMQ on Redis (already in migration scope). Sync stays as default for ≤25s jobs. |
| 7 | Errors leak internals | Public-API error payload = `{ code, message }` only. Log full detail server-side keyed by `request_id`. |
| 8 | Access gating policy | Decide: admin-managed API keys (current behavior, safer) vs. tier-based self-serve (Pro+ can create keys). Owner leans toward tier-based but wants the Skill system shipped first. |
| 9 | No audit trail per request | Insert into a new `api_calls` table: `id`, `api_key_id`, `route`, `ip`, `user_agent`, `request_id`, `status`, `tokens_in/out`, `credits_charged`, `created_at`. |
| 10 | Missing rate / quota response headers | Add `X-Credits-Remaining`, `X-RateLimit-*`, `X-Request-Id` to every response. |
| 11 | CORS undefined | Decide policy: server-to-server only (no `Access-Control-Allow-*`) OR allow specific origins for browser-direct calls. Owner default = server-to-server only. |

### 9.4 Polish (nice-to-have, after critical + high)

| # | Issue | Suggested fix |
|--|--|--|
| 12 | No OpenAPI / Swagger | Ship `openapi.yaml` covering `/api/v1/extract` + future async sibling. Optional: host Swagger UI at `/api/v1/docs`. |
| 13 | No SDKs | At minimum, a `curl` snippet in the API page + a Node + Python example. Full SDK can wait. |
| 14 | No user-side usage dashboard | Add a "API Usage" section to the user's Settings view (mirrors `/admin/ai-usage`, scoped to their own keys). |
| 15 | Hardcoded Thai prompt | Accept an optional `prompt_language` parameter (`th` \| `en`) and swap the prompt template; default to user's locale from `users.locale` (new column, default `th`). |
| 16 | Versioning strategy | Document the contract: `/v1/*` is frozen; new fields are additive; breaking changes ship under `/v2/*`. Sunset `v1` with 6-month notice. |

### 9.5 Data model additions (apply in the Postgres migration)

```sql
-- API key authentication for /api/v1/* endpoints
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                -- "Production backend", "Test laptop", etc.
  prefix TEXT NOT NULL,              -- first 8 chars shown in UI (e.g. "sk_a1b2c3")
  secret_hash TEXT NOT NULL,         -- PBKDF2 of the full secret half
  scopes TEXT NOT NULL DEFAULT 'extract', -- comma-separated; future: 'compare', 'admin'
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id, revoked_at);
CREATE INDEX idx_api_keys_prefix ON api_keys(prefix) WHERE revoked_at IS NULL;

-- Per-request audit trail
CREATE TABLE api_calls (
  id TEXT PRIMARY KEY,                -- doubles as the X-Request-Id header
  api_key_id TEXT REFERENCES api_keys(id),
  user_id TEXT REFERENCES users(id),
  route TEXT NOT NULL,                -- e.g. '/api/v1/extract'
  method TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  status_code INTEGER,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  credits_charged INTEGER DEFAULT 0,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_api_calls_key_time ON api_calls(api_key_id, created_at DESC);
CREATE INDEX idx_api_calls_user_time ON api_calls(user_id, created_at DESC);
```

### 9.6 Acceptance for the API hardening track

These rows go into the [`BEHAVIOR_REFERENCE.md`](BEHAVIOR_REFERENCE.md) sign-off
matrix once the API hardening work is done:

- `POST /api/v1/extract` with `Authorization: Bearer sk_…` works; with the
  old `email`+`password` form returns `401 UNAUTHORIZED`.
- Revoked API key returns `401 UNAUTHORIZED` immediately on next call.
- 10 parallel calls from the same key cannot overdraw credits.
- AI failure path leaves credits untouched (verify by simulating a bad
  Gemini key).
- Request-size limit returns `413` without spending a credit.
- Rate limit returns `429` with `X-RateLimit-Reset` header.
- Error responses do not contain stack traces or file paths.
- `X-Request-Id` is present on every response and matches an `api_calls`
  row in Postgres.

### 9.7 Sequence inside the migration sprint

Suggested order — fold into the relevant migration days from §0 / Week plan:

1. Build the `api_keys` table + middleware first (Day 3-4 of Week 1, alongside
   the abstraction layer work). Behind a feature flag — old email+password
   still works during transition.
2. Atomic credit + refund (Day 4 of Week 1, while refactoring DB calls).
3. Rate limit middleware (Day 6, alongside Redis setup for queue + cache).
4. Size guard + safe error format (Day 7, before spike review).
5. Async endpoint + audit log (Week 2, once BullMQ is online).
6. OpenAPI docs + SDK snippets (Week 2 polish).

This keeps the API hardening **diff-adjacent** to the migration work so the
team isn't context-switching between two unrelated patches.

---

## 10. Out of scope for this migration

- Skill system (see [`PENDING_FEATURES_BACKLOG.md`](PENDING_FEATURES_BACKLOG.md))
- LINE OA integration (see [`PENDING_LINE_AND_INTEGRATIONS_PLAN.md`](PENDING_LINE_AND_INTEGRATIONS_PLAN.md))
- Google Sign-In / Drive Picker
- Email verification / forgot password
- Multi-language OCR beyond `tha+eng`

These can be added after the Docker stack is stable in production.

---

## 11. Where to start

1. Read [`README.md`](../README.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).
2. Walk the live app (production URL above) and follow the user journeys
   in [`BEHAVIOR_REFERENCE.md`](BEHAVIOR_REFERENCE.md).
3. Skim [`wrangler.jsonc`](../wrangler.jsonc) to see exactly which CF
   bindings need adapters.
4. Open a branch off `main`: `git checkout -b feat/docker-migration`.
5. Suggested first PR: introduce the abstraction interfaces (`lib/db`,
   `lib/storage`, `lib/ai`, `lib/cache`, `lib/queue`) with both CF and
   Docker implementations side-by-side, behind an env flag.
6. Land subsequent PRs feature-by-feature so the owner can review small
   diffs at a time.

Questions go to the owner directly. Security-sensitive issues (leaked
secret, auth bug) — contact privately, **not** through a public issue.
