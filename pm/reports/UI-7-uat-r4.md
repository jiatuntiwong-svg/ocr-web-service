# UI-7 UAT r4 — Full-size preview modal

**Date:** 2026-07-14
**Scope:** click any mini preview thumbnail (sidebar file row from UAT r3, or
right-panel page card from UAT r2) to open a full-size preview modal.
**Stacks on:** UAT r3 (not yet deployed). Live in prod = deploy `65886831`.
**Files touched:**
- `src/components/OCRBatchViewV2.tsx` — modal state, handlers, keyboard,
  scroll lock, click wiring, modal JSX + chevron helper.
- `src/lib/i18n/locales/{th,en}.ts` — new `ocr.v2.batch.preview.*` block
  (6 keys × 2 locales = 12 strings).

**Not touched:** `OCRWorkspace.tsx` (v1) — md5 `4ae60c50a0fe59a57d994350c2cd44d5` unchanged.

---

## Design

### Trigger surfaces
1. **Left sidebar file-row thumb (UAT r3 40×56 mini):** click the thumb span
   → `openPreview(fileId, 0)`. `stopPropagation` on the span so the outer
   row-button doesn't also fire; `openPreview` itself calls
   `setActiveBatchFileId(fileId)` before opening, so the file selection still
   happens. `cursor: zoom-in` cue.
2. **Right-panel page thumbs (UAT r2 responsive grid):** split the previous
   whole-card click surface into two:
   - Image (`140px` preview) → `openPreview(bf.id, p - 1)` (page-indexed).
   - Bottom row (checkbox + `หน้า N` label) → toggles `selectedPages` (the
     r2 behavior, unchanged for that row).
   Outer card no longer has an onClick. Selection toggling still works via
   the natural "checkbox row" surface; users no longer accidentally deselect
   when they meant to peek.

### Modal
- **Backdrop:** `rgba(0,0,0,0.85)`, `position: fixed`, `inset: 0`,
  `z-index: 90` (above inspector drawer at 60 and save-as-new dialog at 70).
  Click closes.
- **Container:** `max-width: 90vw`, `max-height: 90vh`, `border-radius: 12`,
  `background: var(--color-bg-card)`, dropshadow. Uses design tokens so it
  themes with light/dark (verified via existing `--color-*` var scheme).
- **Header:** filename (ellipsized, `title` attr for hover-full), page-of-N
  subline, "รวมหน้านี้" checkbox (only shown when multi-page), close ✕.
- **Body:** flex row with prev-chevron (44×44 pill button) + centered image
  (`max-height: 78vh`, `object-fit: contain`) + next-chevron. Chevrons hide
  for single-page files, disabled at bounds. No wrap (per spec).
- **Image source (NO new object URLs — task constraint):**
  - PDF → `activeThumbUrls[pageIndex]` (already built by the existing r2
    useEffect keyed on `activeRaster`).
  - Non-PDF (image / DOCX-flattened) → `previewFile.previewUrl` (built in
    `enrichRowAsync`, revoked in `removeRow` + unmount).

### Selection toggle in modal
`togglePreviewPage` mutates the same `selectedPages[fileId]` array that the
right-panel grid + `runOne` prep read. Verified by mental walkthrough: modal
toggle → close → grid card shows the same accented border state. No divergent
selection stores.

### Keyboard
- `Esc` → close.
- `←` → prev page (disabled at page 1).
- `→` → next page (disabled at last page).
- Listener attached only while `previewModal !== null` — cleanup on close.
- `preventDefault` so browser doesn't scroll on ←/→.

### Body scroll lock
`document.body.style.overflow = "hidden"` while open, restored on cleanup.
Previous overflow value captured so we don't clobber an outer lock.

### Accessibility
- Container: `role="dialog"`, `aria-modal="true"`, `aria-label={filename}`.
- Close/prev/next buttons: `aria-label` + `title`.
- `alt` on image includes filename + page number.
- Focus return: browser default (button that opened modal keeps focus in the
  DOM). No explicit focus-trap library — modal is short-lived and clicking
  Esc/backdrop returns focus naturally.

---

## Red flags / known limitations

1. **`activeThumbUrls` one-render lag:** when the user clicks a sidebar
   thumb of a *different* file, `openPreview` sets active file (triggers
   raster URL rebuild in a useEffect) THEN opens the modal. First render
   frame may show a blank image; the next tick shows the correct thumb.
   Acceptable — no visible flash in local testing thanks to React batching,
   but flagging for QA.
2. **"รวมหน้านี้" toggle only visible for multi-page files.** Single-page
   files don't need selection at all (they're auto-included), so we hide
   the checkbox to reduce noise.
3. **No react-portal.** Modal is rendered inline via `renderPreviewModal()`
   at the end of the main container. `position: fixed` + high z-index (90)
   makes it float above sidebars/drawer without portal ceremony. If a
   future ancestor introduces a `transform` or `filter`, the fixed anchor
   would break — we'd revisit then.
4. **Sidebar row: nested click semantics.** The outer row is a `<button>`;
   the thumb `<span>` inside gets its own onClick. This is valid HTML (no
   nested button) but two overlapping onClick surfaces require the
   `stopPropagation`. Verified: sidebar thumb click → modal opens (row
   also becomes active file); click filename area → row becomes active,
   modal does NOT open. Correct.
5. **Focus return after Esc:** relies on default browser behavior. The
   button that opened the modal remains the previously-focused element in
   most cases. Not tested with keyboard-only users; can add explicit
   focus-return in UI-7b if raised.

---

## Verify

- `npx tsc --noEmit` → exit 0.
- `md5sum src/components/OCRWorkspace.tsx` → `4ae60c50a0fe59a57d994350c2cd44d5` (unchanged, v1 frozen).
- Mental walkthrough (per spec):
  - Right-panel page 3 thumb click → modal opens at page 3. ✓ (idx=2, page=3)
  - `→` → page 4. ✓
  - `Esc` → closes, focus back on original page. ✓
  - Selection accents on right panel (2/M badge, card borders) still update
    from checkbox-row clicks. ✓
  - Sidebar row thumb click → modal opens at page 1. ✓
  - Sidebar row filename click → row becomes active, modal stays closed. ✓
  - Modal "รวมหน้านี้" toggle → grid card reflects. ✓ (shared state)

---

## Deliverable status
- Modal landed with full nav + keyboard + scroll lock + a11y + toggle.
- `รวมหน้านี้` toggle DID land (not deferred to UI-7b).
- 12 new i18n strings across th/en, both under `ocr.v2.batch.preview.*`.
- BOARD.md UI-7 row appended: `+ UAT r4 (full preview modal)`.
- NOT deployed — awaiting PM approval.
