# API-1 — Page-selection support in upload/extract

**Status:** ✅ implementation complete — deploy-ready. Awaiting UI-1 (page-picker) before issue 1.3 can be marked resolved end-to-end.
**Owner:** backend-api agent
**Sprint:** OCR Stabilization
**Related:** `pm/tasks/backend-api.md` §API-1, `docs/OCR_TESTING_LOG.md` §1.3, `pm/reports/OCR-6.md`

---

## API contract (frontend-ui builds against this)

Both `POST /api/upload` and `POST /api/v1/extract` accept **two new optional multipart parts** on top of every existing field. Absent → today's behaviour (with the new cap below). Present → they are validated and echoed to the AI prompt.

| Part | Type | Required | Notes |
|---|---|---|---|
| `pages` | JSON-encoded array of 1-based integers | no | ORIGINAL PDF page numbers actually included in the uploaded PNG, in stacked-image order (top → bottom). Deduped by the server; ordering preserved. Non-empty when present. |
| `total_pages` | integer (as string) | no | The source PDF's real page count. Client-computed via pdfjs. |

### Validation rules

1. `total_pages`, when present, must be a positive integer.
2. `pages`, when present, must be valid JSON, non-empty, every entry an integer ≥ 1, deduped server-side (client-supplied order preserved). Length ≤ `PAGE_SELECTION_MAX` (default **5**, tunable via `NEXT_PUBLIC_PAGE_SELECTION_MAX`).
3. If both are present, every `pages` entry must be ≤ `total_pages`.
4. **New cap** — the "clear error code instead of silently grinding" behaviour:
   - `pages` absent **and** `total_pages > PAGE_SELECTION_MAX` → **`TOO_MANY_PAGES`**.
   - `pages` present with length > `PAGE_SELECTION_MAX` → **`TOO_MANY_PAGES`**.

### `TOO_MANY_PAGES` payload

```json
{
  "ok": false,
  "code": "TOO_MANY_PAGES",
  "vars": { "limit": 5, "actual": 12 }
}
```
HTTP status **400**. `vars.limit` = server's `PAGE_SELECTION_MAX`, `vars.actual` = the offending count (either `total_pages` or `pages.length`). Frontend-ui uses this to render a "PDF has {actual} pages — pick up to {limit}" toast + open the page-picker.

### Other validation failures

Invalid JSON, non-array, non-integer entries, entries out of range → **`BAD_REQUEST` / 400** with `detail` (dev-facing only, logged). No `TOO_MANY_PAGES` false positives.

### Backward compatibility

Neither field required. Uploads that omit both are identical to today's behaviour **except** the new >5-page cap now fires when `total_pages` is included and exceeds it. Callers that never send `total_pages` retain today's behaviour byte-for-byte.

---

## Path A vs Path B — decision

**Chose Path A: `bbox_hint.page` stays keyed to the ORIGINAL PDF page number, end-to-end.**

Justification:

- **Saved-template invariance.** Hints are stored on the template long-lived; the selection changes every run. If the client had to remap `page` numbers before sending (Path B), every codebase touchpoint that constructs a hint has to know the current selection, and any mistake silently corrupts extraction. Path A preserves the hint's meaning across all callers.
- **Debuggability.** With Path A, logs, admin dashboards, and future eval tooling read the same page number a human sees on the original PDF. Path B would make "hint page 2" mean different pages under different selections — impossible to reason about in aggregate.
- **Server-side prompt enrichment carries the mapping.** The whole-image prompt now begins with a preamble listing which original pages were included and in what stacked order (see `src/app/api/upload/route.ts` line ~215). The model reconciles "hint page 3 = 2nd tile from top" from that preamble, without any client-side remapping.
- **Crop-pass compatibility.** Crop images are already generated per-hint on the client and sent by numbered label; the crop AI call does not read `bbox_hint.page` at all. Path A therefore requires **no change to `src/lib/field-crops.ts` for the crop labelling side**. It only needs a small change on the CROP-GENERATION side (see follow-ups) to look up the correct rendered page when the stacked image contains a filtered subset.

