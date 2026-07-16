# UI-7 UAT r5 — OCR single-file P0 fixes (2026-07-15)

**Scope**: 4 P0 items from 2026-07-15 UAT against `34f5dc3e`. All touch the
single-file path of `src/components/OCRWorkspaceV2.tsx`. Batch view
(`OCRBatchViewV2.tsx`) untouched — under separate UAT thread. v1
`OCRWorkspace.tsx` md5 verified unchanged (`4ae60c50a0fe59a57d994350c2cd44d5`).

Verify:
- `npx tsc --noEmit` → exit 0 (clean)
- `npm run build` → clean (all routes prerender / build without error)
- v1 md5 unchanged

---

## #1 — Fulldoc "Object" bug + missing JSON tab — FIXED

### Root cause
API-4 shipped the canonical `{pages: [{page, text}]}` response shape, but the
v2 fulldoc synthesis (`runExtract` at old L695-703) predated that ship and
still walked `Object.values(s.data)` with a naive `typeof v === "object" &&
"value" in v` branch. When the server returned the new shape, the top-level
`pages` key was an array → typeof "object" → no `"value"` key → fell through
to `String(v)` → literal `"[object Object]"` rendered in the results panel.

### Fix
`runExtract` fulldoc branch now:
1. Prefers `s.data.pages` when it is an array of `{page, text}` objects
   (the API-4 canonical shape) and maps it directly.
2. Falls back to synthesis for older shapes — but the fallback now skips
   nested objects/arrays entirely (no more `[object Object]` leakage).
3. Stashes the raw response on `fulldocResult.raw` for the JSON tab.

`fulldocResult` type extended to `{ pages, raw? }`. `setResult(raw)` NOT
used — that would leak fulldoc data into field-mode overlay/entry paths.

### JSON tab
Added a Text / JSON segmented tab bar to the fulldoc results view (matches
field-mode tab-bar style pixel-for-pixel). JSON tab reuses the
`renderJsonTab()` pattern: pretty-printed `<pre>`, Copy + Download buttons
(download name = `OCR_fulldoc_<ts>.json`).

i18n: added `ocr.v2.results.fulldocTabText` / `fulldocTabJson` (th + en).

---

## #4 — Excel / CSV preview broken in v2 — FIXED (xlsx/xls; CSV = red flag)

### Root cause
v2 `processFile` had no `isExcelFile` branch — it fell through to the generic
`URL.createObjectURL(f)` path, which produced a blob URL for the raw file
bytes that neither `<img>` nor the PDF raster path could render.

### Fix
- Imported `ExcelPreview` + `isExcelFile` (parity with v1 line 23 / 483).
- `processFile`: when `isExcelFile(f)` is true, skip PDF raster + preview URL
  generation entirely, mirroring v1's `if (isExcelFile(f)) { setPreviews([]); return; }` early-return.
- `renderPreview`: new early branch — when the loaded file is Excel, render
  `<ExcelPreview file={file} />` inside a scrollable container (no pan/zoom
  wrapper because Excel has its own scroll surface, matching v1 L1876).
- File input `accept` attribute already lists `.xlsx,.xls` — unchanged.

### Red flag — CSV
`isExcelFile` (from `src/lib/excel-parser.ts` L104) checks
`/\.(xlsx|xls|xlsm)$/i` — **CSV is NOT included**. `parseExcel` uses
`xlsx.read(buf)` which does auto-detect CSV, so the underlying parser
probably handles it, but the file-type gate rejects it. To add CSV in v2
without a follow-up in `excel-parser.ts`, we'd need a local check
(`/\.csv$/i.test(f.name) || f.type === "text/csv"`). Left as-is for this
round to keep v1/v2 parity — task ambiguous on CSV scope; original UAT
report said "worked in v1" and v1 does not preview CSV either.
Recommend a separate ticket to extend `isExcelFile` if CSV preview is
genuinely wanted.

---

## #5 — Quick toggle missing in single-file topbar — FIXED

### Root cause
`QuickModeToggle` was only rendered in the batch mode branch (via
`headerRight` prop passed to `OCRBatchViewV2`). Single-file mode never
mounted it.

### Fix
`renderStepper()` right-aligned toolbar now renders
`<QuickModeToggle>` *before* `<ModeSwitch>`. Same `quickMode` /
`setQuickMode` state (backed by `localStorage.ocr_v2_quick_mode`) so toggle
state syncs across single ↔ batch mode without a page reload.

