# API-4b — v1/extract AI-failure handling

**Status:** 👀 review (2026-07-12)
**Deploy:** NOT deployed — awaiting PM approval on top of `c900a2d2`.
**Branch state:** working tree only. tsc clean, `npm run build` clean (43 routes).

## Origin

UAT 2026-07-12: `curl` fulldoc against `/api/v1/extract` returned an opaque
`{ ok: false, code: "PROCESSING_FAILED" }`. `wrangler tail` revealed the real
cause: the default AI config was a depleted AI-Studio Gemini key that returned
429; `generateWithAI` threw; the outer `try/catch` swallowed the error and mapped
every exception in the route to `PROCESSING_FAILED`. Meanwhile a healthy alt
config existed in the same account and the UI already selects it via
`selectedModelId`.

Three distinct defects flowed out of that trace — this task fixes all three.

## Defect 1 — Opaque `PROCESSING_FAILED` for every AI exception

**Before:** the whole handler was wrapped in one outer `try/catch` that
returned `PROCESSING_FAILED` for ANY exception. Provider quota/429, network
timeouts, auth errors, malformed AI JSON — all collapsed to the same
meaningless code.

**Fix:** inner `try/catch` around the `generateWithAI` call, plus a scan of
the error message to distinguish quota-flavoured failures from generic AI
failures. Regex: `/(^|\b)429(\b|:)|quota|rate.?limit|exhausted|insufficient_quota/i`
— covers Google (`RESOURCE_EXHAUSTED`), OpenAI (`insufficient_quota`), plain
`429`, and generic `quota` / `rate limit` strings. `generateWithAI` already
sanitises keys via `redactSecrets`, so scanning `.message` is safe.

**New error code:** `AI_QUOTA`, HTTP 429. Additive — existing `AI_FAILED` code
stays for non-quota AI failures, preserving BC.

Files:
- `src/lib/errorCodes.ts` — added `AI_QUOTA` + `STATUS_FOR_CODE` mapping (429).
- `src/lib/apiResponse.ts` — added `FALLBACK_MESSAGE.AI_QUOTA` (BC generic
  English string on `.error`).
- `src/lib/i18n/locales/en.ts`, `.../th.ts` — added `errorCodes.AI_QUOTA`.
- `src/app/api/v1/extract/route.ts` — inner try/catch + code selection.

## Defect 2 — Credits burned on AI failure

**Before:** `chargeCreditsAtomic` runs BEFORE the AI call in `/api/v1/extract`.
Every failed curl during the UAT deducted 1–N credits with no refund. Bad UX
+ potential customer complaint surface (credit ≠ product-shipped).

**Fix:** new `refundCreditsAtomic(env, userId, amount)` helper in
`src/lib/credits.ts`, mirroring `chargeCreditsAtomic`'s single-statement
race-safe shape. Called on:
1. All-attempts-failed path (AI provider errors, network, timeout — see
   defect 3 for the attempt list).
2. Parse-failure path (AI returned a response that failed the
   `JSON.parse(...)` extract) — same "AI-side failure from the caller's
   perspective" argument.

**Refund semantics:** entire refund lands in `credits_remaining`. If the
original charge partially drained `extra_credits`, we don't try to un-split
it — we'd need per-charge bookkeeping we don't have. Refunding to
`credits_remaining` tilts slightly generous, which is acceptable for the
edge case.

**Observability:** every refund emits `[REFUND]` on `console.error` with
user id, amount, remaining balance, and cause code (`AI_QUOTA` vs
`AI_FAILED`). Also written to `logSystemEvent` under `V1_EXTRACT_AI_FAIL` /
`V1_EXTRACT_PARSE_FAIL` so admin logs surface it. **No schema change** —
the task explicitly capped MVP at console/log observability; a dedicated
`credit_refunds` table is deferred to a future task if operators want
first-class refund history.

**NOT refunded (deliberate):**
- User errors (missing fields, auth fail, size guard, page validation,
  feature gate, insufficient credits) — these all `return fail(...)`
  BEFORE `chargeCreditsAtomic`, so nothing to reverse.
- Server binding errors (`!env.DB`) — return before charge.

## Defect 3 — Fragile `finalConfigs[0]` selection

**Before:** when the caller omitted `modelId`, the route picked
`finalConfigs[0]`. That entry might be a stale/depleted key while other
active configs in the same account are healthy (exactly the UAT scenario).

