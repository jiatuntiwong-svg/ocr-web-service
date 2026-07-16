# UI-7 UAT r2 — batch "pages" stage layout fix

**Date:** 2026-07-14
**Scope:** `src/components/OCRBatchViewV2.tsx` (batch mode, pages stage only)
**Trigger:** Operator screenshot 2026-07-14 — filenames unreadable in cramped
horizontal tabs when several files were queued (`ใบตัดจ่ายภาคฯ 3 รอบที่ 2 ม.ค.69 X.pdf (1/1)`
squeezed into an ~80 px tab).

Not deployed — awaiting PM approval.

## Before

Horizontal file tabs at the top of the pages stage. Each tab crammed
`filename (M/N)` into one row. With 3+ queued files whose names were long
Thai strings, tabs collided / clipped to unreadable slivers; the page-picker
below the tabs was just a wall of tiny numbered squares (40×52 px) with no
preview of what page you were selecting.

```
┌─ pages ─────────────────────────────────────────────────────────────┐
│ [ใบตัด...(1/1)] [ใบตัด...(1/1)] [ใบตัด...(2/7)] [ใบตัด...(1/1)]     │  ← wraps + clips
│ ────────────────────────────────────────────────────────────────── │
│ Select all · Clear                                    3 / 7 pages   │
│ [1][2][3][4][5][6][7]                                                │  ← no previews
└─────────────────────────────────────────────────────────────────────┘
```

## After

Two-column grid: `grid-template-columns: minmax(220px, 260px) 1fr`. Left
column is a vertical scrollable file list; right column is per-file header
+ responsive thumbnail grid using the raster PNGs already computed in
`enrichRowAsync` (no extra PDF work).

```
┌─ pages ────────────────────────────────────────────────────────────────┐
│ ALL FILES (4)          │ ใบตัดจ่ายภาคฯ 3 รอบที่ 2 ม.ค.69 X.pdf         │
│ ┌────────────────────┐ │ 7 หน้า · เลือก 3 หน้า   [เลือกทั้งหมด][ล้าง] │
│ │▌ใบตัด...X.pdf  3/7 │ │ ─────────────────────────────────────────── │
│ │ ใบตัด...Y.pdf  1/1 │ │ ┌────┐ ┌────┐ ┌────┐ ┌────┐                │
│ │ ใบตัด...Z.pdf  1/1 │ │ │[PNG]│ │[PNG]│ │[PNG]│ │[PNG]│  thumb grid │
│ │ ใบตัด...W.pdf  2/5 │ │ │ ☑ 1 │ │ ☑ 2 │ │ ☐ 3 │ │ ☑ 4 │  auto-fill │
│ └────────────────────┘ │ └────┘ └────┘ └────┘ └────┘  min 120px      │
│    (scrollable if >8)  │ ┌────┐ ┌────┐ ┌────┐                        │
│                        │ │[PNG]│ │[PNG]│ │[PNG]│                     │
│                        │ │ ☐ 5 │ │ ☐ 6 │ │ ☐ 7 │                     │
│                        │ └────┘ └────┘ └────┘                        │
└────────────────────────────────────────────────────────────────────────┘
[← ย้อนกลับ]                                              [ต่อ: Fields]
```

## Changes

### `src/components/OCRBatchViewV2.tsx`

1. Added `activeRaster` memo + `activeThumbUrls` state/effect that:
   - Wraps `pdfRaster.pagePngs` (`Blob[]`) in object URLs when the selected
     file changes
   - Revokes URLs on cleanup — no leak across file switches
2. Rewrote `renderPages()`:
   - Container now grid `220-260 | 1fr`
   - Left sidebar: `border-right`, panel-bg, per-row button
     - filename truncates with ellipsis, full name in `title`
     - `borderLeft: 3px solid accent` when selected
     - `⚠` prefix + red badge when selection > cap
     - `M/N` badge (selected/total)
     - scrollable vertical list
   - Right panel: header (filename + summary + Select all / Clear + over-cap
     warning) above a `overflow-y: auto` body with a `repeat(auto-fill,
     minmax(120px, 1fr))` thumbnail grid
     - each thumbnail = 140 px preview area (PNG object URL, `object-fit:
       contain`, panel-bg fallback for non-PDF or pre-raster state) + row
       with checkbox + `หน้า N` label
     - clicking anywhere on the cell toggles selection (checkbox stops
       propagation so it doesn't double-toggle)
     - Selected cell uses accent-dim background + 2 px accent border
   - Empty-right fallback if no file selected: `เลือกไฟล์ทางซ้าย`
   - Single-page files show the r1 message centered in the right panel
3. `pageCount <= 1` early-return for the panel is gated *inside* the right
   column (was gating whole content before) so the sidebar stays usable.

Data flow unchanged: still writes `selectedPages: number[]` per BatchFile,
still uses `PAGE_SELECTION_MAX` cap, still uses same `pagesOverCap` gate on
the Next button, still no auto-advance. Stage machine untouched.

### `src/lib/i18n/locales/{th,en}.ts`

New keys under `ocr.v2.batch.pages`:
- `fileListHead` — sidebar header "ALL FILES (n)"
- `pageSummary` — "{total} หน้า · เลือก {n} หน้า"
- `emptyRight` — right-panel empty state

Reused existing keys: `ocr.v2.pageLabel`, `ocr.v2.pages.selectAll`,
`ocr.v2.pages.clear`, `ocr.v2.batch.overCap`, `ocr.v2.batch.singlePage`,
`ocr.v2.batch.pagesTitle`, `ocr.v2.batch.pagesTip`.

## Verify

| Check                                                   | Result |
| ------------------------------------------------------- | ------ |
| `npx tsc --noEmit`                                      | exit 0 |
| `npm run build`                                         | ✓ Compiled successfully in 4.2s |
| v1 `OCRWorkspace.tsx` md5 = `4ae60c5…44d5`              | unchanged |
| Batch-mode file `OCRBatchViewV2.tsx` still self-contained (no v1 embed) | ✓ |
| No new deps                                             | ✓ |
| No route added / removed                                | ✓ |

### Mental UX walkthrough

- **3 files × 1 page each (screenshot scenario):** sidebar shows three
  clean rows; right panel per selection shows `singlePage` message. Names
  fully readable via truncate + tooltip. Fixes the reported bug.
- **1 file × 7 pages:** sidebar has one row; right panel shows 7 thumbnails
  in an auto-fill grid (7 across on wide screens, 3-4 across on narrow).
  Checkbox overlay + click-to-toggle works.
- **5 files × mixed 1/1, 2/7, 3/5 …:** sidebar still readable, badges show
  progress at a glance; clicking a row swaps the right panel; `activeThumbUrls`
  effect rebuilds/revokes cleanly.
- **10 files (batch cap):** sidebar scrolls (`overflow-y: auto`); left col
  width stays fixed. No horizontal collision.
- **Over-cap file (>10 pages selected):** left badge goes red, filename
  gets ⚠ prefix; right panel keeps the existing red text banner + disables
  Next.

### Known follow-ups (not blockers)

- Thumbnail cache is per active file only — switching between files rebuilds
  URLs. Acceptable for the batch cap (≤10 files, ≤10 pages) but if we ever
  raise `MAX_BATCH_FILES` we may want a global thumbnail LRU.
- Non-PDF files (image / DOCX) show `—` placeholder in the thumb slot
  instead of the actual preview. Those files always have `pageCount = 1`
  and hit the `singlePage` branch anyway, so the placeholder is never
  visible in practice. Left alone.
