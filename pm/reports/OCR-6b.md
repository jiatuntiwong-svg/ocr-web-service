# OCR-6b — Debug: crop pass not delivering on landscape sibling-labels form

**Status:** 👀 review — deploy-ready pending operator verification against `TR07246900009- กาชาด 11.pdf`.
**Owner:** ocr-pipeline agent
**Sprint:** OCR Stabilization
**Related:** `pm/tasks/ocr-pipeline.md` §OCR-6b, `pm/reports/OCR-6.md`, `pm/reports/API-1.md` §Follow-ups, `docs/OCR_TESTING_LOG.md` §1.2 / §8

---

## Root causes — confirmed vs suspected

### 1. Crop-pass mini-prompt was missing the "verbatim + all-lines + no-borrowing" rules — CONFIRMED

The whole-image prompt (`src/app/api/upload/route.ts:230-256`) carries the entire arsenal that mitigates the three failure modes we observed on this doc:
- Multi-line join with `\n` ("ถ้าค่ากินหลายบรรทัดใต้ label เดียวกัน ... คั่นบรรทัดด้วย \\n").
- No autocorrect / `corrections[]` mandatory ("อ่านทีละตัวอักษร ... ต้องบันทึกใน corrections[]").
- Anti-borrowing / anti-filtering ("ห้ามคัดกรอง ... ห้าม 'คัดกรอง' ค่าให้ตรงกับที่ชื่อหัวข้อสื่อความหมาย").

The OCR-6 crop prompt at `upload/route.ts:292-304` (pre-fix) omitted all three, so the crop pass on this form reproduced exactly the failures the whole-image prompt was designed to prevent — line 3 dropped, `รับบริจาค` silently corrected to `บริการ`, and value blended with the sibling `รหัสสำนักงาน/ศูนย์`'s `ศูนย์บริการโลหิตแห่งชาติ`. The operator's manual crop test succeeded because they uploaded the crop as a *whole-image* run, which still carried the full prompt.

This is the strongest single cause: the failure signature (silent autocorrect + line-count truncation + neighbor blend) matches the exact rules that were absent.

### 2. Merge observability gap — CONFIRMED (documented in OCR-6.md line 80)

When the model's crop response either (a) returned a fieldName with an extra space / NBSP that missed the strict `cropExtracted[fieldName]` lookup or (b) simply omitted the field, the merge fell through with **no marker written to `raw_json`**. From the caller's perspective the whole-image (blended, autocorrected) value was final and looked authoritative. There was no signal that the crop pass had degraded to a no-op — hence the confidence-100 blend that reached the operator.

Fix here is deterministic and cheap; do it first because it means every future incident of this class is diagnosable from `raw_json` alone.

### 3. Rotation / landscape orientation — NOT IMPLICATED (verified by code inspection)

The offending PDF has page 1 landscape, page 2 portrait. I traced the two orientation sources:
- **Preview canvas the user draws on** — `OCRWorkspace.tsx:1650` renders each page through `<iframe src="{split-pdf-blob}#toolbar=0&view=FitH">`. The browser's built-in PDF viewer honors `/Rotate` metadata → landscape pages display landscape.
- **Rasteriser used for the upload PNG** — `pdf-to-image.ts:99-107` renders via `page.getViewport({ scale })` + `page.render(...)`. pdfjs `getViewport({ scale })` defaults `rotation = page.rotate`, i.e. it honors `/Rotate` identically. Rendered canvas is landscape too.

Both sides see the SAME orientation, so a hint drawn against the preview lands in the same region of the rasterised upload. Forcing `rotation: 0` would DESYNC them and cause the exact "confidence 100, wrong region" symptom we were worried about — so the fix is to leave defaults alone and document why (see "Files changed").

### 4. Per-page x normalization — NOT A DEFECT (verified by code inspection)

`src/lib/field-crops.ts:125-128` multiplies `x0 * pr.width` (the *per-page* rendered width), not the stacked canvas's `max(width)`. Landscape page 1 has `pr.width = <landscape px>`, portrait page 2 has `pr.width = <portrait px>` — hints on either resolve into the correct region. The stacked canvas's `max(width)` is only used for canvas allocation, never for hint math. No regression risk from mixed-orientation stacks.

