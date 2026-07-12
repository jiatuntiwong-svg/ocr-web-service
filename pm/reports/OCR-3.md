# OCR-3 — Retry mechanism with temperature 0.6

**Status:** review (handler + both API surfaces done, UI half handed to UI-4b)
**Date:** 2026-07-09
**Owner:** ocr-pipeline

---

## 1. API shape decision — `retry: true`

Chose `retry: true` (boolean FormData string `"true"` / absent) over `attempt: N` (integer counter).

Rationale:
- **Minimal surface.** UI-2 has not shipped — it was merged into UI-4b (BOARD row 27). Nothing on the wire needs multi-retry semantics today.
- **No numeric semantics to police.** `attempt: N` invites questions ("does N=2 mean second retry or third try?", "cap at what?"). `retry: true` says exactly one thing: bump temperature to 0.6 this call.
- **Reversible.** If we later want cumulative counter, we can add `attempt` alongside — `retry: true` maps to `attempt: 2` by convention.
- **Backward-compatible by default.** Missing flag = today's byte-identical behavior (temp 0.0).

Accepted on both routes:
- `POST /api/upload` — FormData part `retry` = `"true"`.
- `POST /api/v1/extract` — same.

Docs field for `documents.attempt_count` (mentioned in DB-1) is a **follow-up** — see §7.

---

## 2. Files changed

| File | Lines (approx) | Purpose |
|---|---|---|
| `src/lib/ai-handler.ts` | 30-56, 58-89, 88-99, 125-146, 181, 201, 216, 238 | Add `temperature` param to `AIProviderRequest` + `AIResult.isRetry`; thread through all 4 provider helpers |
| `src/lib/ai-usage.ts` | 7-16, 18-40, 46-63 | Add `isRetry?: boolean` field; `is_retry INTEGER` column + idempotent `ALTER TABLE` migration; persist in INSERT |
| `src/app/api/upload/route.ts` | 57-68 (new), 297-306, 366-375, 495-503 | Parse `retry` FormData; thread `aiTemperature` into whole-image AND crop-pass AI calls; tag `logAiUsage` |
| `src/app/api/v1/extract/route.ts` | 20-29 (new), 175-184, 213-221 | Parse `retry` FormData; thread temperature; tag `logAiUsage`. Error contract untouched (API-2 preserved) |

---

## 3. Provider matrix

| Provider | Before | After (retry path) | Notes |
|---|---|---|---|
| `gemini` (@google/generative-ai SDK) | `generationConfig: { temperature: 0, topP: 1 }` hardcoded | `generationConfig: { temperature, topP: 1 }` — 0.6 when retry | SDK supports 0–2 range; confirmed via SDK types |
| `vertex_ai` (Express Mode REST) | `generationConfig: { temperature: 0, topP: 1 }` in body | Same field, param-driven | Vertex `GenerationConfig.temperature` documented in REST reference; identical shape to AI Studio |
| `openai` (chat/completions REST) | `temperature: 0` in body | Param-driven | OpenAI chat/completions accepts `temperature` 0-2 across all vision-capable models |
| `openrouter` (chat/completions REST) | `temperature: 0` in body | Param-driven | OpenRouter proxies OpenAI-shape; providers behind it may clamp — behaves as best-effort |

Grep confirms zero remaining hardcoded `temperature: 0` in provider paths (only a comment reference at ai-handler.ts:114).

Red flags:
- **Vertex + OpenRouter empirically untested this pass** (constraint: "Do NOT run empirical Gemini/Vertex calls"). Vertex GenerationConfig.temperature is in Google's public REST reference for `publishers/google/models:generateContent` so wire-level compatibility is high-confidence. OpenRouter is a proxy — a downstream provider that ignores `temperature` degrades to "same-as-fresh-run" (worst case: retry is a no-op for that specific model), never breaks.

---

## 4. `logAiUsage` change

**Signature diff:**
```ts
// AIUsageRecord — additive optional field
+  isRetry?: boolean;
```

