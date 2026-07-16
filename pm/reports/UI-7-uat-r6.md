# UI-7 UAT r6 — OCR-workspace v2 (2026-07-15)

**Scope**: 2 P0 bugs surfaced from operator screenshot on live `d24ad358`.
**Target file**: `src/components/OCRWorkspaceV2.tsx` (single-file view only).
**v1 status**: `OCRWorkspace.tsx` md5 `4ae60c50a0fe59a57d994350c2cd44d5` — **unchanged, verified after edits**.
**Verify**: `npx tsc --noEmit` = exit 0 · `npm run build` = clean.
**Deploy**: NOT deployed — awaiting PM approval.

---

## Bug 1 — table-type field displayed as `[object Object],[object Object],...`

### Symptom
Field `ตารางรายการสินค้า` (type: `table`) rendered as literal string `"[object Object],[object Object],[object Object]"` in:
1. Fields tab value area.
2. Bottom "Edit field value" input.

### Root cause
`resultEntries` mapping stringified `v.value` via `String(v.value ?? "")`. When the server returns a table as an array of row objects, `String([{...},{...}])` collapses to the coerced-array form (`"[object Object]"` per row, joined with commas).

### Fix
`OCRWorkspaceV2.tsx` — added `stringifyFieldValue(v)` helper that:
- `null / undefined` → `""`
- `string / number / boolean` → `String(v)`
- everything else (arrays + objects) → `JSON.stringify(v, null, 2)` + `isComplex: true` flag

`resultEntries` now also carries:
- `isComplex: boolean` — value is not a primitive (table row array, nested object).
- `fieldType: string` — resolved from the current `extractFields` list (needed by Bug 2 evaluator too).

Also **tightened the object-shape gate**: only unwrap `.value` when the value looks like a field envelope (`"value" in v || "confidence" in v || "bbox" in v`) AND is not an array — table arrays previously slipped through the naive `typeof === "object"` branch.

### UI affordances
- **Fields tab value cell**: pretty-JSON text keeps `whiteSpace: pre-wrap`, switches to monospace, capped `maxHeight: 280px` with `overflow: auto` when `isComplex` — still readable, doesn't blow up the row height.
- **Edit field value input**: disabled + `opacity: 0.6` + `cursor: not-allowed` for complex values. Shows placeholder `"[complex value — edit via JSON raw tab]"` and a note under the input: `"This field is a table/object — edit it in the JSON raw tab (inline edit is coming in a later version)."` (recommendation (a) from the task brief — round-trip JSON parse is parked to UI-7b).
- **Overflow drawer inspector** (`⋯` per row): already renders `JSON.stringify(e.raw, null, 2)` — unchanged, table rows now show cleanly there too.

### i18n
Added to both `th.ts` and `en.ts` under `ocr.v2.results`:
- `editComplexPlaceholder`
- `editComplexNote`

---

## Bug 2 — highlight still misplaced / missing (partial r5 fix insufficient)

### Symptom
- Pink hint box drawn near top-left of preview, not near the `ตารางรายการสินค้า` region.
- "No highlight at all" case from earlier UAT still reproducible.

### Root cause hypothesis (confirmed red flag from UAT r5)
Server emits bbox coordinates in inconsistent spaces depending on the pass (whole-image vs hi-res crop). Client normalization added in r5 catches the >1 (pixel-space) case but does **not** guard against:
- Table bboxes (Gemini returns geometrically meaningless boxes for tables — often a tiny top-left rectangle).
- NaN / undefined components (silently coerced to 0 → box glued to origin).
- Coords far outside document (>1.5) that shouldn't be drawn at all.

