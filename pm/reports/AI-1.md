# AI-1 — Vertex AI provider + security hardening

**Status:** review (build green, awaiting operator preview verification + `/security-review`)
**Branch:** main (uncommitted)
**Placeholders used in this doc:** `AIzaXXXX...XXXX` — no real key literals.

## Recon summary

- **Provider dispatch:** `src/lib/ai-handler.ts:50-73` — single `generateWithAI(req)` switching on `provider` string over `apiKeys[]` with per-key try/continue. Three provider paths today: `gemini` (via `@google/generative-ai` SDK), `openai` (fetch), `openrouter` (fetch). Multi-image supported through `req.images` (falls back to `[req.image]`).
- **Config storage:** D1 row `system_settings.key = 'AI_POWER_CONFIG'`, JSON-serialised array of `AIConfig` (id, provider, model, apiKey, label, isEnv, isActive). Env fallback: `env.GEMINI_API_KEY` + `env.GEMINI_API_KEYS` (`src/lib/ai-handler.ts:3-27`, `src/app/api/admin/settings/route.ts:22-50`).
- **Settings GET masking (SEC-2 baseline):** already implemented at `src/app/api/admin/settings/route.ts:53-56` — masks all `apiKey` to `AIzaXX....XXXX` before returning. Existing behaviour was already correct for the Gemini path; extending it to `vertex_ai` was zero-cost (mask logic is provider-agnostic).
- **Settings POST write-only pattern:** already implemented — `isMasked = config.apiKey.includes("....") || "****"` gates keep-existing (route.ts:83-104). Vertex reuses the same code path unchanged.
- **Metering:** `logAiUsage(env, {provider, model, inputTokens, outputTokens, ...})` — `src/lib/ai-usage.ts:39`. Called from `upload`, `v1/extract`, `compare`, and template curation routes. Vertex slots in with `provider: "vertex_ai"` string; no schema change.
- **Callers of `generateWithAI`:** `src/app/api/upload/route.ts:290, 359`, `src/app/api/v1/extract/route.ts:168`, `src/app/api/compare/route.ts:319`, `src/app/api/templates/rules/curate/route.ts:83`, `src/app/api/templates/corrections/[id]/generate/route.ts:60`. All pass `provider: target.provider, model: target.model` — no change required to any caller: the vertex path routes on the same `provider` string.
- **Client audit (SEC-4):** grep for `fetch("https://generativelanguage")` / `fetch("https://aiplatform")` under `src/` — only hits are the two existing server-only fetches to OpenAI/OpenRouter (`src/lib/ai-handler.ts:107, 142`). Zero client-side AI calls. Grep for `NEXT_PUBLIC_.*API` / `NEXT_PUBLIC_.*KEY` under `src/` — one hit, `NEXT_PUBLIC_PAGE_SELECTION_MAX`, unrelated. No AI key ever crosses to the browser bundle.
- **Legacy `src/lib/gemini.ts`:** `generateWithRotation()` is defined but has zero callers in `src/`. Kept for compat; secret-log substring hardened as defence-in-depth (see SEC-3 below).

## Vertex integration

- **Endpoint (Express Mode confirmed):** `https://aiplatform.googleapis.com/v1/publishers/google/models/<model>:generateContent`. Global endpoint — no location prefix required for Express keys. Regional (`<loc>-aiplatform.googleapis.com`) requires OAuth/service-account, explicitly out of scope.
- **Auth header (SEC-1):** `x-goog-api-key: <key>`. Never in URL. Code:
  ```ts
  const res = await fetch(url, {
      method: "POST",
      headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,          // SEC-1
      },
      body: JSON.stringify(body),
  });
  ```
  (`src/lib/ai-handler.ts`, `generateVertexAI()`.)
- **Model + location:** `AIProviderRequest` gains optional `location?: string`. Currently unused because the global Express endpoint doesn't need it — plumbed through for a future region-scoped variant if operator gets one.
- **Multi-image confirmed:** payload uses `contents: [{ role: "user", parts: [{ text }, { inline_data: { mime_type, data } }, ...] }]` — byte-identical shape to the AI Studio Gemini SDK's `generateContent` under the hood. The crop pass (`src/app/api/upload/route.ts:359`) sends `images: cropImages` — that array flows through `generateWithAI` → `finalImages` → `generateVertexAI` and each image becomes its own `inline_data` part. Confirmed by inspection.
- **DID NOT build** service-account / JWT / OAuth flow. Express-mode API key only, per spec.

## Files changed

