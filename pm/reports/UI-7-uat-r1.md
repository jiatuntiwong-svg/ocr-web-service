# UI-7 UAT round 1 — operator findings F1–F5

Base deploy: `e0df9966` (v2 batch view live in prod behind `ENABLE_OCR_WORKSPACE_V2`).
Owner: frontend-ui.
Date: 2026-07-14.

Target files:
- `src/components/OCRBatchViewV2.tsx` — bulk of the fixes.
- `src/components/OCRWorkspaceV2.tsx` — `TemplatePickerPanel` extracted out (F2 shared component).
- `src/components/TemplatePickerPanel.tsx` — **new** shared file.
- `src/lib/i18n/locales/th.ts`, `src/lib/i18n/locales/en.ts` — `ocr.v2.batch.runNote` trimmed (F4).

`OCRWorkspace.tsx` (v1) untouched — md5 `4ae60c50a0fe59a57d994350c2cd44d5`.

---

## F1 — BUG: 7-page PDF skips page picker

**Root cause.** `OCRBatchViewV2` had an auto-advance `useEffect` keyed on
`batchFiles.length`. It fired the moment a file landed in state, snapshotting
`pageCount` *before* async `pdfFileToImageDetailed` enrichment finished. Row
default `pageCount = 1` (line 167), so every PDF looked single-page and the
stage machine jumped straight to `fields`.

**Fix.** Removed the effect entirely. Users now click the "ถัดไป" button on
the upload stage; that button already evaluates `batchFiles.some(bf => bf.pageCount > 1)`
at click time (post-enrichment) and routes to `pages` or `fields` correctly.
Also solves F3.

**Diff summary.**
```
-    useEffect(() => {
-        if (batchFiles.length > 0 && currentStage === "upload") {
-            const anyMulti = batchFiles.some(bf => bf.pageCount > 1);
-            setCurrentStage(anyMulti ? "pages" : "fields");
-        }
-    }, [batchFiles.length]);
+    // NO auto-advance — user explicitly clicks "ถัดไป".
```

**Mental walkthrough.**
- 1 file × 7 pages: user drops PDF → row appears with `pageCount=1` (stub) →
  async enrichment updates row to `pageCount=7` → user clicks Next → button
  routes to `pages` stage → per-file page picker with 7 buttons visible. ✓
- Mixed batch (2 × 1-page + 1 × 5-page): after enrichment, `some(bf.pageCount>1)` = true
  → Next routes to `pages` → file tabs show all three, only the 5-page tab shows
  a picker (single-page files render the "single page — no picker" note). ✓
- Race: user clicks Next before enrichment resolves — still safe. The `pages` /
  `fields` decision reflects whatever state has landed; if only stubs exist,
  they still all say `pageCount=1` (correct for images) and route to `fields`.

---

## F2 — Batch template picker parity with single-file

**Root cause.** Batch used a flat `<select>` for template selection; single-file
uses the full `TemplatePickerPanel` widget with ⭐ Favorites / 🕐 Recent / 📋 All
sections, search, star toggle, inline delete confirmation, save-as-new dialog,
and update-active semantics.

**Fix.**
1. Extracted `TemplatePickerPanel` (interface + component + local styles) from
   `OCRWorkspaceV2.tsx` (lines 2363-2583 and the standalone `pickerSectionHead`
   style) into a new self-contained file `src/components/TemplatePickerPanel.tsx`.
   The component body is byte-equivalent; only its styles (`cardStyle`,
   `cardHeadStyle`, `miniBtnStyle`, `pickerSectionHead`) were duplicated inline
   in the new module so it does not import from `OCRWorkspaceV2`.
2. `OCRWorkspaceV2.tsx` imports the extracted component (`import TemplatePickerPanel from "./TemplatePickerPanel"`).
3. `OCRBatchViewV2.tsx` gained the surrounding state that the panel expects
   — `favoriteTemplateIds` + `recentTemplateIds` (localStorage-persisted, keys
   shared with v2 workspace: `ocr_v2_favorite_template_ids`, `ocr_v2_recent_template_ids`),
   `defaultOcrTemplateId` (via `/api/user-prefs`), `loadedTemplateSnapshot`
   (dirty tracking), `savingTemplate`, `saveAsNewOpen`, `newTemplateName` — plus
   handlers `applyTemplate` (now snapshots + pushes to recent), `saveAsNewTemplate`,
   `updateActiveTemplate`, `deleteTemplate`, `persistDefaultTemplate`,
   `toggleFavoriteTemplate`, `templateDirty` (memo), `activeTemplateName` (memo).
   A minimal save-as-new modal was added to the render (inline scrim, matches
   the v2 workspace layout).