No behavior change to the Quick auto-run pipeline (`quickFiredRef` guard,
`requestExtract(false)` after 0ms). This is a pure visibility fix.

---

## #6 — Highlight misalignment — INSTRUMENTED + partial normalization; ROOT-CAUSE OPEN

### Investigation

Checked all four hypotheses:

| # | Hypothesis | Verdict |
|---|---|---|
| a | `usePanZoom` transform decouples overlay from image | **Ruled out.** Overlay `<div>` and `<img>` are siblings inside the same zoom wrapper (`width: 100*zoom%`) — coord contract intact per OCR-6c invariant (lines 1104-1180). |
| b | Dual-scale (OCR-8b) 7200px vs 3600px coord mismatch | **Plausible.** If server returns bbox in absolute pixels of the hi-res crop pass, `{x, y, width, height}` values would land in [0, 7200] range while overlay maths assumes [0, 1] fractions → percentage math would explode to 720,000% or land at absurd offsets. Naive check by `bx > 1` heuristic added. |
| c | Some entries have no bbox → no overlay | **Confirmed by code path.** `resultEntries.filter/map` returns early when `!e.bbox`. If backend crop pass returns `null` bbox for some fields (crop_miss / crop_no_match cases), the overlay for those fields is silently omitted. This IS the "no highlight" case reported. Not a bug per se — no coords, nothing to draw — but the UI has zero signal that the field was returned without coords. |
| d | Rotation / landscape flip | **Not investigated deeply.** OCR-6c should have covered this; would need a specific landscape fixture to reproduce. |

### Partial fix landed

Added bbox normalization at overlay render:
- Accepts both `{x, y, width, height}` and `{x0, y0, x1, y1}` (corner form
  seen in some crop responses).
- If any coord `> 1` → treat as absolute pixels referencing
  `DEFAULT_TARGET_LONG_EDGE` (3600px standard raster) and divide. This
  handles the standard-DPI pixel case but **NOT** the 7200px hi-res case
  cleanly — a hi-res bbox will divide to ~2× fractions → overlay clipped
  off-screen or 2× oversized. Log emits a `[HIGHLIGHT_DEBUG]` warning when
  triggered.
- Zero-width / zero-height bboxes logged as `console.warn`.
- Debug logger: set `window.__OCR_HIGHLIGHT_DEBUG__ = true` in devtools to
  see every overlay's raw + normalized bbox on render.

### Red flags — must-follow-up

1. **Root cause of hi-res coord references is server-side.** The API layer
   (`src/app/api/upload/route.ts` + Gemini prompt in `src/lib/ai-*`) needs
   to normalize any bbox to page-fraction [0,1] regardless of which crop
   pass (lo / hi) produced it. Recommend the ocr-pipeline agent audit the
   response construction path for `_crop_dpi > 1` records. Client-side
   normalization is a band-aid — it can't disambiguate "1200px in a 3600px
   raster" from "1200px in a 7200px raster" without more metadata.
2. **`crop_miss` / `crop_no_match` records need a visible affordance**
   ("no position returned — click to hint"). Right now the value shows
   with a "⚠ crop miss" chip but the preview has no marker at all,
   making it look like the highlight system is broken for those fields.
3. **Compare workspace has its own highlight pipeline** (per user report
   in original UAT) — untouched this round. Task instructed OCR focus only.

### To reproduce for the server-side follow-up

1. Load a fixture that hits the dual-scale path (any hinted field on a PDF).
2. `window.__OCR_HIGHLIGHT_DEBUG__ = true` in devtools console.
3. Run extract → console prints `[HIGHLIGHT_DEBUG] <field> {raw, normalized, looksPixel, previewPage}`.
4. `looksPixel: true` + `raw.x > 3600` → hi-res coord bug confirmed.
5. `looksPixel: false` + off-screen overlay → coord math bug elsewhere.

---

## Files touched

- `src/components/OCRWorkspaceV2.tsx` (bulk — 6 edits across imports, state, runExtract, renderPreview, renderResultsPanel, renderStepper, overlay render)
- `src/lib/i18n/locales/en.ts` (+2 keys)
- `src/lib/i18n/locales/th.ts` (+2 keys)
- `pm/reports/UI-7-uat-r5.md` (this report)
- `pm/BOARD.md` (UI-7 row appended)

## NOT touched (out of scope)

- `src/components/OCRWorkspace.tsx` (v1, frozen — md5 verified)
- `src/components/OCRBatchViewV2.tsx` (separate UAT thread)
- Any server-side path (highlight root cause needs API-side audit; queued as red flag #1)