### 5. Crop rect bottom margin — SUFFICIENT (verified)

`CROP_LABEL_MARGIN.bottom = 0.40` (`src/lib/field-crops.ts:37`) expands the hint by 40% of its height downward. A tight one-line hint on a 3-line value would still catch lines 2-3 within the +40% window unless the operator drew the hint even tighter than one text line (in which case the fix is training, not code). The observability logging (see below) will surface this class immediately by showing a value that's short vs the manifest expectation.

---

## Files changed

| Path | Lines | Change |
|---|---|---|
| `src/lib/field-crops.ts` | +33 / -2 | (a) New exported `normalizeFieldNameKey()` — whitespace-collapse + trim + lowercase; shared with server merge so client & server can't drift. (b) `buildFieldCrops()` gains optional `selectedPages` param and calls `remapBboxHintPage()` from `pageSelection.ts` — API-1 follow-up. Dropped hints are skipped silently. |
| `src/lib/pdf-to-image.ts` | +10 comment | Documents the deliberate choice to inherit `/Rotate` from pdfjs default viewport — this matches the browser preview's rotation and desyncing them would silently corrupt hint coordinates. |
| `src/app/api/upload/route.ts` | +58 / -20 | (a) Crop prompt ported the critical rules (verbatim + all-lines + anti-borrowing + `corrections[]`). (b) FieldName matching now uses `normalizeFieldNameKey` for tolerant lookup. (c) Merge observability invariant: every `cropManifest` entry ends up with `source:"crop"` OR `crop_miss:true` OR the new `crop_no_match:true`. (d) Crop `corrections[]` merged into result when non-empty. (e) Dev-only `[OCR-6b] crop merge provenance` console.debug — mirrors the client's `[OCR-6] field crops`. |
| `test_fixtures/regression/landscape-sibling-labels/CASE.md` | new | Case description; PDF NOT committed (PII decision pending). |
| `scripts/ocr-regression/cases/ocr-6b.json` | new | Regression case matching OCR-2 harness format. Inert until fixture PDF lands. |

### Deliberately not touched

- `src/app/api/v1/extract/route.ts` — public API stays hint-free per OCR-4 / TEST-1 discipline.
- Whole-image prompt in `upload/route.ts:230-256` — stable; the crop prompt now mirrors its rules but does not modify the whole-image path.
- Compare pipeline / highlight pipeline — out of scope.
- `pdfFileToImage()` public signature — unchanged, only a comment added.
- `src/lib/ai-handler.ts` — multi-image support already there.
- `OCRWorkspace.tsx` call sites of `buildFieldCrops` — the new `selectedPages` param is optional, so the current call `buildFieldCrops(uploadFile, extractFields, pageRects)` remains valid. When UI-1 lands the workspace can pass the selection through as the 4th arg with no re-plumbing.

---

## Merge observability invariant (the guarantee, in code)

For every entry `m` in `cropManifest`, the merged `extracted[m.fieldName]` object carries exactly one of:

- `source: "crop"` — crop delivered a non-null value (replaces whole-image value; also merges `corrections[]` when the model reported any).
- `crop_miss: true` — crop response contained the key but value was null/empty (whole-image value preserved).
- `crop_no_match: true` — **new** — crop response did NOT contain the key (fieldName normalization couldn't find a match or model dropped it entirely). Previously silent; now visible.

Enforcement code (`src/app/api/upload/route.ts`, inside the crop merge block):

```ts
if (cropVal !== undefined && cropVal !== null && cropVal !== "") {
  extracted[fieldName] = { ...existingObj, value: cropVal, /*confidence, corrections,*/ source: "crop" };
} else if (cropEntry !== undefined) {
  extracted[fieldName] = { ...existingObj, crop_miss: true };
} else {
  extracted[fieldName] = { ...existingObj, crop_no_match: true };
}
```

The three branches are exhaustive over the manifest entry's fate, and each writes a provenance marker into `raw_json`. Combined with the dev-only `[OCR-6b] crop merge provenance` debug log, a bad crop pass now leaves a trail that survives the operator's next incident.

---

## Crop prompt — before/after

**Before** (`upload/route.ts:292-304`, pre-OCR-6b):
```
แต่ละภาพต่อไปนี้คือบริเวณของหัวข้อ ... อ่านค่าของแต่ละหัวข้อ "ทีละตัวอักษร" ... รวม "ทุกบรรทัด" คั่นด้วย \n ... ถ้าไม่พบค่าให้ null
{ "<fieldName>": { "value": ..., "confidence": 0-100 } }
```

**After** — adds the three critical rules from the whole-image prompt:
- "ข้อความทั้งหมดในภาพแต่ละใบคือค่าของหัวข้อนั้น — ห้ามหยิบจากที่อื่น ห้ามคัดกรอง" (kills the sibling-label blend).
- "ห้ามแก้คำเงียบๆ ห้าม autocorrect" + `corrections[]` mandatory (kills the silent `รับบริจาค`→`บริการ` mutation).
- "ทุกบรรทัดที่ปรากฏในภาพ ห้ามข้ามบรรทัดที่ 2 หรือ 3" (line 3 drop).
- Response schema now includes `corrections: []`, mirroring the whole-image contract.

**Deliberately kept OUT** to prevent the mini-prompt from ballooning:
- The `[hint: x=...%]` semantic-fallback rule — irrelevant; the crop IS the region.
- The API-1 page-selection preamble — the crop pass sees per-image labels, no page context.
- `raw_text` vs other-type distinction — the merge decides which field's type matters after the fact.
- The full field descriptor block — the crop's numbered label list already tells the model which key to emit.

---

## Rotation / landscape handling

**What pdfjs does:** `page.getViewport({ scale })` defaults `rotation = page.rotate` and swaps width/height accordingly. A landscape page (with or without `/Rotate 90`) renders in its display orientation. This is the pdfjs default and we do NOT override it.

**What the preview does:** `<iframe src="{split-pdf-blob}#toolbar=0&navpanes=0&view=FitH">` (`OCRWorkspace.tsx:1650`). The browser's built-in PDF viewer honors `/Rotate` — landscape pages display landscape. Same orientation as pdfjs. The bbox_hint the user draws is in display coordinates that match the rasterised upload.

**What the fix does:** Nothing to the raster path — the two are already aligned. A comment was added in `pdf-to-image.ts` explaining WHY we don't force `rotation: 0` (doing so would render the un-rotated bitmap and desync from the preview, silently corrupting all hints on rotated pages).

**How to verify visually if operator wants:** In dev mode, on the offending doc, the client emits `[OCR-6] field crops` (existing) with the pixel rect that was cropped, and the server emits `[OCR-6b] crop merge provenance` (new) with the model's outcome. If the crop rect looks correct on-screen but the merge says `crop_no_match` or the value is blended, that's a prompt / model issue, not a rotation issue. If the crop rect is visibly in the wrong region (open the crop PNG from devtools' Network tab — server receives it as `crop_<idx>`), that would be a rotation regression.

---

## Per-page x-scale — verified correct, no change needed

`src/lib/field-crops.ts:125` multiplies `x0 * pr.width` (per-page width from `pageRects[pageIdx]`), NOT the stacked canvas's `max(width)`. Landscape page 1 (wider) uses its own width; portrait page 2 (narrower) uses its own. Hints on either page resolve into the correct region regardless of mixed orientations. This is what the OCR-6 code shipped; OCR-6b did not need to change it. Called out here because the spec explicitly flagged it as a possible defect.

---

## API-1 follow-up status — DONE

`buildFieldCrops()` now accepts an optional `selectedPages: number[] | null` parameter and calls `remapBboxHintPage(originalPage, selectedPages)` from `src/lib/pageSelection.ts`. When no selection is passed (current OCRWorkspace behavior) `remapBboxHintPage` returns `originalPage` unchanged — full backward compatibility, no behavior drift for the OCR-6-verified path. When UI-1 lands the workspace can pass `selectedPages` as the 4th argument with zero further code changes to this helper.

Hints whose original page number is NOT in the selection are silently dropped from the crop pass — matches the design in API-1 report §Follow-ups (there's nothing to crop; the page wasn't rendered).

Not deferred, not skipped. Doing it while I was in `field-crops.ts` was cheaper than a second visit.

---

## Regression fixture

Files added:
- `test_fixtures/regression/landscape-sibling-labels/CASE.md` — case description, expected value, expected fields, why it exists, sibling-label attention-blend risk.
- `scripts/ocr-regression/cases/ocr-6b.json` — automated case matching OCR-2 harness format. Includes `provenanceExpected: "crop"` so the harness can assert the observability marker as a first-class regression signal (a `crop_no_match` outcome is a regression even if the value happens to look right).

**PDF commit decision — FLAGGED FOR OPERATOR.** The source PDF (`TR07246900009- กาชาด 11.pdf`) contains staff names and identifying information. Per the TEST-1 PII policy (BOARD 2026-07-06: `test_fixtures/` is gitignored), the file is NOT committed. Operator must decide:
1. **Redact and commit** — sanitize staff names, keep original layout / rotation / crops intact so the case still exercises the code path. Preferred if we want CI enforcement.
2. **R2 fixtures prefix** — store the raw PDF in R2 under a `fixtures/` prefix; harness fetches at run time. Cleaner separation of data from code but requires harness plumbing.
3. **Local only** — keep on the operator's machine; regression is manual until the source can be redacted. Fastest; blocks CI enforcement.

The regression case JSON is designed to skip (not fail) when the fixture PDF is absent, so committing this change is safe regardless of the decision.

---

## Not touched (compliance list)

- `/api/v1/extract` — public API stays hint-free (OCR-4 discipline).
- Compare pipeline — out of scope.
- Whole-image prompt — unchanged; the crop prompt now mirrors its rules but the whole-image path is byte-identical.
- `pdfFileToImage()` public signature — unchanged; only comment added.
- OCR-5 explicit bbox-overlap validation — still deferred (BOARD 2026-07-06). The observability invariant added here means an OCR-5-style guardrail is even less urgent, because a bad crop merge is no longer silent.

---

## Red flags — code I suspect but could not confirm without a real run

1. **Model may still emit the fieldName with subtle Unicode-normal-form differences** (NFC vs NFD Thai). `normalizeFieldNameKey` doesn't Unicode-normalize. If operator sees `crop_no_match` on a value that clearly should match, the next fix is `String.prototype.normalize("NFC")` inside the helper. Cheap follow-up.

2. **Crop confidence 100 with a bad value** — if the model returns a confident wrong answer under the ported prompt (i.e. still borrows from a sibling despite "ห้ามหยิบจากที่อื่น"), the merge will accept it (`source: "crop"`) and the OCR-6b observability guarantee only tells you the crop merged, not that it was right. The next lever there is bbox-overlap validation (OCR-5, on hold) or a self-consistency vote — both out of scope for this fix.

3. **The `<iframe>` PDF viewer's `#view=FitH` mode** — I confirmed that /Rotate is honored, but the viewer's fit / zoom transform is not what the hint is stored against (the hint is 0-1 fraction of the wrapper rect). If the user zooms or scrolls before drawing, the wrapper still measures the visible viewport in browser pixels — I did not trace this end-to-end. If future incidents show a coordinate-drift signature (crop lands in the right general area but a fixed pixel offset off), this is where I'd look first.

---

## Verification

- `npx tsc --noEmit` → **exit 0**.
- `npm run build` → **clean** (all 42 routes emit).
- No empirical Gemini runs (per spec — burns credits, cannot substitute for the operator's real-doc verification).

**Operator verification step:**
1. On the offending doc (`TR07246900009- กาชาด 11.pdf`), rerun with template that has bbox_hint on `ชื่อและรหัสศูนย์รับผิดชอบ`. Expect ≥ 2/3 runs to return all 3 lines with correct spelling. In dev, `[OCR-6b] crop merge provenance` in the server console will show `outcomes: [{ field: "ชื่อและรหัสศูนย์รับผิดชอบ", outcome: "crop" }]` on a good run.
2. Regression: on doc1 (dense `ใบจ่ายวัสดุ`), rerun OCR-2 Case 6 three times. Expect 3/3 to still return both lines of `ผู้รับโอน` (no regression from OCR-6 baseline).
3. Optional: on ANY multi-hint upload, confirm every hinted field in `raw_json` now carries one of `source:"crop"` / `crop_miss:true` / `crop_no_match:true`. If any hinted field lacks all three markers, the observability invariant is broken — file back as OCR-6c.

---

_Author: ocr-pipeline agent, 2026-07-07_
