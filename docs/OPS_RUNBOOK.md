# Ops Runbook — Cloudflare Production

> **Purpose:** one place for "how do I operate this thing" — debugging
> production, rotating secrets, backing up/restoring data. Written for
> anyone other than the original owner who has to touch prod: a new
> collaborator, a contractor, or future-you after a long gap.
> **Written:** 2026-07-16, based on `pm/reports/OPS-1.md` (devops-cloudflare
> agent, 2026-07-09) + the live `wrangler.jsonc` + `.dev.vars.example`.
> **Production URL:** https://ocr-web-service.jiatuntiwong.workers.dev
> **Stack:** Next.js 16 on Cloudflare Workers via OpenNext, D1 (SQLite),
> R2 (object storage), Workers AI binding present but unused by the OCR
> path (AI calls go direct to provider APIs — see `docs/MIGRATION.md` §4.3).

---

## 1. Who can deploy

**Only the project owner deploys** (see `README.md` → Deploy). Collaborators
submit PRs; the owner reviews, merges, then runs `npm run deploy` manually.
There is intentionally no CI/CD auto-deploy — this is a deliberate choice,
not a gap (see `docs/PENDING_FEATURES_BACKLOG.md` "CI/CD pipeline" under
nice-to-haves, still unstarted as of this writing).

## 2. Environments

| Env | Command | Runtime | Use for |
|--|--|--|--|
| `npm run dev` | Next.js dev server, Turbopack | Fast iteration; **does not** catch Workers-runtime-only bugs (see §4) |
| `npm run dev:cf` | `wrangler dev` against a real OpenNext build | Slower, but D1/R2/AI bindings behave like production |
| `npm run preview` | `opennextjs-cloudflare build` + `wrangler preview` (workerd) | Closest to prod without touching prod — **use this before every deploy that touches OCR/AI/credits** |
| `npm run deploy` | OpenNext build + `wrangler deploy` | Production. Owner only. |

## 3. Config reference (`wrangler.jsonc`)

```jsonc
{
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_compat", "nodejs_compat_populate_process_env"],
  "d1_databases": [{ "binding": "DB", "database_name": "ocr-db" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "ocr-images" }],
  "assets": { "binding": "ASSETS", "directory": ".open-next/assets" },
  "ai": { "binding": "AI" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "ocr-web-service" }],
  "observability": { "enabled": true }
}
```

- `nodejs_compat` covers `Buffer`, `crypto`, `Stream`, FormData parsing —
  what the OCR/upload path needs today.
- `nodejs_compat_populate_process_env` exists specifically for the Stripe
  routes' dual-source pattern (`env.STRIPE_* || process.env.STRIPE_*`) —
  don't remove it without checking billing routes first.
- The `AI` binding (Cloudflare Workers AI) is present but **not** what
  powers OCR — OCR calls Gemini/OpenAI/OpenRouter/Vertex directly over
  `fetch`/SDK from `src/lib/ai-handler.ts`. Don't assume the binding is
  load-bearing; check before removing it if trimming bindings.

**Bundle size:** as of the last measured pass (2026-07-09), the compressed
Worker bundle was 6.23 MB against a 10 MB cap (62%). No hard action needed,
but it's worth re-checking (`ls -la .open-next/server-functions/default/`
after a build) before shipping anything that pulls in a new heavy
dependency — Sprint 2 items (per-page parallel pipeline, rulebase) were
flagged as likely to push it further.

## 4. Secrets

Local dev secrets go in `.dev.vars` (gitignored), copied from
`.dev.vars.example`. Production secrets are Cloudflare Worker secrets, set
via:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PRICE_STARTER
npx wrangler secret put STRIPE_PRICE_PRO
npx wrangler secret put STRIPE_PRICE_ENTERPRISE
```

**`SESSION_SECRET` rotation is destructive** — it HMAC-signs the session
cookie. Rotating it invalidates every logged-in session immediately (every
user has to log in again). There's no graceful dual-key rotation today; if
that matters, treat it as a maintenance-window action and consider a
dual-secret verify window as a future improvement rather than doing a live
rotation without warning users.

**AI provider keys are also manageable at runtime**, without touching
`wrangler secret` at all: Admin → API Settings lets an admin add/rotate
Gemini / OpenAI / OpenRouter / Vertex AI keys, stored in D1
(`system_settings.AI_POWER_CONFIG`), always returned masked to the browser,
never logged in the clear (`src/lib/redactSecrets.ts`). Prefer this path
for AI key rotation — no redeploy, no downtime. The `wrangler secret`
`GEMINI_API_KEY` is only the env-var fallback.

**Never commit:** `.dev.vars`, any real API key, anything matching
`AIza[0-9A-Za-z_-]{35}` (Google key shape) or `sk-`/`sk-or-` prefixes
(OpenAI/OpenRouter). If you ever need to paste a key into a report or
issue for debugging, use a placeholder like `AIzaXXXX...XXXX` — this is
the convention already used in `pm/reports/AI-1.md`.

## 5. Debugging production (`wrangler tail`)

```bash
# All OCR-path errors
wrangler tail --format=pretty --status=error