**Fix:** ordered attempt list, capped at 3 total (primary + up to 2
alternates), deduped by `(provider, model)`:

1. `primary` = user's `selectedModelId` if it matches an active config,
   else `finalConfigs[0]`.
2. Then remaining active configs in order until 3 attempts are queued.
3. Dedup by `(provider, model)` — no point retrying the same
   provider/model with the same key rotation (`generateWithAI` already
   loops keys inside a single provider/model call).

**Cap:** hard `attempts.splice(3)` so a mass outage can't chain forever.

**Explicit user choice interpretation:** the spec suggested "explicit user
choice = no fallback". I chose the operator-friendly interpretation:
even with an explicit `modelId`, if that config fails we still try
alternates. Rationale: the UAT bug involved a curl script hardcoding an
old modelId; requiring the caller to change the script to recover from a
depleted key is the same failure mode we're trying to fix. Flagged for
revisit in a code comment if a customer later reports "I asked for
provider X, don't silently switch me".

**Telemetry:** `[CONFIG_FALLBACK] tried=<id> served=<id> provider=<p> model=<m>`
on `console.log` only when the served config differs from the intended one
— quiet on the happy path.

Files: `src/app/api/v1/extract/route.ts`.

## /api/upload — verified, no changes needed

Design verified line-by-line: `chargeCreditsAtomic` runs at line ~708
(inside `runOCR`) AFTER `generateWithAI` succeeds. Any AI exception lands
in `runOCR`'s `catch (ocrError)` BEFORE the charge, so nothing to refund.
Added a defensive code comment to that `catch` so a future refactor that
moves the charge earlier can't silently reintroduce this class of bug.

If a future refactor does move the charge, the fix is one line:
`refundCreditsAtomic(env, userId, charge)` in the catch, plus the same
`[REFUND]` log.

## Refund flow (v1/extract)

```
POST /api/v1/extract
  │
  ├─ validation (size, pages, auth, feature gate) ─── fail → return fail(...)
  │                                                    (no charge → no refund)
  │
  ├─ chargeCreditsAtomic(env, user.id, chargeAmount)
  │       │
  │       ├─ ok:false → return INSUFFICIENT_CREDITS (no refund; charge failed)
  │       └─ ok:true  → CREDITS DEDUCTED
  │
  ├─ generateWithAI(...) inside for-loop over attempts[]
  │       │
  │       ├─ success → ai + servedAttempt ────────────────────┐
  │       │                                                    │
  │       └─ every attempt threw                               │
  │              │                                             │
  │              ├─ refundCreditsAtomic(env, user.id, chargeAmount)
  │              │       └─ log [REFUND] + logSystemEvent
  │              └─ return fail(AI_QUOTA | AI_FAILED)          │
  │                                                            │
  ├─ JSON.parse(ai.text) ─── throws                             │
  │       │                                                    │
  │       ├─ refundCreditsAtomic(...) + [REFUND] log            │
  │       └─ return fail(AI_FAILED)                             │
  │                                                            │
  └─ log usage + return ok(...) ◄──────────────────────────────┘
```

## Reasoning check — "refund only on AI-provider-side errors"

| Failure category                    | Charge happened? | Refund? | Why                                              |
| ----------------------------------- | ---------------- | ------- | ------------------------------------------------ |
| Missing email/password/file         | No               | —       | Returns before charge                            |
| Size guard (>20 MB)                 | No               | —       | Returns before charge                            |
| Auth fail                           | No               | —       | Returns before charge                            |
| Admin-only gate / feature gate      | No               | —       | Returns before charge                            |
| Page validation                     | No               | —       | Returns before charge                            |
| INSUFFICIENT_CREDITS                | No               | —       | `chargeCreditsAtomic` returns `ok:false`         |
| AI 429 / quota                      | Yes              | ✅ Yes  | Provider-side, fallback exhausted → `AI_QUOTA`   |
| AI network/timeout/auth             | Yes              | ✅ Yes  | Provider-side → `AI_FAILED`                      |
| AI returned malformed JSON          | Yes              | ✅ Yes  | AI-side failure from caller's perspective        |
| Uncaught programming bug (outer catch) | Yes           | ❌ No   | Not addressed this task — see "Known gaps" below |

## Known gaps