| File | Lines | What |
|---|---|---|
| `src/lib/redactSecrets.ts` | NEW (whole file) | AIza / `?key=` / `x-goog-api-key` / `Bearer` scrubber. |
| `src/lib/ai-handler.ts` | +1 import, +9 interface, +9 dispatch, +65 new `generateVertexAI` | Provider path + SEC-1 header + redacted error surface. |
| `src/lib/apiResponse.ts` | +1 import, +3 changed lines around `console.error` | Route every server error log through `redactSecrets()`. |
| `src/lib/gemini.ts` | 2 log strings hardened | Legacy path (unused) no longer prints leading 8 chars of the key. |
| `src/app/api/admin/settings/route.ts` | 1 comment line | Documents `vertex_ai` in the provider enum comment. Storage/masking untouched — already correct. |
| `src/app/api/admin/settings/test/route.ts` | NEW (whole file) | POST `{id}` → server-loads stored key → 1-token test call → returns code only (SEC-6). |
| `src/components/APISettingsView.tsx` | +1 dropdown option, +19 test handler, +8 test button, +1 badge colour | UI: Vertex AI (Express) option, per-config Test button. |

## SECURITY CHECKLIST

### SEC-1 — key in header, never in URL
Header used verbatim in `generateVertexAI()`:
```ts
headers: {
    "Content-Type": "application/json",
    "x-goog-api-key": key,
},
```
URL is a plain template string, no `key=` param anywhere:
```ts
const url = `https://${host}/v1/publishers/google/models/${encodeURIComponent(modelName)}:generateContent`;
```
Verified by `grep -nE 'key=' src/lib/ai-handler.ts` → 0 hits.

### SEC-2 — GET returns masked keys
Existing mask logic at `src/app/api/admin/settings/route.ts:53-56` was already applied to ALL configs (env + DB, all providers) before shape-return. Verified by re-reading the GET path — no branch skips masking. Vertex keys pass through the same `.map(c => ({...c, apiKey: mask(c.apiKey)}))`. Same protection now covers Vertex keys and continues to cover Gemini keys.

Response shape stays: `{ configs: [{ ..., apiKey: "AIzaXX....XXXX" }] }` — no code path returns the full key.

### SEC-3 — no key ever logged
New helper `src/lib/redactSecrets.ts` scrubs four patterns before any string reaches `console.warn`/`console.error`:
1. `AIza[0-9A-Za-z_-]{35}` — Google API keys.
2. `[?&]key=<anything>` — URL query params (defence for any lib that ignores SEC-1).
3. `x-goog-api-key: <val>` — header echoes in error dumps.
4. `Bearer <token>` — OpenAI/OpenRouter surfaces (bonus hardening).

Sites now routed through `redactSecrets()`:
- `src/lib/ai-handler.ts` `generateWithAI` `console.warn` (per-key fail message).
- `src/lib/ai-handler.ts` `generateVertexAI` — Google error body redacted **before** the `throw`, so upstream `catch` never sees the raw string.
- `src/lib/apiResponse.ts` `fail()` — every `console.error("[api:${context}]", code, ...)` for every route.

Sites reviewed and left as-is (safe):
- `src/lib/ai-usage.ts:62` `console.error("Failed to write ai_usage:", err)` — `err` is a D1 error, no provider payload.
- `src/lib/gemini.ts:14, 28` — legacy, hardened to `"AIza****"` literal.
- `console.error("Parse Error:", e)` in `upload/route.ts:304` — parse failure on the model's OUTPUT text (never contains the key).
- `console.error("[ocr-6] crop response parse error:", e)` — same, output-text parse.

### SEC-4 — server-only path
Grep confirms zero client-side AI calls:
```
$ grep -rE 'fetch\(.*(generativelanguage|aiplatform)' src/
(no matches)
$ grep -rE 'fetch\(.*(openai\.com|openrouter\.ai)' src/lib/frontend-* src/components/
(no matches)
```
`generateWithAI` is imported ONLY by files under `src/app/api/**/route.ts`. No import chain reaches `src/components/**` or `src/lib/frontend-*`.

New test endpoint `POST /api/admin/settings/test` takes only `{ id }` — the key is loaded server-side via `getActiveAIConfigs(env)`; the browser never sends or receives the plaintext key on this path.

Grep for `NEXT_PUBLIC_*` bindings that could carry an AI secret: only `NEXT_PUBLIC_PAGE_SELECTION_MAX` exists — unrelated. No `NEXT_PUBLIC_*_API_KEY` / `NEXT_PUBLIC_GEMINI_*` / `NEXT_PUBLIC_VERTEX_*` anywhere.

### SEC-5 — storage follows existing pattern
No new storage layer. Vertex configs live in the same D1 row `system_settings.value` under key `AI_POWER_CONFIG` as every other provider (Gemini/OpenAI/OpenRouter). The existing `AIConfig` shape (`{id, provider, model, apiKey, label, isActive}`) is unchanged — `provider: "vertex_ai"` is just a new string value. No new secret binding, no new wrangler secret, no new env var.

### SEC-6 — provider errors return `AI_FAILED`
Vertex error path: raw body scrubbed **inside** `generateVertexAI()` before throw → caller catches → `fail(ErrorCode.AI_FAILED, { detail: err, context: "..." })` → `apiResponse.ts` never includes `detail` in the response body (see line ~106 `// For now: never expose to client.`) → client receives `{ok:false, code:"AI_FAILED", error:"AI processing failed."}` only.

Test endpoint returns `fail(ErrorCode.AI_FAILED, ...)` on any provider failure — no upstream body, no URL, no header content. Success returns `{ok:true, provider, model, sample: text.slice(0,40)}` — model output only.

## Metering mapping

| Vertex field (`usageMetadata.*`) | `logAiUsage` field | Note |
|---|---|---|
| `promptTokenCount` | `inputTokens` | Direct. |
| `candidatesTokenCount` | `outputTokens` (partial) | Direct. |
| `thoughtsTokenCount` | `outputTokens` (added) | Mirrors the Gemini AI Studio mapping — Gemini 2.5 thinking tokens are billed as output. |
| (missing / omitted) | `0` | If Vertex Express omits `usageMetadata` in some responses, we log `0` rather than crash — flagged as a follow-up to confirm empirically against a live call. |

Provider string logged as `"vertex_ai"` so the admin AI-usage dashboard can attribute cost to the new provider separately from `"gemini"`.

## Multi-image confirmation

Payload built by `generateVertexAI`:
```ts
const parts: any[] = [{ text: prompt }];
for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
}
const body = { contents: [{ role: "user", parts }], generationConfig: { temperature: 0, topP: 1 } };
```
Matches the AI Studio SDK's on-the-wire shape (SDK sends the same `contents.parts[]` array; `inlineData` in SDK camelCase serialises to `inline_data` snake_case). Crop pass at `src/app/api/upload/route.ts:359` passes `images: cropImages` (array of N crops) — every crop becomes a separate part in the same request. OCR-6/6b/6c multi-image contract preserved.

Not empirically validated against a live Vertex Express endpoint (operator will do preview verification).

## Follow-ups flagged

- **frontend-ui / i18n:** the new "Vertex AI (Express)" dropdown label + "Test" button text are hard-coded English. Add `apiSettings.provider.vertex`, `apiSettings.testConnection` (th + en) if the ops UI is meant to be fully bilingual. Scope: `src/lib/i18n/locales/{th,en}.ts`. Non-blocking — admin UI, small strings.
- **empirical Vertex verification:** operator preview-verify (`npm run preview`, then use the Test button on a live Vertex Express key + one OCR run + one crop pass). Confirm (a) test button returns success, (b) `provider: "vertex_ai"` rows appear in `ai_usage` with non-zero token counts, (c) OCR-6 crop path still delivers multi-line output on the ใบโอนย้ายสินทรัพย์ fixture.
- **`usageMetadata` shape confirmation:** if Vertex Express omits `thoughtsTokenCount` on non-2.5 models, the mapping is still correct (falsy → 0). Log a data-check after first prod run: `SELECT AVG(input_tokens), AVG(output_tokens) FROM ai_usage WHERE provider='vertex_ai'` and compare to the Gemini AI Studio baseline for the same model.
- **`v1beta1` fallback:** Google occasionally moves Express Mode between `v1` and `v1beta1`. If the operator hits `404` on the endpoint, swap to `v1beta1` in `generateVertexAI()` (one string change). Not doing it now — spec URL uses `v1`.
- **Legacy `src/lib/gemini.ts`:** zero callers — safe to delete in a follow-up cleanup. Left intact this pass to keep the diff minimal.
- **Pre-existing security notes:** none red-flag. Masking on GET was already correct; POST already treats masked-echo as "keep existing"; server-only path was already the norm. The only pre-existing weak spot was `generateWithRotation`'s `key.substring(0, 8)` debug log — hardened here as defence-in-depth even though the function is dead code.
- **Admin UI polish (out of scope of this task but worth noting):** the config edit form pre-fills the masked key into a text input the user could accidentally submit — the POST handler already recognises the `"...."` marker and keeps the existing key, so no leak, but the UX is unusual. Could switch to a "Enter new key to replace" placeholder-only field on edit. Not doing here.

## `/security-review` status

**Not run** — I do not have direct access to invoke the `/security-review` skill from this session. **Action required from operator:** run `/security-review` on the diff before deploy. Files to focus the review on:

- `src/lib/redactSecrets.ts` — regex correctness (no bypass patterns).
- `src/lib/ai-handler.ts` `generateVertexAI` — header, URL, error redaction, response parsing.
- `src/lib/apiResponse.ts` `fail()` — redaction covers every `console.error` path.
- `src/app/api/admin/settings/test/route.ts` — auth guard, code-only response, no key echo.
- `src/components/APISettingsView.tsx` — test button never touches key, only `id`.

Build status: `npx tsc --noEmit` clean, `npm run build` clean, no key literals in the diff (`grep -E 'AIza[0-9A-Za-z_-]{35}'` on the diff returns only the regex definition inside `redactSecrets.ts` and the doc placeholders in this report).