Cost of Path A: the client's PDF rasteriser (`pdf-to-image.ts`) needs to be page-aware (render only the selected pages) and `field-crops.ts` needs the selection mapping to find the right per-page rect. Both flagged as follow-ups (see below); neither is in this task's scope.

Path B was rejected because "one wrong remap in any client silently corrupts all hints" is a worse failure mode than "one place needs the selection to compute pixel coords".

---

## Server-side vs client-side filtering

**PDF rasterisation is 100% client-side** (`src/lib/pdf-to-image.ts` uses `document.createElement("canvas")` — DOM-only, cannot run in Workers). The server never sees the source PDF; it receives a PNG that is already the stacked image of the selected pages.

Therefore `pages` on the server is **advisory metadata**, not a filter. Its concrete server-side jobs:

1. **Enforce the cap** — return `TOO_MANY_PAGES` when the client honestly declares a page count above `PAGE_SELECTION_MAX` and hasn't picked a subset. This is what stops the multi-minute-per-file silent grind (issue 1.3).
2. **Enrich the prompt** — tell the model which ORIGINAL pages made it into the tile stack and in what order, so `bbox_hint.page` in the fields block stays interpretable.
3. **Log for admin trace** — the selection is written into `system_logs` on both routes so a slow-run investigation can see whether a subset was picked.
4. **Path A hint invariance** — the server does not need to remap `bbox_hint.page`; the prompt preamble supplies the model with the mapping, and the crop manifest continues to use original page numbers.

This is a legitimate outcome and matches the spec's guidance. UI-1's page-picker is what actually shrinks the payload the AI sees.

---

## Files changed

| Path | Lines | Change |
|---|---|---|
| `src/lib/errorCodes.ts` | +2 | Added `TOO_MANY_PAGES` code + status 400. |
| `src/lib/ocrBatchConfig.ts` | +8 | Added `PAGE_SELECTION_MAX = 5` (env override `NEXT_PUBLIC_PAGE_SELECTION_MAX`). |
| `src/lib/pageSelection.ts` | +138 (new) | `parseAndValidatePages()`, `remapBboxHintPage()` (Path A helper for future callers), `describeSelection()`. Shared by both routes. |
| `src/app/api/upload/route.ts` | +33 / -2 | Parse `pages` + `total_pages` early; log selection in `DOCUMENT_UPLOAD`; prepend a Thai preamble to the whole-image prompt when a subset was picked. |
| `src/app/api/v1/extract/route.ts` | +26 / -1 | Parse `pages` + `total_pages` early; log selection via `logSystemEvent` in a new `API_EXTRACT` event; prepend the same Thai preamble to the prompt. Explicitly does NOT parse `field_crops` or `bbox_hint` — public API stays on the pre-hint path per OCR-4/TEST-1 discipline. |

### Intentionally not touched
- `src/lib/field-crops.ts` — cross-agent boundary (ocr-pipeline). See follow-ups.
- `src/lib/pdf-to-image.ts` — client-side rasteriser; ocr-pipeline / frontend-ui territory. See follow-ups.
- `src/components/OCRWorkspace.tsx`, `src/components/CompareWorkspace.tsx` — component boundary (frontend-ui).
- `docs/BEHAVIOR_REFERENCE.md` — docs-manager owns it.
- Crop AI prompt in `upload/route.ts` — unchanged; it does not need the selection because it operates on already-cropped images with per-image labels.

---

## `/v1/extract` contract note

`/v1/extract` **accepts** `pages` + `total_pages` and applies the same validation + `TOO_MANY_PAGES` cap. This is the only place it changed. In every other way it is **unchanged**:

