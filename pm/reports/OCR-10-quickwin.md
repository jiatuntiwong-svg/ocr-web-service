# OCR-10 Phase 1 quick win + UI-7 table renderer

**Date:** 2026-07-15
**Base deploy:** `845e6aa4`
**Agent:** frontend-ui
**Scope:** two items in one shot (same file, must serialize):
  A. OCR highlight validation via Compare's text-layer pipeline (OCR-10 Phase 1)
  B. Table-type field renderer in Fields tab (UI-7 UAT r3 follow-up)

**Files touched**
- `src/lib/featureFlags.ts` — added `ENABLE_OCR_HIGHLIGHT_VALIDATION = true`
- `src/lib/i18n/locales/en.ts` — added `ocr.v2.results.emptyTable = "Empty table"`
- `src/lib/i18n/locales/th.ts` — added `ocr.v2.results.emptyTable = "ตาราง (0 rows)"`
- `src/components/OCRWorkspaceV2.tsx` — validation effect + overlay wire-up + table renderer
- `pm/BOARD.md` — OCR-10 → 🔨 in progress (Phase 1), UI-7 note appended

**v1 md5 (unchanged, verified):** `4ae60c50a0fe59a57d994350c2cd44d5` — `src/components/OCRWorkspace.tsx`

**Build / typecheck**
- `npx tsc --noEmit` → exit 0
- `npm run build` → clean

**Not deployed.** Awaiting PM approval.

---

## Item A — Highlight quick win (OCR-10 Phase 1)

### Root cause recap
Per UAT r6 report + PM analysis: the OCR overlay trusts AI-supplied bbox
verbatim (with r5+r6 sanity guards catching only degenerate/out-of-bounds
cases). Compare's highlight pipeline solves the same problem by **validating**
the AI hint against the PDF's real text layer and using the text-run's actual
bbox when a match is found. Phase 1 = reuse that pipeline on the OCR side for
text-based PDFs.

### Validation flow

Inside `OCRWorkspaceV2`, a new `useEffect` runs whenever `(result, file,
resultEntries)` changes:

1. Guard: flag off, no result, or file not a PDF → clear map, exit.
2. For each `resultEntries[i]`:
   - `fieldType === "table"` → skip (whole-table needles never match a single
     text run; already skipped by r6 overlay guard).
   - Empty / null / complex (`isComplex`) value → skip (no needle to search
     for).
   - Page = `bbox.page` if present, else `previewPage + 1`.
   - `getPageTextLayer(file, page)` from `src/lib/highlight-pipeline/textLayer.ts`
     — client-side pdfjs extraction; returns `null` for scan PDFs (no text
     layer).
   - `findInTextLayer(layer, needle, hint?)` from
     `src/lib/highlight-pipeline/search.ts` — `hint` = the AI bbox after
     `evaluateHighlight()` sanity-guard normalization, so the hint is always
     a safe 0..1 fraction (or omitted). `findInTextLayer` disambiguates
     multiple hits by picking the one closest to `hint`.
3. Store validated `{x, y, width, height, page}` per field key in
   `validatedBboxByKey` state.

At overlay render time (`renderPreview()`), each entry's bbox source is:

```
validated (text-layer hit)   →  use validated bbox     (matched)
no validated hit             →  evaluateHighlight(AI)  (existing r6 path)
```

### Fallback matrix

| Situation | Bbox used | Telemetry reason |
|---|---|---|
| Flag OFF | AI bbox (r6 path) | `flag-off` (logged once when result present) |
| Text-based PDF, exact/fuzzy hit | **Text-layer bbox** | `matched` |
| Text-based PDF, no hit for needle | AI bbox (r6 path) | `no-match` |
| Scan PDF / image (no text layer) | AI bbox (r6 path) | `no-layer` |
| Table-type field | AI bbox skipped by r6 anyway | `table-skip` |
| Non-PDF (image, docx-rendered) | AI bbox (r6 path) | — (effect returns early) |
| Empty / complex value | AI bbox (r6 path) | — (skipped in loop) |

### Telemetry

`window.__OCR_HIGHLIGHT_DEBUG__ = true` in the browser console enables
`[HIGHLIGHT_VALIDATION]` logs — same debug flag Compare uses, same envelope
as the existing `[HIGHLIGHT_SKIP]` / `[HIGHLIGHT_DEBUG]` logs. Fields:
`{ reason, page, needle?, kind?, bbox? }`.

### Constraints honoured
- **No new dependencies** — reuses `getPageTextLayer` + `findInTextLayer` (already in bundle for Compare workspace).
- **Client-side only** — text-layer extraction is pdfjs client-side; no route or backend touched.
- **BC** — flag OFF is byte-identical r6 behaviour (verified by inspecting the render branch: validated map stays empty, `validated = undefined`, code falls through to `evaluateHighlight(e.bbox, e.fieldType).b` — the exact expression r6 had).
- **Overlay layer positioning untouched** — only the bbox *source* changes; the render code that projects `{x,y,width,height}` into %/pixel space is unchanged.