**Mental walkthrough.** Batch fields stage now shows the same card as single —
star toggle persists per-device; loading a template applies fields and marks
it active; editing fields flips the "● มีการแก้ไข" pill; "↻ อัปเดต {name}"
saves in place; "+ บันทึกเป็น template ใหม่" opens the dialog. Since batch
holds ONE shared template across every queued file (D2), dirty state applies
to the single shared `extractFields` list — exactly as the operator expects.

---

## F3 — BUG: deleting a file at upload stage bumps to pages

**Root cause.** Same effect as F1 (`useEffect` on `batchFiles.length`). Deleting
a row changed the array length, so the effect re-ran and forwarded the stage.

**Fix.** Removing the effect (F1 fix) also fixes F3. User can add + remove files
freely at upload stage; the stage never advances unless the user clicks Next.

**Mental walkthrough.** User drops 5 files → they land → user clicks the ✕ on
row 3 → row disappears → `currentStage` stays `"upload"`. Delete all files →
stage still `"upload"` (the button becomes disabled because `batchFiles.every(bf => bf.status === "error")` returns false only when there's ≥1 non-error row). ✓

---

## F4 — Run stage copy trim

**Change.** `ocr.v2.batch.runNote` no longer mentions the throttling
implementation.

- th: `"รันทีละไฟล์และเว้นช่วงสั้น ๆ เพื่อกัน rate limit — อย่าปิด tab"` → `"อย่าปิด tab ขณะทำงาน"`.
- en: `"Files run sequentially with a short pause between each to avoid rate limits — do not close the tab"` → `"Don't close the tab while processing"`.

The 500 ms inter-file delay (`BATCH_INTER_FILE_DELAY_MS`) is unchanged — it
just isn't surfaced to the user.

---

## F5 — Results grid column widths / truncation

**Choice.** Option **(b)** — auto-fit + full display with per-cell wrapping
+ overall horizontal scroll (already present via the wrapping div's `overflow: auto`).

**Fix.**
- File-name cell: `maxWidth: 220 + textOverflow: ellipsis + nowrap` → `minWidth: 160, maxWidth: 320, wordBreak: break-word` plus a `title={displayName}` tooltip so an over-long name is still discoverable in full.
- Value cell: dropped the ellipsis wrapper (`overflow:hidden + textOverflow:ellipsis + whiteSpace:nowrap`); replaced with `wordBreak: break-word, whiteSpace: pre-wrap` inside a flex row. Added `minWidth: 140, maxWidth: 320` on the `<td>` so columns can't collapse to nothing and the horizontal scrollbar still kicks in when the field set is wide. Confidence badge stays inline (still rendered in the same flex row). `title={cell.value}` preserved as a hover tooltip.

`thStyle` retains `whiteSpace: nowrap` so column headers stay on one line.

Option **(a)** (user-resizable columns with localStorage persistence) is
deferred to UI-7b per the task spec.

---

## Verification checklist

- `npx tsc --noEmit` → exit 0 (clean).
- `npm run build` → `✓ Compiled successfully in 4.5s`, all app routes emitted.
- v1 `OCRWorkspace.tsx` md5 = `4ae60c50a0fe59a57d994350c2cd44d5` (unchanged, `git diff --stat` empty).
- `OCRWorkspaceV2.tsx` change: removed inline `TemplatePickerPanel` + `pickerSectionHead` style; added `import TemplatePickerPanel from "./TemplatePickerPanel"`. Callsite unchanged.
- No new dependencies.
- No changes to backend contract.

## Files touched
- `src/components/OCRBatchViewV2.tsx` — F1, F2, F3, F5 code changes; save-as-new modal added.
- `src/components/OCRWorkspaceV2.tsx` — F2 refactor only (import + inline copy removed).
- `src/components/TemplatePickerPanel.tsx` — **new** shared file.
- `src/lib/i18n/locales/th.ts` — F4 copy trim.
- `src/lib/i18n/locales/en.ts` — F4 copy trim.
- `pm/BOARD.md` — UI-7 row appended.

Do NOT deploy — leave for PM approval.