**Persistence:**
- New column `ai_usage.is_retry INTEGER DEFAULT 0`.
- `ensureTable` includes it in `CREATE TABLE IF NOT EXISTS`, so fresh DBs get it directly.
- Idempotent `ALTER TABLE ai_usage ADD COLUMN is_retry INTEGER DEFAULT 0` follows, wrapped in try/catch to swallow the "duplicate column" error on subsequent runs. Existing D1 instances gain the column on next OCR/compare/api_extract call.
- INSERT statement now writes `rec.isRetry ? 1 : 0` (nullish → 0, so any caller that hasn't been updated silently records normal runs — no schema break).

Admin dashboard follow-up: `is_retry` is now query-able but no UI reads it yet — that's a P3 admin dashboards task, not blocking.

---

## 5. Backward-compat proof

With `retry` absent from FormData:
1. `data.get("retry") === "true"` → `false` → `isRetry = false` → `aiTemperature = 0`.
2. `generateWithAI` receives `temperature: 0`; each provider passes `0` into the same `generationConfig`/body field that previously held the literal `0`.
3. `isRetry` in `AIResult` stays undefined (assigned only when `temp > 0`).
4. `logAiUsage` receives `isRetry: false` → `0` written to `is_retry` column (matches the DEFAULT).

Response shape (both routes): unchanged. `ok(...)` / `fail(...)` envelopes untouched.
Credit + charge logic: unchanged. Retry pays `estimate.credits` (upload) or `1` (v1/extract) just like a fresh run through `chargeCreditsAtomic`.

---

## 6. `/v1/extract` symmetry & API-2 contract

- Same `retry=true` FormData part accepted.
- Same temperature threading — one AI call (v1/extract has no crop pass).
- Error contract preserved: all failures still go through `fail(ErrorCode.*, ...)` from `apiResponse.ts`. `retry` NEVER changes which error code fires; it only changes AI temperature. The AI-failure branch (`ErrorCode.AI_FAILED`, `V1_EXTRACT_PARSE_FAIL`) fires identically regardless of retry mode.
- `logAiUsage` tagged with `isRetry: true` on retry rows so cost analysis sees the extra runs.

---

## 7. UI-2 → UI-4b handoff notes

BOARD row 27 confirms UI-2 was folded into UI-4b (retry lives in the overflow menu + kbd `R` of the workspace v3 mockup). For UI-4b to wire the button:

**FormData to send on retry click:**
- All the same parts as the original upload (same file, same `fields`, same `fields_json`, same `field_crops` + `crop_*` blobs, same `pages`/`total_pages`, same `selectedModelId`) — this is intentionally a full re-upload, not a "re-run against server-cached bytes", because the Worker doesn't retain the file between calls.
- **Add one part:** `retry` = `"true"` (string).

**How to display attempt 1 / retry per spec:**
- The server does not currently return `isRetry` in the JSON body of `/api/upload` (the route returns immediately with `documentId` while OCR runs in `waitUntil`). UI-4b should track attempt state **client-side** — e.g. `attemptCount` per document row. Bump on retry click. Label "Retry (attempt 2)" locally.
- For the sync `/api/v1/extract` case (public API), a subsequent iteration could echo `is_retry: true` into `extracted_data` metadata if a UI ever consumes it — not needed for UI-4b MVP.

**Credit UX warning:** UI-4b should surface "retry consumes credits like a fresh run" in the confirm dialog (spec §3). The server does NOT ask twice — it charges as soon as OCR succeeds.

---

## 8. Follow-ups flagged

- **DB-1 `documents.attempt_count` / retry_of child table.** DB-1 spec (per this task's brief) mentions optional retry tracking on the documents side. Not in scope for OCR-3; when DB-1 lands, the writer here (`upload/route.ts` INSERT into `documents`) is the natural place to bump `attempt_count` or insert a `document_retries` child row on `isRetry === true`. One-line change.
- **Admin dashboard is_retry filter.** `ai_usage.is_retry` is populated but not surfaced. Owner: whoever handles the admin cost dashboard iteration.
- **Batch retry.** Spec explicitly out of v1 scope. `runBatchItem` (client) posts to `/api/upload`, so if UI-4b later adds a "retry all failed" batch button, the server side already supports it — client just needs to send `retry: "true"` per item.
- **OpenRouter model-specific temperature clamping.** Some models behind OpenRouter ignore `temperature`; retry becomes a no-op for those. Non-issue for the default provider (Gemini/Vertex) but worth documenting if a customer sees "retry didn't change the answer" on an OpenRouter model.

---

## 9. Verification

- `npx tsc --noEmit` → exit 0.
- `npm run build` → clean, all API routes compiled including `/api/upload` and `/api/v1/extract`.
- `grep -n "temperature:\s*0" src/` → only a comment reference remains; every provider builder now uses the param.
- No empirical AI calls run (per constraint).
- No prompt/crop-pipeline/page-selection internals touched.
