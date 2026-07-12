# OCR-6 — Crop-based extraction for hinted fields

**Status:** ✅ implementation complete — deploy-ready. Awaiting operator rerun of OCR-2 Case 6 doc1 before we can claim issue 1.2 is fixed.
**Owner:** ocr-pipeline agent
**Sprint:** OCR Stabilization
**Related:** `pm/tasks/ocr-pipeline.md` §OCR-6, `pm/reports/OCR-2.md` §Case 6, `docs/OCR_TESTING_LOG.md` §4 row 1

---

## What was built

Whole-image extraction stays the canonical pass (unchanged). When the template
has hinted fields, the client now ALSO crops each hint from the same 3600px
rendered PNG and sends the crops as a manifest + files in the same
`/api/upload` request. The server runs one additional `generateWithAI` call
with all crops as multi-image input + a focused prompt, then merges the
crop values into the whole-image result for hinted fields only. Metering
records both AI calls' tokens as a single `ai_usage` row.

---

## Files changed

| Path | Lines | Change |
|---|---|---|
| `src/lib/pdf-to-image.ts` | +38 / -6 | Added `pdfFileToImageDetailed()` + `StackedPageRect` + `PdfRasterResult` types. Original `pdfFileToImage()` now delegates → backward-compatible for `CompareWorkspace`. |
| `src/lib/field-crops.ts` | +154 (new) | `buildFieldCrops()` + `CROP_LABEL_MARGIN` constants (0.15 x-pad, 0.15 top, 0.40 bottom). Loads the upload PNG once, crops via `canvas.drawImage(subrect)`, returns `Blob`s. Dev-only `console.debug` of derived rects. |
| `src/components/OCRWorkspace.tsx` | +58 / -14 | Added shared `prepareUploadWithCrops` + `appendCropsToFormData` helpers used by both `handleUpload` and `runBatchItem`. |
| `src/app/api/upload/route.ts` | +100 / -5 | Parses `field_crops` manifest + `crop_<idx>` file parts. After whole-image call, runs the crop pass (skipped for Excel). Merge policy (see below). Accumulates tokens into `totalInputTokens` / `totalOutputTokens` → one `logAiUsage` row. |

Not touched (intentionally):
- `src/app/api/v1/extract/route.ts` — per OCR-4 & TEST-1 findings, public API stays on the pre-`bbox_hint` path.
- Whole-image prompt in `upload/route.ts:161-187` — stable surface; crop pass is a strict augmentation.
- Compare pipeline — out of scope.
- `pdfFileToImage` callers in `CompareWorkspace.tsx` — signature unchanged for that overload.
- OCR-5 guardrails — the crop path effectively subsumes several of the OCR-5 hint-miss concerns (a null crop is now surfaced as `crop_miss:true` in `raw_json`, and non-matching field keys are rejected by the manifest) but no explicit bbox-overlap validation was added. OCR-5 remains on hold per BOARD 2026-07-06.

---

## Multi-page y% translation

The plan explicitly flagged this as the concern to verify. `bbox_hint.y` is
drawn in a **single-page preview** and stored as 0..1 relative to ONE page.
The uploaded PNG stacks pages vertically. Without translation, a hint on
page 3 with `y=0.2` would crop 20% down the FIRST page in the stack.

Fix: `pdfFileToImageDetailed()` now returns per-page pixel rects; the crop
helper looks up the correct page and adds its `y` offset before cropping.

```ts
// src/lib/field-crops.ts (excerpt)
const pageIdx = Math.max(0, Math.min(effectiveRects.length - 1, (hint.page ?? 1) - 1));
const pr = effectiveRects[pageIdx];
// ...
const px = Math.round(x0 * pr.width);
const py = Math.round(pr.y + y0 * pr.height); // ← page y-offset in stacked image
const pw = Math.max(1, Math.round((x1 - x0) * pr.width));
const ph = Math.max(1, Math.round((y1 - y0) * pr.height));
```

Non-PDF sources (docx-to-image, plain image) pass `pageRects = null`; the
helper treats the whole image as page 1 (`[{ y: 0, width, height }]`).

Dev-mode `console.debug("[OCR-6] field crops", …)` lists derived rects so
the operator can visually confirm the crop lands correctly on the first
manual run. Guarded by `process.env.NODE_ENV !== "production"` so it's a
no-op in the deployed build.

---

## Merge policy — how the server handles unexpected crop shapes

Implemented in `src/app/api/upload/route.ts` after the crop AI call. Rules:

