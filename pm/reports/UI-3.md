# UI-3 — friendlyError in OCR flow

**Status:** review · **Sprint:** OCR Stabilization

## Summary
No raw `err.message` strings reachable in the OCR flow (OCRWorkspace + login + register). All error surfaces go through `friendlyError()` / `apiError()` with a proper i18n fallback to `errors.generic`. Session was interrupted before the report + BOARD flip landed; code changes are complete and TypeScript + `npm run build` are clean.

## What landed

### `src/lib/friendlyError.ts`
Two exported helpers:
- **`apiError(code, vars, t)`** — canonical mapping for `{ ok: false, code, vars }` responses. Looks up `errorCodes.<CODE>` in the i18n catalog; falls back to `errors.generic` if the key isn't defined (never leaks the raw code slug like `"errorCodes.FOO"` to users).
- **`friendlyError(err, t, { context, fallbackKey })`** — for raw thrown errors that haven't been coded yet. Classifies:
  - Network → `errors.network`
  - `401` / "unauthorized" → `errors.unauthorized`
  - `429` / "rate limit" / "quota" → `errors.rateLimited`
  - "insufficient" / "not enough credit" → `errors.insufficientCredits`
  - "ai returned" / "invalid format" / "gemini" → `errors.aiFailed`
  - "too large" / "payload" → `errors.fileTooLarge`
  - Unknown → `fallbackKey` (defaults to `errors.generic`).
  Raw detail always goes to `console.warn` for dev — never to the user.

### i18n catalog (both `th.ts` + `en.ts`)
Two subtrees:
- **`errors.*`** (existing, extended) — generic, network, unauthorized, rateLimited, insufficientCredits, uploadFailed, aiFailed, loginFailed, registerFailed, saveFailed, checkoutFailed, fileTooLarge, invalidFormat.
- **`errorCodes.*`** (new) — one entry per `ErrorCode` enum member the OCR flow can hit today: MISSING_FIELDS, INSUFFICIENT_CREDITS `{need,have}`, FILE_TOO_LARGE (API-3), TOO_MANY_PAGES `{actual,limit}` (API-1), USER_NOT_FOUND, UNAUTHORIZED, FEATURE_DISABLED, AI_UNAVAILABLE, AI_FAILED, BAD_REQUEST, SERVER_ERROR, UPLOAD_FAILED.

### Call-site conversion
- `src/components/OCRWorkspace.tsx` — 8 error-handling sites converted (upload flow, batch, status polling, template save, credit dialog, etc.). 0 raw `err.message` remain.
- `src/app/login/page.tsx` — 2 sites (submit + registration link).
- `src/app/register/page.tsx` — 3 sites (validation + submit + redirect).

## Not touched (out of scope per H1)
- Compare workspace, admin views, documents view, billing — Phase 7.5 catalog refactor owns these.
- Backend routes — API-2's job to swap raw throws for `fail(code, ...)` on the paths that still use raw messages.

## Follow-ups flagged
- `errorCodes.*` catalog covers the codes that OCR/login/register can hit today. When API-2 swaps additional raw throws to `fail()`, add the new codes to both locales alongside the backend change.
- If any code returns without an i18n entry the user sees the generic message (safe) — dev sees the raw `errors.generic` fallback in `console.warn`. Watch admin logs for missing codes.

## Verification
- `npx tsc --noEmit` — clean.
- `npm run build` — clean (all routes emit).
- `grep -c "err\.message"` on the three flow files → 0 matches.
