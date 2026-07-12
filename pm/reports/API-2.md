# API-2 — Error codes instead of raw messages (OCR routes)

**Status:** review · **Sprint:** OCR Stabilization

## Summary

All three OCR routes (`/api/upload`, `/api/status`, `/api/v1/extract`) now
return `{ ok: false, code, error, vars?, detail? }` for every failure — no raw
`error.message` reaches the client. `fail()` was extended to include a
backward-compat English `error` string so callers still reading `.error`
(Compare workspace, admin views, older paths not yet on UI-3) keep rendering
something. The v1/extract H4 quick win landed: no `raw:` payload in any error
response, and the raw AI text now goes to `logSystemEvent("V1_EXTRACT_PARSE_FAIL", ...)`
with `userId` + `file.name` for admin diagnostics.

## Codes used (the OCR-flow contract UI-3 built against)

| Code | Emitted by | Situation |
|------|------------|-----------|
| `MISSING_FIELDS` | upload, status, v1/extract | Required form field missing (`file`, `id`, `email`/`password`/`file`) |
| `FILE_TOO_LARGE` | upload, v1/extract | Upload > `MAX_UPLOAD_SIZE_MB` (API-3, unchanged) |
| `TOO_MANY_PAGES` | upload, v1/extract | Page-selection > cap (API-1, via `parseAndValidatePages`, unchanged) |
| `BAD_REQUEST` | upload, v1/extract | Malformed `pages` / `total_pages` (via `parseAndValidatePages`, unchanged) |
| `USER_NOT_FOUND` | upload | Session's userId no longer in `users` table |
| `INSUFFICIENT_CREDITS` | upload, v1/extract | Balance < estimated cost; `vars: { need, have }` |
| `FEATURE_DISABLED` | upload, v1/extract | Tier's `ocr` / `public_api` flag off, or non-admin hitting v1/extract |
| `UNAUTHORIZED` | status, v1/extract | Status: doc owned by a different user (and caller not admin). v1/extract: unknown email OR wrong password (no distinction — security best-practice already present) |
| `NOT_FOUND` | status | `documents` row missing |
| `AI_UNAVAILABLE` | v1/extract | Zero active AI configs available |
| `AI_FAILED` | v1/extract | AI response wasn't valid JSON (parse threw) |
| `SERVER_ERROR` | upload, status, v1/extract | Missing D1/BUCKET binding, or bare outer-catch on `/api/status` |
| `UPLOAD_FAILED` | upload | Bare outer-catch (defensive last resort) |
| `PROCESSING_FAILED` | v1/extract | Bare outer-catch (defensive last resort) |

Guards (`requireUser`, `ensureCanActAs`) already return coded responses via
their internal calls into `fail()` and were not touched here — they emit
`UNAUTHORIZED` on their own path.

## `fail()` shape — before / after

**Before:** `{ ok: false, code, vars? }` — no BC `error` field. Any caller
still reading `.error` (Compare, admin, docs, billing) got `undefined` and
often rendered "undefined" or an empty toast.

**After:**
```ts
{ ok: false, code, error: <static English fallback>, vars?, detail? }
```