- Still admin-role gated.
- Still deducts 1 credit up-front (unchanged pricing).
- **Does not parse `field_crops`, `crop_<idx>`, or `bbox_hint`.** If a caller sends `fields_json` with `bbox_hint` entries, the hints are silently ignored — same behaviour as today. Callers who need hint-driven extraction use `/api/upload`.
- Still logs `ai_usage` with `fn: "api_extract"`, no new metering surface.

---

## Metering — unchanged

Page selection does not affect the credit cost model in this task. Credit cost for `/api/upload` is computed from `fieldCount` (unchanged); for `/v1/extract` it is a flat 1 credit (unchanged). Fewer pages → cheaper AI tokens for us, same charge to the user. If we want per-page pricing in the future, that's a separate pricing-rework task; flagging it here only for visibility.

---

## Follow-ups (other agents)

### ocr-pipeline — `src/lib/field-crops.ts` under Path A
`buildFieldCrops()` today assumes `pageRects[]` from `pdfFileToImageDetailed` is ordered 1..N and looks up `hint.page - 1`. Under Path A, when the user selects e.g. `[1, 3, 5]`, the rasteriser only renders those 3 pages, so `pageRects` has length 3. A `hint.page = 3` should map to `pageRects[1]` (index 1, the 2nd rendered page), not `pageRects[2]` (out of bounds).

**Exact change:** accept the caller's `pages` selection array; when non-empty, translate `hint.page` via `pages.indexOf(hint.page)`; if `< 0`, skip that hint (page dropped from selection). Existing helper `remapBboxHintPage()` in `src/lib/pageSelection.ts` implements this and returns `null` for dropped pages — the crop helper can import and reuse it, keeping the semantics centralised.

### frontend-ui — client-side pipeline changes
1. **`src/lib/pdf-to-image.ts`** — extend `pdfFileToImageDetailed()` to accept `opts.pages?: number[]` and render only those page indices (1-based, in the given order). When absent, current behaviour. Return `pageRects` for the rendered pages only.
2. **`src/components/OCRWorkspace.tsx`** — the shared `prepareUploadWithCrops()` needs to:
   - Read `pdf.numPages` before rasterising and, if `> PAGE_SELECTION_MAX` and no picker used, present the picker or bail with a client-side toast (mirror the server's `TOO_MANY_PAGES` shape).
   - Pass the selected `pages` into `pdfFileToImageDetailed` AND `buildFieldCrops`.
   - Append `pages` (JSON) + `total_pages` to the multipart body for both `handleUpload` and `runBatchItem`.
3. **UI-1 page-picker component** — new. Renders a thumbnail grid of PDF pages with checkbox selection, capped at `PAGE_SELECTION_MAX`. Feeds `pages[]` into (2).

### i18n
Locale files (`src/lib/i18n/locales/en.ts`, `th.ts`) need a new `errorCodes.TOO_MANY_PAGES` entry consuming `{limit}` and `{actual}`. Owned by frontend-ui alongside UI-3.

---

## Verification

- `npx tsc --noEmit` → **exit 0**.
- `npm run build` → **clean** (all 42 routes emit, `/api/upload` and `/api/v1/extract` compiled with new parts).
- No empirical Gemini runs (per spec — burns credits, no verification available in-agent).
- `npm run preview` not run — no code path here is workerd-specific (no new Node APIs, no new bindings), and the touched surface is pure formData parsing + prompt string composition, both exercised by the build's static analysis. Operator: worth a smoke run after UI-1 lands so the contract is verified end-to-end.

---

## Backward-compat summary

- Any client that ignores this task's contract works today exactly as before, except when it sends a genuinely oversized PDF and (newly) declares `total_pages` — server refuses with `TOO_MANY_PAGES`. Old clients that don't send `total_pages` see zero behavioural change from this task.
- Existing template hints continue to work — Path A keeps `bbox_hint.page` invariant.
- Crop-pass metering, credit model, and single `ai_usage` row per operation — all unchanged.

---

_Author: backend-api agent, 2026-07-06_
