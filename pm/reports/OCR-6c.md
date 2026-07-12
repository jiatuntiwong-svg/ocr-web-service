# OCR-6c — Hint coordinate space broken on landscape/letterboxed preview

**Status:** 👀 review — deploy-ready pending operator verification on `TR07246900009- กาชาด 11.pdf`.
**Owner:** ocr-pipeline agent
**Sprint:** OCR Stabilization
**Related:** `pm/tasks/ocr-pipeline.md` §OCR-6c, `pm/reports/OCR-6b.md` Red Flag #3, `pm/reports/API-1.md` §Follow-ups

---

## Fix option chosen — Option 1 (one coordinate space, end-to-end)

Preview is now the same pdfjs raster the crop path already used. Reasons for choosing option 1 over 2:

- The raster is produced by `pdfFileToImageDetailed()` — the exact function OCR-6 shipped for the upload path. Reusing it for preview means preview pixels == upload pixels == crop pixels. Letterbox math becomes unrepresentable, not "handled".
- Option 2 (aspect-fit math on the iframe wrapper) would leave two coordinate spaces (preview iframe vs pdfjs upload) that must be kept in sync per orientation, per zoom, per scroll. The class of bug we're fixing is precisely the divergence of two such surfaces — the same class OCR-6b Red Flag #3 flagged as still-unaudited. Option 1 removes it forever.
- The pdfjs raster is produced anyway at upload time. Moving it to file-select relocates a wait the user already accepts. Net cost is zero on the happy path (the cached raster is reused at upload; the pdf-lib blob split we replaced was work no other path used).
- Existing preview overlay math (`left: ${x*100}%`) needs zero change — because the wrapper now IS the rendered page rect, wrapper fractions are already page-space.

Hybrid element: I did NOT hoist the raster into a persistent shared store. It's kept in workspace state (`pdfRaster`) keyed by source File identity. Batch items pass a different File per row → they still go through `prepareUploadWithCrops` and rasterise per item (symmetric behavior maintained; batch never diverges from single-file).

---

## Files changed

| Path | Lines (approx) | Change |
|---|---|---|
| `src/lib/pdf-to-image.ts` | +15 | `PdfRasterResult` gains `pagePngs: Blob[]`. `pdfFileToImageDetailed` calls `canvas.toBlob` once per page canvas before disposal. Same pixels as the stacked upload PNG — sliced at rendering time, not re-rendered. |
| `src/components/OCRWorkspace.tsx` | +90 / -50 | (a) `pdfRaster` state caches the raster produced on file select. (b) `processFile` PDF branch replaces pdf-lib blob split → `pdfFileToImageDetailed`; per-page PNG blob URLs become `previews[]`. (c) Landscape-hint migration policy applied on file load (see below). (d) `prepareUploadWithCrops` reuses cached raster when the source File matches. (e) Preview JSX: iframe branch removed; PDFs render through the `<img>` branch that also serves images/docx, with `aspectRatio` computed from `pageRects[i]`. (f) `commitHintDraw` dev-only `[OCR-6c] hint draw` observability log. (g) `resetWorkspace` revokes blob URLs and clears the raster cache. (h) Removed unused `pdf-lib` import. |
| `src/lib/i18n/locales/en.ts` | +1 | `ocr.landscapeHintsInvalidated` copy. |
| `src/lib/i18n/locales/th.ts` | +1 | Thai copy for landscape-hint invalidation. |
| `pm/BOARD.md` | 1 row | OCR-6c → review with verification checklist. |
| `docs/OCR_TESTING_LOG.md` | +new §10 | Documents root cause + fix + operator verification. |

### Deliberately not touched

- `src/lib/field-crops.ts` — OCR-6b already delivered the API-1 follow-up (`selectedPages` param + `remapBboxHintPage` + `normalizeFieldNameKey`). Confirmed in place at lines 110-198; no additional work needed here. See "API-1 follow-up status" below.
- `src/app/api/upload/route.ts` — server-side crop prompt + merge invariant from OCR-6b are correct and unaffected by this fix. Coordinate-space bugs live entirely on the client.
- `src/app/api/v1/extract/route.ts` — public API hint-free per OCR-4 discipline.
- Whole-image prompt / compare pipeline / highlight pipeline — out of scope.
- `pdfFileToImage()` legacy signature — still returns only `File`.

---

## Preview architecture — before vs after

**Before (OCR-6 / OCR-6b era):**
1. On file select: `pdf-lib` loaded the PDF, split into per-page single-page PDF blobs, each wrapped in a blob-URL. `previews[i]` = single-page PDF blob URL.
2. Render: `<iframe src={previews[previewPage] + "#view=FitH"}>` inside a wrapper with `aspectRatio: "210 / 297"`. Browser's built-in PDF viewer honored `/Rotate`, so landscape pages displayed landscape — INSIDE the fixed-portrait wrapper → letterbox.
3. Hint overlay measured mouse `x, y` fractions against the wrapper `getBoundingClientRect()`. On a portrait page these fractions coincidentally matched page-space (wrapper aspect ≈ page aspect). On a landscape page, wrapper-space fractions ≠ page-space fractions.
4. On upload: `prepareUploadWithCrops` called `pdfFileToImageDetailed` (independently, ignoring the pdf-lib output) to produce the stacked PNG for the model. `field-crops.ts` interpreted the wrapper-space hint as page-space of THIS raster → crop lands in an empty margin on landscape pages.