### Rollback
Flip `ENABLE_OCR_HIGHLIGHT_VALIDATION = false` in `src/lib/featureFlags.ts`, 1 deploy (~5 min).

---

## Item B — Table field renderer

### Bug (r6)
Table-type fields (e.g. line-items) shipped as pretty JSON blob with
`isComplex = true`, edit input disabled. Operator wanted the **v1
experience**: an actual `<table>` with headers pulled from the first row's
keys and one `<tr>` per element.

### Before → after

**Before (r6)** — inside the Fields-tab card, single `<div>` for value:

```
{
  "quantity": 2,
  "description": "Widget",
  "price": 100
},
{
  "quantity": 5,
  ...
```

Rendered as multi-line monospace JSON, `<input>` disabled with
`editComplexPlaceholder` inside.

**After (this round)** — inside the same card, when
`fieldType === "table"` and `raw.value` (or `raw` fallback) is an array:

```
┌──────────┬──────────────┬───────┐
│ QUANTITY │ DESCRIPTION  │ PRICE │
├──────────┼──────────────┼───────┤
│    2     │ Widget       │  100  │
│    5     │ Gadget       │   50  │
└──────────┴──────────────┴───────┘
```

`<table>` with `borderCollapse: collapse`, uppercase 10.5px header row on
`--color-bg-elevated`, 12px cell rows with `--color-border` row separators.
Container `overflow: auto` + `maxHeight: 280` so wide/tall tables scroll
inside the field card instead of pushing the layout.

Empty array → `t("ocr.v2.results.emptyTable")` italic placeholder:
`"ตาราง (0 rows)"` / `"Empty table"`.

Non-array table value (defensive — e.g. AI returned an object) → falls back
to the existing JSON display (unchanged from r6).

### What stays from r6
- **Drawer inspector** (right-side, `expandedFieldName === e.key`) — still
  shows pretty JSON of `e.raw`. Technical view is unchanged.
- **Inline edit input** — still `disabled` with `editComplexNote`. Cell-edit
  is deferred to a future round (would need round-trip JSON reconstruction
  from cell-level state).
- **Highlight skip** — table-type still returns `table-type-skip` from
  `evaluateHighlight`; no overlay drawn (matches r6 decision).

### Cell coercion
- `null` / `undefined` → `""` (empty cell, no literal "null" text).
- Nested object cell value → `JSON.stringify(row[h])` inline (rare edge case
  — Gemini sometimes emits `{amount, currency}` for money cells; better than
  `"[object Object]"`).
- Primitive → `String(row[h])`.

---

## Verify — mental walkthrough

1. **Text-based PDF, field value "PO-2026-0042":**
   - `getPageTextLayer` succeeds, `findInTextLayer` finds run → validated
     bbox stored → overlay renders on the exact text run. Telemetry:
     `[HIGHLIGHT_VALIDATION] PO { reason: "matched", kind: "exact" }`.

2. **Image-only PDF, same field:**
   - `getPageTextLayer` returns `null` → validated map stays empty → overlay
     uses `evaluateHighlight(e.bbox, ...)` (r6 path with sanity guards).
     Telemetry: `{ reason: "no-layer" }`.

3. **Text-based PDF, field value "999999999" but PDF doesn't contain it
   (AI hallucination):**
   - Text layer exists but `findInTextLayer` returns `null` → validated map
     unchanged → overlay uses AI bbox (r6 path). Telemetry:
     `{ reason: "no-match" }`.

4. **Table field:**
   - Validation loop skips (`table-skip` logged). Overlay skips (r6
     `table-type-skip`). Fields tab now shows `<table>` with headers
     instead of pretty JSON.

5. **Empty table (`[]`):**
   - Fields tab renders `"ตาราง (0 rows)"` / `"Empty table"` italic
     placeholder in the value slot.

6. **Flag OFF:**
   - Effect early-returns; validated map stays empty; overlay path
     byte-identical to r6. Telemetry: `{ reason: "flag-off" }` (single log).

---

## Follow-ups (Phase 2 — still under OCR-10)

Server-side coord audit remains open. Client-side validation removes the
symptom for text-based PDFs but the AI bbox is still trusted for scan PDFs
and for fields where the value doesn't literally appear in the text layer
(e.g. computed sums, reformatted dates). Server-side fix (canonical coord
space + consistent fraction emission) still owed by ocr-pipeline agent.

## Session notes
- No new dependencies added.
- v1 `OCRWorkspace.tsx` byte-identical (md5 confirmed pre- and post-edit).
- All UI strings routed through `t()` under `ocr.v2.*` namespace.
