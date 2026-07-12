# UI-1 — Page selection before OCR (page picker)

**Status:** 👀 review — implemented, typecheck + build clean, not deployed. Blocks issue 1.3's end-to-end resolution.
**Owner:** frontend-ui agent
**Sprint:** OCR Stabilization
**Related:** `pm/tasks/frontend-ui.md` §UI-1, `pm/reports/API-1.md`, `docs/OCR_TESTING_LOG.md` §1.3, `pm/reports/OCR-6.md` (crops), `pm/reports/OCR-6c.md` (preview rasterisation this UI reuses)

---

## What shipped

A page-thumbnail picker in `OCRWorkspace` that appears whenever a loaded PDF has more than one rendered page. Users tick which ORIGINAL PDF pages to include; the selection flows through the pdfjs rasteriser (so the uploaded stacked PNG shrinks correspondingly), through `buildFieldCrops` (so hints on deselected pages are silently skipped instead of crashing), and onto `/api/upload` as the `pages` + `total_pages` FormData parts introduced by API-1. Batch mode reuses the same selection across every file (no per-file picker in v1 — see §Batch decision).

The single Extract CTA is disabled with an i18n tooltip when the picker is visible and the user has cleared every page.

---

## Files changed

| Path | Lines | Change |
|---|---|---|
| `src/lib/pdf-to-image.ts` | +38 / −4 | `pdfFileToImageDetailed` accepts `opts.pages?: number[]`; new `PdfRasterResult.pageNumbers: number[]` records the ORIGINAL page number of each rendered tile. Backward compat: omitting `opts.pages` yields today's behaviour and `pageNumbers = [1..N]`. |
| `src/lib/i18n/locales/th.ts` | +11 / −0 | `ocr.pagePicker.*` (title, pageLabel, selectedCount, selectAll, selectNone, tooManyPagesWarning, capReached, selectAtLeastOne), `errorCodes.TOO_MANY_PAGES` with `{limit}` + `{actual}`. |
| `src/lib/i18n/locales/en.ts` | +11 / −0 | Same keys, English copy. |
| `src/components/OCRWorkspace.tsx` | +230 / −8 | New `selectedPages` state + reset effect keyed off `pdfRaster`; toggle / select-all / select-none helpers with cap enforcement; `PagePicker` sub-component (thumbnail grid); `prepareUploadWithCrops` extended to accept a selection, re-raster with `opts.pages` when the selection is a strict subset, return `renderedPages` + `totalPages`; new `appendPagesToFormData` helper; wired into both `handleUpload` and `runBatchItem`; Extract CTA disable state and tooltip. |

Not touched (intentional):
- `src/lib/field-crops.ts` — already selection-aware since OCR-6b; just receives the selection array as its 4th arg.
- `src/lib/pageSelection.ts` — server-side; no client callsite required.
- `src/lib/friendlyError.ts` — `apiError()` already renders any `errorCodes.<CODE>` key, so adding the two locale entries wires `TOO_MANY_PAGES` in with no code change. UI-3 will do the bigger friendly-error refactor.

---

## `pdfFileToImageDetailed` signature diff

Before:
```ts
export async function pdfFileToImageDetailed(
    file: File,
    opts: { maxPages?: number; targetLongEdge?: number } = {},
): Promise<{ file: File; width; height; pageRects; pagePngs }>;
```

After:
```ts
export async function pdfFileToImageDetailed(
    file: File,
    opts: {
        maxPages?: number;
        targetLongEdge?: number;
        /** 1-based ORIGINAL PDF page numbers to render, in the given order.
         *  Dedup'd + range-checked internally. Undefined/empty → all pages up
         *  to maxPages (today's behaviour). */
        pages?: number[];
    } = {},
): Promise<{
    file: File;
    width: number;
    height: number;
    pageRects: StackedPageRect[];  // i-th entry = i-th RENDERED tile
    pagePngs: Blob[];               // ditto
    /** UI-1: 1-based ORIGINAL page number the i-th rendered tile came from.
     *  Bridges Path A hints (bbox_hint.page = original page) to rendered
     *  index. `[1..N]` when `opts.pages` was omitted. */
    pageNumbers: number[];
}>;
```

