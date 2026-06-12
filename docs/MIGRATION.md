# Cloudflare Workers → Self-hosted Docker Migration

> **Status:** Handoff doc · 2026-06-14
> **Audience:** Receiving engineering team
> **Goal:** Reproduce the current Cloudflare Workers production app on Docker
> (PostgreSQL + S3-compatible storage + direct Gemini API + Redis), keeping
> all user-visible behavior identical.
>
> **Production reference:** https://ocr-web-service.jiatuntiwong.workers.dev
> **Owner contact:** project owner (GitHub: jiatuntiwong-svg)
> **Target deadline:** ~2 weeks from handoff

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
- [`src/app/api/upload/route.ts`](../src/app/api/upload/route.ts) — atomic credit charge UPDATE
- [`src/app/api/compare/route.ts`](../src/app/api/compare/route.ts) — credit check + post-run adjust
- [`src/app/api/admin/users/route.ts`](../src/app/api/admin/users/route.ts) — admin user list + edit

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
already calls the Google Generative AI SDK directly when keys are provided
via env vars — so this is the *cleanest* swap. Replace any `env.AI.run(...)`
paths (search for `env.AI`) with the existing direct-SDK path keyed by
`GEMINI_API_KEY`.

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

**Important — atomic credit charge:** the upload route relies on this query
to be atomic so two parallel uploads can't overdraw a user's balance:
```sql
UPDATE users SET
  credits_remaining = MAX(0, credits_remaining - ?),
  extra_credits     = extra_credits - MAX(0, ? - credits_remaining)
WHERE id = ? AND (credits_remaining + extra_credits) >= ?
RETURNING credits_remaining + extra_credits AS remaining
```
Postgres supports the same `MAX(...)` and `RETURNING` syntax — no rewrite
needed, just make sure the driver passes `RETURNING` results back.

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

## 9. Out of scope for this migration

- Skill system (see [`PENDING_FEATURES_BACKLOG.md`](PENDING_FEATURES_BACKLOG.md))
- LINE OA integration (see [`PENDING_LINE_AND_INTEGRATIONS_PLAN.md`](PENDING_LINE_AND_INTEGRATIONS_PLAN.md))
- Google Sign-In / Drive Picker
- Email verification / forgot password
- Multi-language OCR beyond `tha+eng`

These can be added after the Docker stack is stable in production.

---

## 10. Where to start

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