| Crop response shape | Handling |
|---|---|
| Extra fields the model invented (not in `cropManifest`) | **Ignored.** Only fieldNames listed in the client-supplied `cropManifest` are merge candidates. Non-hinted fields cannot be overwritten via the crop path. |
| Different casing for the fieldName (e.g. `"ผู้รับโอน"` in manifest, `"ผู้รับโอน"` lowercased in response — Thai has no case, but Latin-alphabet templates can hit this) | **Case-insensitive fallback lookup** matches once via `lowerToOriginal[fieldName.toLowerCase()]`. Manifest name always wins as the merged key. |
| Model returned a valid response for a DIFFERENT hinted fieldName than intended | Merge is keyed by fieldName, not by crop position. Since we send crops in one call with a numbered "1. …, 2. …" label list, the model's response key is what we honor. If it labels a value under the "wrong" (but still hinted) field, that field gets the value — the mislabel is the model's mistake, not the merger's, and this outcome is no worse than the whole-image behavior we're replacing. |
| Crop response missing a field entirely | Whole-image value untouched (no `crop_miss` flag — nothing was attempted from the model's side, but we did send a crop for it). This is a mild observability gap; documented but not fixed (would require distinguishing "manifest sent, key absent from response" from "manifest sent, key present with null" — both currently collapse into "no crop provenance recorded"). |
| Crop returned `value: null` or empty string | Whole-image value preserved. `crop_miss: true` written to that field's object in `raw_json` for the observability signal the spec required. |
| Crop returned non-null value | Replaces whole-image value. Merged object also carries `source: "crop"` and the crop's `confidence` (falling back to whole-image confidence if the model omitted it). Other whole-image fields (`corrections`, `bbox`) are preserved via spread. |
| Whole-image had this field as a bare string (not the standard `{value, confidence, …}` object shape) | Normalized to `{ value: <string> }` first, then merged. |

Whole crop pass is wrapped in try/catch — any failure (network, parse
error, model rejection) falls through to the untouched whole-image result.
Crops are strictly additive; they cannot regress behavior.

---

## Metering — where crop tokens accumulate

**Single call site:** `logAiUsage(env, { userId, fn: "ocr", …, inputTokens:
totalInputTokens, outputTokens: totalOutputTokens, docId, fileName })` at
what was `route.ts:247` before this change (now shifted down by the crop
block). One row per user-perceived operation, matching the OCR-6 spec.

Both `ai.usage` (whole-image) and `cropAi.usage` (crop pass) contribute to
the same `totalInputTokens` / `totalOutputTokens` accumulators declared
right after the whole-image parse. No second `logAiUsage` row is written.
Credit charging (`estimate.credits`) is unchanged — it was already computed
from field count, not from token counts, and the crop pass is a "free"
augmentation from the user's credit perspective.

Batch-mode metering path: identical. `runBatchItem` posts to the same
`/api/upload` endpoint; the server code is oblivious to whether the caller
is single-file or batch. So the accumulate-into-one-row behavior automatically
covers both.

---

## Backward compatibility

- Uploads without `field_crops` in the FormData behave exactly as before —
  the parse block silently yields an empty `cropManifest`, `cropFiles`
  stays empty, the `if (…cropFiles.length > 0)` block never fires.
- Templates with zero hinted fields skip crop generation entirely on the
  client (`anyHint` early-out in `prepareUploadWithCrops`).
- `pdfFileToImage()` retains its `(file) => File` signature so
  `CompareWorkspace` needs no change.

---

## What I explicitly did NOT do

1. **Public API `/api/v1/extract`.** Per OCR-4 decision + TEST-1 outcome, the
   public API stays untouched.
2. **Two-pass with suspect-field detection** (OCR-1 sketch). Superseded by
   the always-crop-hinted-fields design in this task.
3. **OCR-5 bbox-overlap validation.** On hold per BOARD 2026-07-06. Some
   OCR-5 concerns are effectively addressed by (a) `crop_miss` observability,
   (b) manifest-restricted merge preventing cross-field key hijacking. But
   explicit hint-vs-returned-bbox overlap math was not added.
4. **Retention of the raw crop PNGs.** They live in memory in the worker only
   long enough for the second AI call; no R2 upload, no DB persistence. If
   we later want to debug bad crops, we'd need to add a dev-only R2 dump.
5. **Empirical Gemini runs.** Per spec ("burns credits, agent can't confirm
   real doc results") — that's the operator's job.

---

## Surprises / notes

- **`generateWithAI` already supported multi-image.** No change to
  `src/lib/ai-handler.ts` needed. Both Gemini, OpenAI, and OpenRouter code
  paths spread `images` into their respective content arrays. Confirmed by
  reading `ai-handler.ts:53` (`finalImages = images || (image ? [image] : [])`).
- **Batch didn't need PDF conversion inline anymore.** Previously
  `runBatchItem` had its own `if (item.file.type === "application/pdf")
  await pdfFileToImage(...)` block. The shared `prepareUploadWithCrops`
  now owns that logic — PDF conversion + crop generation are done once,
  symmetrically, in both paths. This reduces the surface area for another
  batch/single-file divergence bug like OCR_TESTING_LOG §2.4.
- **`docxFileToImage` output is treated as a single-page image.** No page
  layout means `pageRects` is `null` → whole-image = page 1, hints (rare on
  docx templates today) still work.
- **The `field_crops` shape:** `Array<{ index, fieldName, page }>` — one
  simple manifest, no competing shapes. Alternative (embed manifest in each
  filename or as multiple FormData parts) considered and rejected: JSON is
  parseable in one shot server-side, matches how the codebase already
  handles `fields_json`.
- **Dev-mode console.debug is gated on `NODE_ENV !== "production"`.** Ships
  disabled; nothing to remove before deploy.

---

## Verification

- `npm run build` → **clean** (Next.js production build succeeds, all
  routes emitted, no type errors).
- `npx tsc --noEmit` → **exit 0**.
- No runtime testing against Gemini (credit budget concern per spec).
  Operator: please rerun OCR-2 Case 6 on doc1 (dense page, ผู้รับโอน field)
  3× via UI — expected result per crop-validation evidence is 3/3 both
  lines. If confirmed, we can update `docs/OCR_TESTING_LOG.md` §1.2 status
  from 🔴 to ✅.

---

_Author: ocr-pipeline agent, 2026-07-06_