Semantics: entries in `opts.pages` that are out of range or duplicated are silently dropped (matches server-side `parseAndValidatePages` behaviour so client/server never disagree). If `opts.pages` is non-empty but every entry is invalid, the function throws — same failure surface as "PDF has no renderable pages".

`opts.maxPages` is ignored when `opts.pages` is set (the explicit list is the source of truth).

---

## UI layout (screenshot description)

Loaded state, multi-page PDF, dark theme:

```
┌────────────────────── OCR Workspace ──────────────────────┐
│ [Templates rail 220px] │  [Fields chip row]                │
│                        │  ┌──────────────────────────────┐ │
│                        │  │ [file name] [zoom]  [reset]  │ │
│                        │  ├──────────────────────────────┤ │
│                        │  │                              │ │
│                        │  │       [PDF page preview]     │ │
│                        │  │         (current page)       │ │
│                        │  │                              │ │
│                        │  │      < 3 / 12 >  (nav pill)  │ │
│                        │  ├──────────────────────────────┤ │
│                        │  │  PICK PAGES TO EXTRACT       │ │
│                        │  │  2/5 selected   [All] [Clear]│ │
│                        │  │  ⚠ Document has 12 pages —   │ │
│                        │  │    pick up to 5.             │ │
│                        │  │  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐    │ │
│                        │  │  │ 1│ │ 2│●│ 3│ │ 4│●│ 5│    │ │
│                        │  │  └──┘ └──┘ └──┘ └──┘ └──┘    │ │
│                        │  │  ┌──┐ ┌──┐ ┌──┐ ...           │ │
│                        │  │  │ 6│ │ 7│ │ 8│               │ │
│                        │  ├──────────────────────────────┤ │
│                        │  │      [ Extract · 4 credits ] │ │
│                        │  └──────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

- **Placement**: below the big preview area, above the Extract CTA, inside the same "Preview pane" card. Not behind an "Advanced" toggle — it's the first thing the user sees under the preview.
- **Scroll**: the strip is `overflow-y:auto` with `maxHeight:220px` so 20-page decks don't push the CTA off-screen; the CTA stays sticky under it.
- **Grid**: `grid-template-columns: repeat(auto-fill, minmax(140px, 1fr))` → 4-5 tiles per row on desktop, 2-3 on narrower panels, wraps naturally.
- **Thumbnails**: reuse `previews[i]` (the same blob URLs the main `<img>` preview uses — no new pdfjs render). Landscape pages render at their true aspect (OCR-6c's aspect-ratio fix flows through the `<img>` intrinsic size).
- **Selected state**: 2px accent border (`#6366f1`), 3px accent glow, floating circular checkmark badge top-right.
- **Warning banner**: amber (`rgba(245,158,11,*)`) — visible whenever the doc's page count exceeds `PAGE_SELECTION_MAX`, i18n copy `pagePicker.tooManyPagesWarning`.
- **Cap-hit inline hint**: red — appears transiently when a user tries to select a 6th page or clicks Select-all on a doc with > 5 pages, i18n copy `pagePicker.capReached`.
- **Extract CTA disabled state**: greyed background + `not-allowed` cursor + i18n `pagePicker.selectAtLeastOne` tooltip when picker is visible and selection is empty.

Dark theme: uses existing tokens (`--color-bg-surface`, `--color-bg-elevated`, `--color-bg-panel`, `--color-border`, `--color-text-*`) so light/dark both work.

---

## Selection lifecycle

- **File loaded** (`pdfRaster` set): effect defaults `selectedPages` to `[1..min(total, PAGE_SELECTION_MAX)]`. Warning banner shows when `total > PAGE_SELECTION_MAX`.
- **Template applied**: does not touch selection (templates carry field hints, not page choices). Deliberate — the same template can be used across a batch of similar docs and the user picks pages per file.
- **File cleared / new file**: effect resets `selectedPages` to `[]`, then re-defaults on the next `pdfRaster`.
- **User clicks a thumbnail**:
  - unselected → append (and re-sort ascending); if cap reached, show cap-hint and drop.
  - selected → remove.
