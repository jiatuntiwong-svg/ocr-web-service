# API-4 — Backend fulldoc mode

**Status:** 👀 review · **Author:** backend-api · **Date:** 2026-07-12
**Deploy:** none — awaits PM approval before ship.
**Sprint 2 tie-in:** consumes S2-2 `verbatim_transcribe` profile; unblocks OCR-8 downstream (fulldoc + landscape).

## 1. Response shape contract

Both entry points now honour `mode=fulldoc`. Absent = today's byte-identical field-extract behavior (public-API + web-UI BC preserved).

### `/api/v1/extract` (synchronous)

Field mode (default, unchanged):
```json
{ "ok": true, "success": true, "processing_time_ms": 1234, "extracted_data": { "<field>": { "value": "...", "confidence": 0-100, "corrections": [] } } }
```

Fulldoc mode:
```json
{
  "ok": true,
  "data": {
    "pages": [ { "page": 1, "text": "..." }, { "page": 2, "text": "..." } ]
  },
  "_meta": { "processing_time_ms": 1234, "mode": "fulldoc", "partial": true }
}
```

`_meta.partial: true` only when the AI response could not be parsed as `{ pages: [...] }` and we fell back to a single-page raw dump (logged as `V1_EXTRACT_FULLDOC_SHAPE_FALLBACK`).

### `/api/upload` (async — polled via `/api/status`)

Upload response envelope is unchanged (`{ok, success, message, documentId, credits_estimate}`); the fulldoc shape lands in `raw_json` and is returned by `/api/status`:

```json
{ "ok": true, "success": true, "status": "completed", "data": { "pages": [ { "page": 1, "text": "..." } ], "corrections": [] } }
```

