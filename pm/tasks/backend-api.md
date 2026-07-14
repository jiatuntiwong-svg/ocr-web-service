# Work orders — backend-api agent

Sprint: OCR Stabilization. Update pm/BOARD.md status when you start/finish a task. Write findings to pm/reports/<ID>.md.

---

## API-1 (P0) — Page-selection support in upload/extract

**Context:** Issue 1.3: 10+ page PDFs take minutes because every page is converted and sent to AI. Frontend will add a page-picker (UI-1); the API must accept the selection.

**Do:**
1. In `src/app/api/upload/route.ts` and `src/app/api/v1/extract/route.ts`: accept optional `pages: number[]` (1-based). Validate: non-empty, within page count, cap at a configurable max (default 5, see `src/lib/ocrBatchConfig.ts`).
2. When `pages` present, process only those pages. When absent, keep current behavior BUT enforce a `maxPages` cap with a clear error code (`TOO_MANY_PAGES`) instead of silently grinding.
3. Batch mode (`runBatchItem` path) gets the same param.
4. **⚠️ Added 2026-07-05 (from OCR-1 findings):** `bbox_hint` stores a `page` number per field. When `pages` filters/reorders pages, hints must be remapped to the new page indices (or keyed to original page numbers end-to-end). Coordinate the contract with ocr-pipeline before implementing — getting this wrong silently breaks all saved hints.

**Done when:** API contract documented in `pm/reports/API-1.md` (frontend-ui will build against it), tested via `npm run preview`.

---

## API-2 (P1) — Error codes instead of raw messages (OCR routes only)

**Context:** PENDING_ISSUES §H2: `/api/upload`, `/api/status`, `/api/v1/extract` return `error.message` — leaks internals, not i18n-able. Full catalog refactor is Phase 7.5; this sprint covers OCR routes only.

**Do:**
1. Responses become `{ ok: false, code: "UPLOAD_FAILED" | "AI_FAILED" | "TOO_MANY_PAGES" | "INSUFFICIENT_CREDITS" | "UNAUTHORIZED" | "FILE_TOO_LARGE" | ..., detail?: string }` — use/extend `src/lib/errorCodes.ts` and `src/lib/apiResponse.ts`.
2. `detail` is logged via `src/lib/logger.ts`, never required by the UI.
3. Strip any `raw: text` payloads from `/api/v1/extract` error responses (H4 quick win).
4. Keep backward compatibility: include a generic `error` string so existing UI doesn't break before UI-3 lands.

**Done when:** the three OCR routes return coded errors, codes listed in `pm/reports/API-2.md` for frontend-ui.

---

## API-3 (P2) — Upload size guard (F4)

**Context:** PENDING_ISSUES §F4: no size cap on uploads; huge embedded images can OOM the canvas/Worker.

**Do:**
1. Enforce max upload size in `api/upload` (propose limit based on Workers memory constraints — check with devops-cloudflare agent's OPS-1 findings; suggest 15–20 MB to start).
2. Return `FILE_TOO_LARGE` code (from API-2) with the limit in `vars`.

**Done when:** oversized upload rejected cleanly in preview build. Report in `pm/reports/API-3.md`.

---

**Coordinate:** retry param naming with ocr-pipeline (OCR-3); error codes list with frontend-ui (UI-3).

---

## API-4b (P1 🔥) — v1/extract AI-failure handling (found via UAT 2026-07-12)

**Evidence:** curl fulldoc → `PROCESSING_FAILED`; wrangler tail showed the real cause: default config = depleted AI-Studio Gemini key → 429 → `generateWithAI` throws → outer catch. Three defects:
1. **No inner try/catch around `generateWithAI`** in v1/extract → provider failures surface as meaningless `PROCESSING_FAILED`. Wrap it: map to `AI_FAILED` (or a new `AI_QUOTA` code when the provider error is 429/quota — add to errorCodes + FALLBACK_MESSAGE + i18n th/en).
2. **Charged credits are NOT refunded when the AI call fails** — `chargeCreditsAtomic` runs before the AI call; every failed curl burned credits. Add a refund (reverse credit) in the AI-failure path on BOTH v1/extract AND verify /api/upload's runOCR failure path refunds too.
3. **Default-config selection is fragile:** `finalConfigs[0]` may be a dead key while the UI picks a healthy one via `selectedModelId`. Improvement: try next active config (different provider) when all keys of the target fail — bounded to active configs, log which config served. Keep `modelId` param override.

4. **(added 2026-07-13, found via UAT)** MIME normalization: `file.type || "image/png"` doesn't catch `application/octet-stream` (curl/scripts default) → healthy key rejected with 400. Normalize: if `file.type` is empty OR `application/octet-stream`, infer from filename extension (.png/.jpg/.jpeg/.webp/.pdf map) with `image/png` final fallback. Return `BAD_REQUEST` with a helpful message for genuinely unsupported extensions. Critical for API-5 external callers.

**Acceptance:** curl fulldoc with a dead first config still succeeds via the healthy config; failures return coded errors (never PROCESSING_FAILED for AI-layer issues); failed runs refund; MIME octet-stream normalized; benchmark unaffected.

---

## API-5 (P1, next phase) — Public self-service OCR API (requested 2026-07-12)

**Goal:** external customers call OCR via API key — full self-service SaaS surface. Supersedes the admin-only email/password auth on `/api/v1/extract`. Related backlog: PENDING_ISSUES §G5b.

**Scope (phased — confirm plan with PM before coding):**
1. **Recon:** current `/api/v1/extract` (admin-gated, email/password form parts, flat 1 credit, no hints) + any existing api-key infra ("partial exists" per G5b).
2. **API keys:** per-user keys — generate/label/revoke in user settings UI; store HASHED (like passwords — never plaintext in D1), prefix display `sk-ocr-...xxxx`; auth via `Authorization: Bearer` header. Kill email/password auth on v1 (breaking change OK — no external users yet).
3. **Endpoint parity:** template_id param (so external calls get hints + crop pass = same accuracy as UI), `pages`/`total_pages` (already), `mode=fulldoc` (after API-4), `retry`. Response = coded errors (already, API-2) + stable JSON shape with provenance.
4. **Per-key rate limiting** (Workers-friendly: token bucket in D1 or Durable Object — evaluate) + per-key usage attribution in `ai_usage` + credit charge via `chargeCreditsAtomic` (already shared).
5. **Docs page** — public API reference (endpoint, auth, params, error codes, examples) + key management UI (frontend-ui coordinate).
6. **Security review gate** mandatory before launch (same discipline as AI-1): key hashing, no key in logs (`redactSecrets` extend for `sk-ocr-`), rate-limit bypass check, `/security-review` on the diff.

**Out of scope phase 1:** webhooks (G5a), n8n/Zapier connectors (G5f), OpenAPI spec generation.

**Prep item (added 2026-07-13):** root-cause the rate limit hit during benchmark batching (`wrangler tail` while reproducing — is it Workers-side or the single healthy AI-Studio key's RPM quota?). The answer feeds directly into API-5's rate-limit design AND capacity planning: if the bottleneck is one key's quota, external customers will saturate it on day one — key pool / quota increase is a launch prerequisite. Procedure documented in scripts/ocr-regression/README §Batched baseline.

**Estimate:** ~1 sprint. Sequencing: after OCR-8 + API-4 close the OCR track.