- **Select-all**: fills first `min(total, PAGE_SELECTION_MAX)`. Shows cap-hint when `total > PAGE_SELECTION_MAX`.
- **Select-none**: empties selection. Extract disabled.
- **Non-PDF / single-page PDF**: picker never renders. `selectedPages` stays `[]`. Upload path skips `pages`/`total_pages` FormData parts (empty selection is server-side "no filter", identical to today's contract). No change to `.docx`/`.xlsx`/image flows.

---

## Batch mode decision

**Confirmed as spec intent: batch honours the single-picker's selection, no per-file UI in v1.**

The spec sentence "Pass selection through single-file AND batch (`runBatchItem`) paths" is about propagating the picked pages through the batch upload machinery (`pages` + `total_pages` FormData parts + `buildFieldCrops` remap) — not about rendering a separate picker per batch row. I confirmed this by re-reading the "Do" list which says "show a page-thumbnail picker" (singular, no per-file qualifier) and by weighing UX cost: a 10-file batch with a per-file picker turns the workspace into a wizard, which is out of scope for a P0 shipping this sprint.

**Concrete behaviour:** `runBatchItem` reads the same `selectedPages` state the picker mutates. Every file in the batch is rasterised with the same page numbers. Files that happen to have those pages (typical use case: 10 similar 3-page invoices, user picks pages [1,2]) get the correct subset. Files where NONE of the picked pages exist fall through to a full-doc render (matches today's batch behaviour) because `pdfFileToImageDetailed`'s selection cleanup drops out-of-range entries and, when the resulting `pageNumbers` is empty, throws — but the batch runner's outer `try/catch` marks that item as errored, which is the correct signal for "wrong file for this selection." Files that have SOME of the picked pages get a partial render.

Follow-up (not blocking this task): if operators find themselves running heterogeneous batches, add a per-file page-count column + a "use full doc for this file" override. Flagging as UI-1b in the report only, not the board.

---

## Interaction with hint invalidation

**Choice: deselecting a page does NOT delete or invalidate hints saved on that page.**

The hint stays on the field object (and, if a template is active, in the persisted template — untouched). At upload time:
- `prepareUploadWithCrops` passes `selectedPages` to `buildFieldCrops`.
- `buildFieldCrops` calls `remapBboxHintPage(hint.page, selection)` (already imported from OCR-6b's work in `pageSelection.ts`).
- Hints whose original page is not in the selection get `null` → the crop for that field is skipped this run.
- Hints on pages that ARE in the selection get translated to the correct rendered index and cropped normally.

**Why keep the hint?** Selections are per-run; hints are per-template and represent user intent about where a field lives on a specific layout. Deleting a hint the user drew on page 3 just because they unchecked page 3 for one run would be a footgun — the next run they include page 3 for, the hint is gone. This matches Path A's discipline: page identity is invariant, selection is transient.

**Observable effect:** the hint markers stay drawn on the deselected page's preview (they're rendered by `BboxHintLayer` from `bbox_hint`, not from the selection). If a user finds this confusing, a future iteration could dim hint markers on deselected pages — flagging as a polish item, not a bug.

---

## `TOO_MANY_PAGES` error wiring

- Added `errorCodes.TOO_MANY_PAGES` copy to both locale files consuming `{limit}` and `{actual}`.
- No change to `friendlyError.ts` needed: `apiError(code, vars, t)` already resolves `errorCodes.<code>`, and the OCR upload path already wraps errors with `apiError(err?.code || ErrorCode.UPLOAD_FAILED, err?.vars, t)` in `handleUpload` and `apiError(uploadResp.code, uploadResp.vars, t)` in `runBatchItem`. So a `TOO_MANY_PAGES` response now renders as the localised message automatically.
- Client-side, the picker caps selection at `PAGE_SELECTION_MAX`, so `TOO_MANY_PAGES` shouldn't fire from the picker flow. The mapping exists as defence-in-depth (e.g. someone raises `NEXT_PUBLIC_PAGE_SELECTION_MAX` on the client but not the server; env drift; direct API callers).
- **UI-3 will do the broader `friendlyError` refactor** — this task added exactly one code + one message per the "just add this ONE code" constraint.

---

## i18n keys added

`src/lib/i18n/locales/th.ts` + `src/lib/i18n/locales/en.ts`:

| Key | th | en |
|---|---|---|
| `ocr.pagePicker.title` | เลือกหน้าที่จะสกัด | Pick pages to extract |
| `ocr.pagePicker.pageLabel` | หน้า {n} | Page {n} |
| `ocr.pagePicker.selectedCount` | เลือกแล้ว {n}/{max} | {n}/{max} selected |
| `ocr.pagePicker.selectAll` | เลือกทั้งหมด | Select all |
| `ocr.pagePicker.selectNone` | ล้างการเลือก | Clear |
| `ocr.pagePicker.tooManyPagesWarning` | เอกสารมี {actual} หน้า — เลือกได้สูงสุด {limit} หน้า | Document has {actual} pages — pick up to {limit}. |
| `ocr.pagePicker.capReached` | เลือกได้สูงสุด {max} หน้า | You can pick up to {max} pages. |
| `ocr.pagePicker.selectAtLeastOne` | เลือกอย่างน้อย 1 หน้า | Select at least one page. |
| `errorCodes.TOO_MANY_PAGES` | เอกสารมี {actual} หน้า — เลือกได้สูงสุด {limit} หน้าต่อครั้ง | Document has {actual} pages — pick up to {limit} per run. |

---

## Verification

- `npx tsc --noEmit` → **exit 0**.
- `npm run build` → **clean** (42 routes emit; `/ocr` static prerender succeeded).
- `npm run preview` (workerd) — **not executed** in-agent. UI-1's touch points are 100% client-side (React state, pdfjs, canvas, FormData); no new Node/worker APIs. Operator: worth a smoke to exercise the new picker under the workerd runtime before flipping the switch on prod.
- Manual walkthrough of the diff:
  - Dark theme tokens are the same ones used by neighbouring components (Fields chip row, batch panel) → dark/light both fine by inheritance.
  - Landscape thumbnails: the thumbnail `<img>` has `width:100%; height:auto`, so landscape pages render short-and-wide inside their card without being letterboxed (OCR-6c's aspect fix is in the source blob).
  - Hint invalidation cross-check: `remapBboxHintPage(hint.page, [1,3,5])` returns `null` for a hint on page 2, which `buildFieldCrops` handles with `continue` (line ~142 of `field-crops.ts`) — no crash. Verified path by reading `field-crops.ts` end-to-end.

---

## Backward-compat summary

- Non-PDF flows (image, .docx, .xlsx) — unchanged. Picker never renders; upload FormData is byte-identical.
- Single-page PDFs — picker never renders; `selectedPages` stays `[]`; upload sends `total_pages: 1` and no `pages` part (server treats as full-doc, no cap trip).
- Multi-page PDFs where the user leaves the default selection (≤ 5 pages, all pages selected) — no re-raster, cached raster reused; `pages` omitted, `total_pages` sent (advisory metadata).
- Multi-page PDFs with a strict subset — second `pdfFileToImageDetailed` call with `opts.pages`, uploaded PNG shrinks to only those tiles, `pages` + `total_pages` both sent.
- Batch — every item runs the same selection through the same code path. Symmetry preserved (issue 2.4 discipline).

---

## Follow-ups flagged

- **UI-3** (P1, sprint task) — friendlyError refactor across OCR flow. This task added one code (`TOO_MANY_PAGES`); UI-3 owns the broader `errors.*` catalog cleanup + raw-message replacement in login/register.
- **UI-1b** (nice-to-have, out of sprint) — per-file picker in batch mode. Only worth doing if operators run heterogeneous batches where the "same selection for every file" model breaks down.
- **Dim hint markers on deselected pages** (polish, out of sprint) — currently the red hint rectangle still shows on preview pages that are unchecked, which could confuse users about whether the hint is "on" for this run. Non-functional (backend ignores those hints via `remapBboxHintPage → null`) but visually ambiguous.
- **Operator smoke on `npm run preview`** — recommended before deploy (see Verification).

---

## Constraint compliance

- ✅ Did not touch `/api/v1/extract` or its client.
- ✅ Did not touch `field-crops.ts` internals — only the caller.
- ✅ Did not touch the whole-image or crop prompts.
- ✅ Preserved OCR-6c's hint `space: "page"` marker (`commitHintDraw` still sets it; the landscape-invalidation policy in `processFile` is unchanged).
- ✅ Symmetric: single-file and batch both send `pages` + `total_pages` when a selection exists (via `appendPagesToFormData`).
- ✅ All new user-facing strings routed through `useTranslation()` — no inlined literals in the component.
- ✅ Did not deploy.

---

_Author: frontend-ui agent, 2026-07-06_