On shape fallback, `data._partial: true` is set inline (single top-level field, not `_meta`, so /api/status doesn't need contract changes). Fallback event: `FULLDOC_SHAPE_FALLBACK`.

Errors continue to use API-2 coded envelopes (`{ok:false, code, error, vars, detail}`).

## 2. Wiring points

| File | Change |
|------|--------|
| `src/app/api/upload/route.ts` | Estimate switches to `per_page` + `pages: selectedPages.length || totalPages || 1` for fulldoc. Post-AI reshape drops the previous `full_document` wrap and stores `{pages, corrections?}` directly. `extracted_data` summary insert (company/tax/date), crop pass, and low-confidence notification are all skipped for fulldoc — none of those hooks make sense for a per-page transcript, and running them would either dirty the DB with all-null rows or produce useless notifications. |
| `src/app/api/v1/extract/route.ts` | Reads `mode` from FormData; when fulldoc, uses `verbatim_transcribe` profile (or an inline fulldoc prompt when `ENABLE_PROMPT_PROFILES=false`), charges per selected page via `chargeCreditsAtomic`, returns the `{ok, data:{pages}, _meta}` envelope. Field mode returns the pre-API-4 envelope untouched. |
| `src/lib/promptProfiles/verbatimTranscribe.ts` | Already ships from S2-2 with per-page output rules; no edits needed. Accepts `{selectedPages}` context and returns a valid multi-page JSON contract. |

`ENABLE_PROMPT_PROFILES` OFF path preserved on both routes — the inline fallbacks stay compatible with the fulldoc `{pages}` contract (no field-record leakage).

## 3. Page-image assembly

Fulldoc uses the same stacked-PNG payload the field pipeline already accepts. Multi-page assembly happens client-side (`pdfFileToImageDetailed`, browser-side raster) — the server sees a single image, exactly like field mode. The prompt tells the model "this stacked image is the pages you selected in this order" via `verbatim_transcribe`'s preamble, using original PDF page numbers when a selection was provided and 1..N otherwise.

The Cloudflare Workers runtime constraint (no filesystem, memory-bound) rules out server-side multi-image assembly for now; keeping the client-side raster path is the same call OCR-6/6c settled.

## 4. Credit charge accounting (BILL-1)

| Path | Amount | Rationale |
|------|--------|-----------|
| `/api/upload` fulldoc | `estimateCredits({operation:"ocr", pages: max(1, selectedPages.length || totalPages || 1), creditModel:"per_page"})` | Spec-locked (frontend-ui.md UI-4b §3). |
| `/api/upload` field | Existing formula (no BC change). | Field-mode BC. |
| `/api/v1/extract` fulldoc | `max(1, selectedPages.length || totalPages || 1)` via `chargeCreditsAtomic`. | Same per-page rule as web UI. |
| `/api/v1/extract` field | Flat 1 credit (unchanged). | Public API BC — pre-API-4 shape. |

Single charge per request — the existing `chargeCreditsAtomic` path handles both routes so BILL-1 race safety carries over unchanged.

## 5. Feature-flag rollback

`ENABLE_PROMPT_PROFILES=false`:
- `/api/upload` fulldoc: falls through to a byte-identical fulldoc inline prompt (kept in this task; no S2-2 profile call).
- `/api/v1/extract` fulldoc: new inline fulldoc prompt with the same per-page JSON contract.
- Field-mode code paths are byte-identical to pre-API-4 (only reads a new FormData field with default `"field"`).

Rollback = flip the flag or set `mode` unset. Neither changes DB schema.

## 6. Manual test plan (post-deploy, for PM)

Assumes admin creds `ADMIN_EMAIL` / `ADMIN_PW` and a 2-page PDF `sample.pdf`.

**Test A — field BC:**
```bash
curl -X POST https://<host>/api/v1/extract \
  -F email=$ADMIN_EMAIL -F password=$ADMIN_PW \
  -F file=@sample.pdf \
  -F "fields=ชื่อบริษัท, ยอดรวม"
# expect: {ok:true, success:true, processing_time_ms:.., extracted_data: {...}}
```

**Test B — fulldoc single-page:**
```bash
curl -X POST https://<host>/api/v1/extract \
  -F email=$ADMIN_EMAIL -F password=$ADMIN_PW \
  -F file=@page1.png -F mode=fulldoc
# expect: {ok:true, data:{pages:[{page:1,text:"..."}]}, _meta:{mode:"fulldoc", processing_time_ms:..}}
# expect: user credits_remaining decremented by 1
```

**Test C — fulldoc multi-page selection:**
```bash
curl -X POST https://<host>/api/v1/extract \
  -F email=$ADMIN_EMAIL -F password=$ADMIN_PW \
  -F file=@stack.png -F mode=fulldoc \
  -F 'pages=[1,3]' -F total_pages=5
# expect: pages array uses page numbers 1 and 3 as keys
# expect: credits decremented by 2
```

**Test D — web UI fulldoc (OCRWorkspaceV2 flag ON):** upload PDF, toggle "อ่านทั้งเอกสาร" card at fields stage, run. Should now render the real per-page transcript (previously synthesized via string-join fallback in `OCRWorkspaceV2.tsx:632-639`).

**Test E — malformed AI fallback:** hard to force in prod; monitor `V1_EXTRACT_FULLDOC_SHAPE_FALLBACK` and `FULLDOC_SHAPE_FALLBACK` events in admin logs after real traffic.

## 7. Verification

- `npx tsc --noEmit` → exit 0.
- `npm run build` → 43 routes, clean.

Runtime verification deferred to PM UAT (no deploy yet, per task guardrail).

## 8. Red flags / open questions

1. **`/api/status` shape choice for fulldoc.** Chose to keep the existing envelope (`data` = raw_json) and inline `_partial: true` on the data object (rather than a sibling `_meta`) to avoid touching the status route + its client. If PM prefers `_meta` symmetry with `/api/v1/extract`, the reshape is a 2-line change in `status/route.ts` (return `_meta` alongside `data`) — flag it and I'll do it.

2. **Field mode still on legacy formula in `/api/upload`.** BILL-1 was deployed with per_page as the operator default, yet `estimateCredits` in upload/route.ts still calls without `creditModel`, so field mode silently uses `field_formula` on the server (client already sends per_page in `OCRWorkspaceV2.tsx:668`). Not part of API-4 scope, but worth a BILL follow-up — currently the client-side estimate and the server-side charge can disagree for field mode. Fulldoc dodges this because I passed `creditModel:"per_page"` explicitly.

3. **Public API BC for v1/extract field mode.** Flat 1 credit rule preserved. Considered switching field mode to per_page for consistency but the task explicitly required BC for pre-API-4 callers, so held.

4. **Merge collision with OCR-8.** OCR-8 landed `CropManifestEntry.bytes`, `cropDpiScale`, and `_crop_meta` observability in upload/route.ts. My changes are orthogonal (touch fulldoc branches + estimate) — no textual conflicts observed after their file update.

5. **Batch upload path.** Batch = client-side loop over `/api/upload`; each file carrying `mode=fulldoc` behaves like the single-file fulldoc contract. No dedicated batch endpoint to change.

## 9. Files touched

- `src/app/api/upload/route.ts` — 5 edits (estimate, reshape, extracted_data guard, crop-pass guard, low-confidence guard).
- `src/app/api/v1/extract/route.ts` — 4 edits (mode read, charge amount, prompt branch, response envelope).

No new dependencies. No component / DB schema changes.