**After (OCR-6c):**
1. On file select: `pdfFileToImageDetailed(f)` runs. Returns `{ file (stacked PNG), pageRects[], pagePngs[] }`. `previews[i] = URL.createObjectURL(pagePngs[i])`. The full result is cached in `pdfRaster` state keyed by source File identity.
2. Render: `<img src={previews[previewPage]}>` inside a wrapper whose `aspectRatio` is set from `pageRects[previewPage].width / pageRects[previewPage].height`. Landscape pages render landscape at their true aspect. No letterbox is possible.
3. Hint overlay: same mouse-fraction math (unchanged). The wrapper rect IS the rendered page rect, so fractions are page-space by construction.
4. On upload: `prepareUploadWithCrops` reuses the cached raster (`pdfRaster.result.file` + `pageRects`). No second rasterisation. Crop path reads the same pixels the user drew on.

Paging UX preserved (prev/next buttons, page count, per-page zoom) — the state model didn't change, only the pixel source did.

---

## Migration policy — existing hints

**Chosen:** invalidate hints on landscape pages ONLY. Portrait-page hints stay valid.

**Rationale:** Portrait single-page PDFs matched the wrapper aspect ratio closely enough that saved hints have been in effectively-page-space all along (small distortion, cropped-out by CROP_LABEL_MARGIN's +15%/+40% padding). Landscape hints were the coordinate-space failure mode by definition — they were already broken and the user has no reason to trust them.

**Code — `src/components/OCRWorkspace.tsx` inside `processFile`:**
```ts
const landscapePages = new Set(
    detailed.pageRects
        .map((pr, i) => (pr.width > pr.height ? i + 1 : -1))
        .filter(p => p > 0),
);
if (landscapePages.size > 0) {
    let invalidated = 0;
    const cleaned = extractFields.map(fld => {
        const h = fld.bbox_hint;
        if (!h) return fld;
        const p = h.page ?? 1;
        if (!landscapePages.has(p)) return fld;
        invalidated++;
        const { bbox_hint: _drop, ...rest } = fld;
        return rest as ExtractField;
    });
    if (invalidated > 0) {
        setExtractFields(cleaned);
        setError(t("ocr.landscapeHintsInvalidated", { count: invalidated }));
        // Persist to active template so the wrapper-space hints don't come back.
        if (activeTemplateId && user) { /* fire-and-forget POST /api/templates */ }
    }
}
```

Condition is strict `pr.width > pr.height` (rendered pixel dims from pdfjs). This is more reliable than the source-PDF page metadata because pdfjs already honors `/Rotate` when producing the viewport — the values we test are the same ones the OLD iframe path would have shown as landscape.

User-facing message: `ocr.landscapeHintsInvalidated: "Cleared {count} old hint(s) on landscape page(s) — please redraw them on the new preview."` (Thai: "ลบตำแหน่ง hint เดิมออก {count} รายการ (อยู่บนหน้าแนวนอน) — โปรดวาดใหม่บน preview ปัจจุบัน"). Delivered via the workspace's existing `setError` banner path (same channel the user already watches).

Portrait hints are not touched — they render on the new `<img>` preview in the correct visual position (this is what "backward compatible" means for the OCR-6-verified doc1 path).

---

## API-1 follow-up status — DONE in OCR-6b, confirmed

`buildFieldCrops()` in `src/lib/field-crops.ts` (lines 110-198) already accepts `selectedPages?: number[] | null` and calls `remapBboxHintPage()` from `src/lib/pageSelection.ts`. Dropped hints (page not in selection) are silently skipped. `normalizeFieldNameKey` is exported and shared with the server merge. Nothing to redo — the OCR-6c task spec's added-scope item was closed by the OCR-6b agent while it was in the same file. Confirmed by reading the current `field-crops.ts`; no delta needed.

---

## Backward compatibility

| Path | Behavior |
|---|---|
| Portrait single-page PDF (OCR-6 doc1 `ใบจ่ายวัสดุ`) | Renders through the new `<img>` branch. Aspect ratio computed from `pageRects[0]` matches the doc's natural aspect. Portrait hints saved in the old wrapper space were near-page-space already; they render at the same visual position on the new preview. Crop path receives the same fractions. **No regression expected.** |
| Landscape/mixed-orientation PDF | Preview no longer letterboxes; hints are true page-space. Old hints on landscape pages get silently invalidated with a user-visible toast. |
| Plain image upload (jpg/png) | Unchanged — `previews = [URL.createObjectURL(f)]`, same `<img>` branch. No aspect-ratio override (browser derives it from the image). |
| .docx | Unchanged — `docxFileToImage` produces a File, same image branch. |
| .xlsx / Excel | Unchanged — `ExcelPreview` component owns its own render surface; the PDF/image branch is skipped. |
| Batch (`runBatchItem`) | Unchanged behavior. Batch calls `prepareUploadWithCrops(item.file)` which rasterises per item — the cache is single-file-scoped so a batch item's File never matches `pdfRaster.sourceFile`. Symmetric with single-file: both consume the same helper. |

---

## Observability

Dev-only console logs (gated on `NODE_ENV !== "production"`):
- `[OCR-6c] hint draw` — on every hint commit, logs `{ fieldId, page, bbox_hint, pageRectPx: { width, height, isLandscape } }`. If a future incident shows a landscape page where `isLandscape` reports `false`, the pdfjs viewport orientation is wrong — that's where to look first.
- Retained from OCR-6/6b: `[OCR-6] field crops` (client-side crop rect + fieldName + page), `[OCR-6b] crop merge provenance` (server-side merge outcome). Together the three logs cover hint → crop → merge in one trail.

---

## Test doc guidance for the operator

Two docs to run through:

**Doc A — the landscape failure case: `TR07246900009- กาชาด 11.pdf`**
1. Load the file. Expect the error/toast banner: "Cleared 1 old hint(s) on landscape page(s) — please redraw them on the new preview." (or Thai equivalent). Screenshot this — confirms migration ran.
2. In DevTools, look for `[OCR-6c] hint draw` when you redraw the hint on `ชื่อและรหัสศูนย์รับผิดชอบ`. Log should show `pageRectPx.isLandscape: true` — proves the pdfjs raster sees the page as landscape and the wrapper is now rendering it that way.
3. The preview page image should visually appear as landscape (wide, no black bars). This is the direct symptom the fix targets.
4. Rerun 3× on the same doc. Accept ≥ 2/3 runs returning all 3 lines with correct spelling AND `raw_json.ชื่อและรหัสศูนย์รับผิดชอบ.source === "crop"`. If `crop_miss` still appears, the coordinate fix is not the whole story and the next lever is crop rect expansion or prompt tuning — file back as OCR-6d.

**Doc B — the portrait regression case: `doc1` dense `ใบจ่ายวัสดุ`**
1. Load. Expect NO invalidation toast — all pages are portrait so hints stay.
2. Preview should look identical to before (the `<img>` render at the doc's natural aspect ≈ the old iframe render).
3. Rerun OCR-2 Case 6 `ผู้รับโอน` 3×. Expect 3/3 with both lines. Any drop = regression, revert immediately.

Optional cross-check: open the crop PNG the server received (DevTools → Network → the `/api/upload` request, form fields `crop_0`, `crop_1`, …). On doc A the crop should now visibly contain the target text; on the pre-fix version it was empty margin.

---

## Verification

- `npx tsc --noEmit` → **exit 0**.
- `npm run build` → **clean** (all routes emit).
- No empirical Gemini calls (per spec — cannot substitute for the operator's real-doc runs).

---

## Red flags — code I touched but couldn't fully verify without a real run

1. **First-file-select latency.** Rasterising the PDF up front is 1-2s per page on modest hardware. Previously the pdf-lib split was near-instant and the raster ran only on upload. Users will now see a small pause between "drop file" and "preview appears". No spinner was added — the existing `converting === "docx"` overlay logic doesn't cover PDFs. If operator flags this as jarring, wire a `converting === "pdf"` overlay on the same code path (small follow-up).

2. **Raster cache invalidation across a page reload.** `pdfRaster` lives in React state — a page refresh drops it, and the next upload will re-rasterise. That's fine (correct behavior) but worth noting if operator sees "the second run of the same file is slower than expected" — it isn't; the first upload was free because the raster was already cached.

3. **Landscape detection is orientation-only, not aspect-strict.** A page that's borderline square (`width === height ± 5%`) will read as portrait and its old hints will survive. Should be fine — near-square pages had ~no letterbox distortion in the old iframe path — but if operator sees a case where an "almost-landscape" page has stale hints that don't line up, we may need to lower the threshold from strict `>` to something like `width > height * 0.95`.

4. **The preview `<img>` uses a blob URL.** Multiple rapid file swaps could leak URLs if `processFile` fires while the previous file is still setting up. `resetWorkspace` and `processFile`'s prelude both revoke; the useCallback deps include `previews`, so stale-closure risk is low but not zero. Watch for gradual memory growth on kiosk sessions.

5. **Zoom + pan wrapping.** The wrapper's `aspectRatio` from `pageRects[i]` is set only on PDFs (falsy on image/docx, which keep intrinsic sizing). At high zoom the wrapper still gets `width: 100 * zoom %`; the aspect-ratio CSS enforces `height` accordingly. Overflow scroll works because the container is `overflow: auto`. I did not empirically verify pan behavior at extreme zoom on landscape pages — logically it should be identical to portrait, but the wide-aspect wrapper could interact with `justifyContent: safe center` differently than the old iframe. If operator sees odd centering, that's the place to look.

---

_Author: ocr-pipeline agent, 2026-07-07_