### Fix — centralized guards in `evaluateHighlight(rawBbox, fieldType)`
```
if fieldType === "table"                         → skip "table-type-skip"
if any of {x,y,w,h} not finite                   → skip "degenerate"
if pixel-space (any > 1) → normalize by longEdge
if width <= 0.001 || height <= 0.001             → skip "degenerate"
if x > 1.5 || y > 1.5 || x+w > 1.5 || y+h > 1.5  → skip "out-of-bounds"
else                                             → { b: normalized, skip: null }
```
- Overlay render (~L1204) now calls `evaluateHighlight` — drops the div silently for skips.
- Derived `highlightSkipByKey` Map is computed once from `resultEntries` and drives the Fields-tab affordance.

### Logging
Under `window.__OCR_HIGHLIGHT_DEBUG__ = true`:
- `[HIGHLIGHT_SKIP]` fires once per skipped field with `{ reason, fieldType, raw }`.
- `[HIGHLIGHT_DEBUG]` still fires for rendered overlays with `{ raw, normalized, previewPage }`.

### UI affordance (⌗ glyph)
Fields-tab row now shows `⌗` next to the field key when `highlightSkipByKey.get(key)` is `"degenerate"` or `"out-of-bounds"`. Tooltip: `"ไม่สามารถวาด highlight สำหรับ field นี้ (bbox ผิดปกติ)"` / `"Cannot draw highlight for this field (invalid bbox)"`.
- Suppressed for `"table-type-skip"` — a table field always skips by design, no need to nag the user.

### i18n
Added `ocr.v2.results.highlightSkipTip` in both locales.

---

## Diff summary

| File | Change |
|------|--------|
| `src/components/OCRWorkspaceV2.tsx` | `resultEntries` stringify helper + `isComplex/fieldType` fields; `evaluateHighlight` + `highlightSkipByKey`; overlay map uses helper; Fields-tab row shows `⌗`; inline edit disabled for complex values with note. |
| `src/lib/i18n/locales/th.ts` | +3 keys under `ocr.v2.results`. |
| `src/lib/i18n/locales/en.ts` | +3 keys under `ocr.v2.results`. |
| `pm/BOARD.md` | UI-7 row updated with r6 note; new OCR-10 row (server-side coord audit). |

---

## Mental walkthrough (verify)

1. **Table field** (`ตารางรายการสินค้า`, type: table, value: `[{...}, {...}, {...}]`)
   - Fields tab: value area shows pretty-JSON, mono font, scrollable inside 280px cap.
   - Row header: **no** ⌗ (suppressed for table-type-skip).
   - Edit input at bottom: disabled, greyed, shows `"[ค่าซับซ้อน — แก้ผ่านแท็บ JSON raw]"` + note under it.
   - Preview overlay: no box drawn for this field (skipped as `table-type-skip`).

2. **Regular field with valid bbox** (`total_amount`, currency, `{x:0.3, y:0.8, width:0.2, height:0.03}`)
   - Fields tab: `"12,345.00"` plain, no ⌗.
   - Edit input: enabled, editable string.
   - Preview overlay: green box renders correctly.

3. **Regular field with degenerate bbox** (e.g. `{x:NaN, y:0, width:0, height:0}`)
   - Fields tab: value shown, **⌗ appears** next to key with tooltip.
   - Preview overlay: nothing drawn; `[HIGHLIGHT_SKIP]` logged (in debug mode) with `reason: "degenerate"`.

---

## Red flags / follow-ups

- **[server-side]** Client guards are a band-aid. The real fix is coordinate-space discipline in the crop-pass response. Filed as **OCR-10** (Sprint 2 tail, ocr-pipeline). Blocking dependency: this task ships the observability (`[HIGHLIGHT_SKIP]` logs) that OCR-10 will use to categorize server output.
- **Editable table with JSON round-trip** parked to **UI-7b**. Design open: JSON textarea + `JSON.parse` validation + shape-preservation constraints.
- Fulldoc mode is unaffected — it has its own Text/JSON tabs and does not go through `resultEntries`.

---

## Not in scope (deferred, per task brief)

- OCR-10 server-side coord fix — separate task.
- UI-7b editable table.
- No new dependencies added.