# Users hitting the 20 MB upload cap
wrangler tail --format=pretty --search "UPLOAD_TOO_LARGE"

# Background OCR extraction failures
wrangler tail --format=pretty --search "OCR_EXTRACTION_ERROR"

# AI provider errors (Gemini/OpenAI/OpenRouter/Vertex)
wrangler tail --format=pretty --search "AI_FAILED"

# Credit charge oddities
wrangler tail --format=pretty --search "CREDIT_CHARGE_SKIPPED"

# Hint/crop coordinate-space debugging
wrangler tail --format=pretty --search "OCR-6c"
```

## 6. Pre-deploy smoke check (do this before every deploy touching OCR/credits/AI)

```bash
npm run preview
# Ready on http://localhost:8788 — first build is slow (30-60s cold cache)

# Coded-error guards (no credits burned by these):
COOKIE="session=..."   # grab from a logged-in browser session

# TOO_MANY_PAGES
curl -s -X POST http://localhost:8788/api/upload \
  -H "Cookie: $COOKIE" -F "file=@dummy.pdf" -F "total_pages=10" \
  -F 'pages=[1,2,3,4,5,6]' | jq .
# Expect: { ok: false, code: "TOO_MANY_PAGES", vars: { limit: 5, actual: 6 } }

# FILE_TOO_LARGE
dd if=/dev/urandom of=big.bin bs=1M count=21
curl -s -X POST http://localhost:8788/api/upload \
  -H "Cookie: $COOKIE" -F "file=@big.bin;type=application/pdf" | jq .
# Expect: { ok: false, code: "FILE_TOO_LARGE", vars: { limit: 20, actual: 21 } }

# Then do one real interactive pass in the browser: log in, upload a real
# PDF with a template that has a saved bbox_hint, watch the Network tab for
# the crop-pass multipart fields, poll /api/status until completed.
```

## 7. Windows dev-machine gotcha

`npm run deploy` / `npm run preview`'s `rm .open-next` step can fail with
`EPERM` / `Device or resource busy` if a prior `workerd.exe` or
`esbuild.exe` process is still holding the folder open from an earlier run
that didn't exit cleanly.

**Fix:**
```powershell
Get-Process workerd, esbuild
taskkill /F /PID <pid> ...
```
Then retry the build/deploy. This is a Windows filesystem-lock quirk, not
a workerd runtime bug — don't waste time debugging the app.

## 8. Backup / restore (D1 + R2)

D1 export:
```bash
npx wrangler d1 export ocr-db --remote --output=dump.sql
```

There is no automated nightly backup job configured today (unlike the
Docker-migration target in `docs/MIGRATION.md` §8, which explicitly
requires a cron `pg_dump`). If backups matter before then, run the export
above manually on a schedule, or set up a scheduled Cloudflare Worker /
external cron to do it. **This is a gap, not documentation of an existing
job** — flagging it here so it doesn't get assumed to exist.

R2 has no built-in export command; use `rclone` against the R2 S3-API
endpoint if a full copy is ever needed (same tool `docs/MIGRATION.md` §6
uses for the R2 → MinIO one-shot move).

## 9. Known operational limits (measured 2026-07-09, re-check periodically)

| Limit | Cap | Typical OCR usage | Headroom |
|--|--|--|--|
| Request body | 100 MB | 20 MB (app-enforced cap) | Comfortable |
| CPU time | 30s (paid default) | <1s CPU (wall time is Gemini network wait) | Comfortable |
| Memory | 128 MB/request | ~10-15 MB peak (5-page PNG + crops) | Comfortable |
| Sub-requests | 50/invocation | ~13-15 on the upload happy path | Comfortable, watch if per-page parallel pipeline (Sprint 2 S2-4) ships |
| Bundle size | 10 MB compressed | 6.23 MB (62%) | Watch — re-measure before shipping large new deps |

## 10. Related docs

- `docs/MIGRATION.md` — full architecture + refactor map if this ever
  moves off Cloudflare.
- `docs/BEHAVIOR_REFERENCE.md` — what "correct" looks like, flow by flow.
- `docs/SECURITY_HANDOFF.md` — what's been security-reviewed vs. still open.
- `pm/reports/OPS-1.md` — original source report this runbook was built from.