- New `error: string` field populated from a static `FALLBACK_MESSAGE` map keyed
  by `ErrorCode`. The map mirrors `errorCodes.*` in `src/lib/i18n/locales/en.ts`
  (structurally — kept intentionally decoupled so server routes don't pull in
  locale detection; dynamic i18n on the server is Phase 7.5's job).
- All existing callers of `fail()` unaffected — signature unchanged, only the
  response body has one extra field.
- UI-3-aware callers still prefer the `code` field via `apiError(code, vars, t)`;
  `error` is the safety net for the rest.

## Raw-payload strip (H4)

Only site that logged the raw AI response was `v1/extract` line 184, and it was
already inside a `console.error(...)` — never in the response body. The change:

- Removed `console.error(..., "raw:", text?.slice(0, 500))`.
- Added `logSystemEvent(env, "V1_EXTRACT_PARSE_FAIL", "parse=<msg> file=<name> raw=\"<slice>\"", "info", user.id)` so admin logs still capture the raw slice for diagnostics.
- The failure response is now purely `fail(ErrorCode.AI_FAILED, { detail: e })` — no `raw:`.

Grepping the 3 routes post-change for `raw:` → 0 hits.

## Files changed (line ranges)

- `src/lib/apiResponse.ts` — added `FALLBACK_MESSAGE` map (L28–L54), added
  `error` field to `ApiFailure` interface (L18–L26), populated `body.error` in
  `fail()` (L79–L86).
- `src/app/api/upload/route.ts` — converted `throw new Error("Cloudflare bindings...")`
  to `return fail(SERVER_ERROR, ...)` at L138–L146.
- `src/app/api/v1/extract/route.ts` — replaced `console.error(..., "raw:", ...)`
  with `logSystemEvent("V1_EXTRACT_PARSE_FAIL", ...)` at L183–L197.
- `src/app/api/status/route.ts` — no changes needed; already 100% coded.

## Route-by-route conversion

**`/api/upload`**
- L138 `throw new Error("Cloudflare bindings...")` → `return fail(SERVER_ERROR, { detail, context })`. Was previously caught by the outer `catch` and swallowed into a generic `UPLOAD_FAILED` with no signal of the binding config root cause.
- L205 `throw new Error("No AI Configuration available")` — LEFT AS-IS. Inside `runOCR` (fire-and-forget via `ctx.waitUntil`); the initial response was already sent. Failure surfaces via the inner catch (L560–L566) which writes `documents.status = 'error'` and calls `logSystemEvent("OCR_EXTRACTION_ERROR", ...)`. `/api/status` reads that row and returns `{ status: "error", data: {...} }` — no user-facing raw-message leak (OCRWorkspace shows a generic `t("ocr.aiFailedShort")` on `status === "error"`, per UI-3). DB shape untouched per task's "DB refactor out of scope" rule.
- Everything else (API-1 pages, API-3 size, MISSING_FIELDS, USER_NOT_FOUND, INSUFFICIENT_CREDITS, FEATURE_DISABLED, outer catch UPLOAD_FAILED) was already `fail()`-based from prior tasks.

**`/api/status`**
- Zero conversions needed. All exits already use `fail(code, ...)`:
  MISSING_FIELDS (no id), SERVER_ERROR (no DB binding / outer catch),
  NOT_FOUND (doc missing), UNAUTHORIZED (owner mismatch). The `data.error =
  "Unknown processing error"` at L48 is a payload field on a **successful**
  response body (`ok({ success: true, status, data })`), not an error
  envelope — left as-is.

**`/api/v1/extract`**
- L184 raw-payload strip (see above).
- All exits use coded `fail()`: MISSING_FIELDS, FILE_TOO_LARGE (API-3),
  TOO_MANY_PAGES / BAD_REQUEST (API-1), SERVER_ERROR, UNAUTHORIZED (unified
  for unknown-email + wrong-password — security best-practice already in
  place), FEATURE_DISABLED, INSUFFICIENT_CREDITS, AI_UNAVAILABLE, AI_FAILED,
  outer-catch PROCESSING_FAILED.

## Not converted — justified

| Site | Why |
|------|-----|
| `upload/route.ts:205` `throw new Error("No AI Configuration available…")` | Inside `runOCR`, fire-and-forget after the initial `ok(...)` response was sent. Inner `catch` at L560 already updates `documents.status='error'` + `logSystemEvent("OCR_EXTRACTION_ERROR", ...)`. Not user-visible: OCRWorkspace shows a generic message on `status==='error'`. DB payload shape (`raw_json`) stays untouched per task's scope rule. |
| `requireUser`, `ensureCanActAs` guards | Already return coded Responses via internal `fail()` calls. Out of scope per task. |
| Compare / admin / docs / billing / templates routes | Explicitly out of scope — Phase 7.5. |

## Backward compat

Every failure body now carries **both**:
- `code: ErrorCodeT` — machine-readable contract, used by UI-3's `apiError()`.
- `error: string` — human-readable English fallback for legacy callers still
  reading `.error`.

`vars` and `detail` unchanged.

## Verification

- `npx tsc --noEmit` — clean (silent).
- `npm run build` — clean; all routes emitted including `/api/upload`,
  `/api/status`, `/api/v1/extract`.
- Post-change grep for `throw new Error(` in the 3 routes → 1 hit (upload:205,
  justified above).
- Post-change grep for `NextResponse.json` / `Response.json` in the 3 routes → 0.
- Post-change grep for `raw:` in the 3 routes → 0.
- Not deployed. No Gemini calls made.

## Follow-ups flagged

- Compare + admin + documents + billing + templates routes still have raw
  `error: msg` shapes — Phase 7.5 catalog refactor. Their existing UI paths
  will keep working because of the new BC `error` field once they migrate to
  `fail()`.
- If future work adds new codes here (or elsewhere), the `FALLBACK_MESSAGE`
  map in `apiResponse.ts` should get an entry, AND `errorCodes.*` in both
  `en.ts` and `th.ts` (UI-3 catalog).
- `documents.status='error'` rows currently persist raw AI error strings in
  `raw_json.error`. A `status_code TEXT` column on `documents` would let
  `/api/status` return a proper code — DB migration deliberately deferred.