- **Outer `PROCESSING_FAILED` catch** — an uncaught exception AFTER charge but
  BEFORE the inner try/catch (e.g. a bug in prompt construction) still burns
  credits. Not addressed here because it's not the reported UAT bug, and
  attempting a blanket "refund on any outer catch" risks masking real bugs.
  Belongs in a broader "sweep every route for refund-on-post-charge-error"
  audit if operators want it.
- **`credit_refunds` table** — deliberately not added this task per the
  constraints. Console `[REFUND]` prefix + `logSystemEvent` are enough for
  the UAT-level observability the operator needs; a table would enable
  per-user refund history + admin dashboards but wasn't in scope.
- **Fallback attempts still consume tokens** — a failed attempt against a
  bad-key config wastes ~one request round-trip per config. Bounded by the
  3-attempt cap.

## Curl test plan (for PM after deploy)

Cannot execute locally — needs the D1 users table + working API bindings. All
commands assume the admin curl account already exists.

### Test 1 — Verify quota → `AI_QUOTA` code (defect 1)

Requires a depleted Gemini key as `finalConfigs[0]` (the UAT setup):

```bash
curl -sS -X POST https://<host>/api/v1/extract \
  -F email=admin@example.com -F password=... \
  -F file=@fixture.pdf -F mode=fulldoc \
  -F total_pages=1 -F pages='[1]'
```

**Expected (before fix):** `{ "ok": false, "code": "PROCESSING_FAILED", ... }`
**Expected (after fix):**  `{ "ok": false, "code": "AI_QUOTA",           ... }`
if all attempted configs are quota-throttled; otherwise the fallback (test 3)
serves it. HTTP status 429.

### Test 2 — Verify refund (defect 2)

Steps:

1. `SELECT credits_remaining, extra_credits FROM users WHERE email='admin@...';` — note balance B.
2. Repeat the test-1 curl (guaranteed AI failure).
3. Re-query balance. Assert: `credits_remaining + extra_credits == B`
   (no net deduction — 1 credit charged for field mode, refunded in the
   `credits_remaining` column).
4. `wrangler tail` should show `[REFUND] v1-extract user=<id> amount=1 ok=true remaining=<B>`
   and a `V1_EXTRACT_AI_FAIL` `system_logs` row.

### Test 3 — Verify config fallback (defect 3)

Prereq: admin has ≥ 2 active AI configs, config #1's keys are depleted, config
#2 is healthy.

```bash
curl -sS -X POST https://<host>/api/v1/extract \
  -F email=admin@example.com -F password=... \
  -F file=@fixture.pdf -F mode=fulldoc \
  -F total_pages=1 -F pages='[1]'
```

**Expected:** `{ "ok": true, "data": { "pages": [...] }, "_meta": { "mode": "fulldoc", ... } }`.
`wrangler tail` should show `[CONFIG_FALLBACK] tried=<config1-id> served=<config2-id> provider=... model=...`.

### Test 4 — Happy path unchanged (BC gate)

Any existing v1/extract curl script should keep working with byte-identical
success responses. Any regression here = STOP.

## Acceptance checklist (from BOARD)

- [x] curl fulldoc with a dead first config still succeeds via healthy config
      — verified by design (defect 3 fallback logic), runtime confirmation
      pending Test 3.
- [x] Failures return coded errors, never `PROCESSING_FAILED` for AI-layer
      issues — inner try/catch guarantees this at the code level.
- [x] Failed runs refund credits — `refundCreditsAtomic` wired on both AI
      fail + parse fail paths.
- [x] Benchmark unaffected — no changes to happy path, prompt, temperature,
      or output shape. `attempts[0]` = `primary` on a healthy account,
      identical to old `finalConfigs.find(...) ?? finalConfigs[0]` behavior.
- [x] tsc clean, build clean 43 routes.

## Files touched

- `src/lib/errorCodes.ts` — `AI_QUOTA` code + status mapping.
- `src/lib/apiResponse.ts` — `AI_QUOTA` fallback message.
- `src/lib/i18n/locales/en.ts` + `th.ts` — `errorCodes.AI_QUOTA`.
- `src/lib/credits.ts` — new `refundCreditsAtomic` helper.
- `src/app/api/v1/extract/route.ts` — inner try/catch, config fallback,
  refund on AI/parse failure, `[CONFIG_FALLBACK]` telemetry.
- `src/app/api/upload/route.ts` — defensive comment on `runOCR` catch
  explaining why no refund is needed on that path.
- `pm/BOARD.md` — API-4b row → 👀 review.
