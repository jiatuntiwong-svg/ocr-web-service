# UI-7 UAT r3 — per-file mini preview in pages sidebar

**Date:** 2026-07-14
**Scope:** `src/components/OCRBatchViewV2.tsx` — left file-list rows in Pages stage
**Rollout:** not deployed (awaiting PM approval).

## Problem

UAT r2 (vertical file list) still forced the operator to click every row to
verify the queued file was correct. For 1-page files the right panel showed
"single page — no picker" and no preview at all, so 5 wrong files in a batch
of 5 was invisible without clicking each one.

## Change

Added a 40×56 page-1 mini thumbnail to the left of the filename in each
sidebar row.

Before:
```
[⚠] filename.pdf                                    [3/7]
```

After:
```
[40×56 thumb] [⚠] filename.pdf                      [3/7]
```

- Size: 40×56 (portrait aspect), `object-fit: contain`, 4px radius, 1px
  border, background `--color-bg-elevated` for letterboxed area.
- Source: **reused existing `row.previewUrl`**. That URL is already:
  - For PDF → `URL.createObjectURL(raster.pagePngs[0])` (page 1) — set in
    `enrichRowAsync` line 258.
  - For DOCX → object URL of the flattened image — line 249.
  - For image upload → object URL of the file itself — line 266.
- If `previewUrl` is null (raster still parsing) → shows `…` placeholder on
  the `--color-bg-elevated` background. No spinner needed; the raster
  completes fast enough that this only appears for a fraction of a second.

## Thumbnail lifecycle notes

**No new object-URL state was added.** `previewUrl` is already:
- created once per file in `enrichRowAsync`
- revoked when the file is deleted (`removeRow`, line 281)
- revoked on component unmount (line 199)

Reusing the same URL in the sidebar `<img>` and the right-panel preview
`<img>` is safe — both are DOM `src` references to the same blob URL; the
browser reference-counts them.

## Verification

- `npx tsc --noEmit` → exit 0 (clean)
- `npm run build` → clean (all routes compile)
- v1 `src/components/OCRWorkspace.tsx` md5 = `4ae60c50a0fe59a57d994350c2cd44d5` (unchanged — FROZEN invariant honored)
- No changes to stage machine, data flow, or right-panel behavior.
- No new dependencies.

Mental walkthroughs:
- 5 files × 1 page each → each row shows page-1 preview immediately after
  `enrichRowAsync` completes. Operator can scan all 5 without clicking.
- 5 files, mixed 1/3/7 pages → same. Right panel switches on click as
  before, showing single-page message for the 1-page rows and the
  thumbnail grid for the 3/7-page rows.
- Delete a file → `removeRow` revokes `previewUrl` and drops the row.
  The sidebar `<img>` for that row is torn down with the row.
- Non-PDF image upload → `previewUrl = createObjectURL(f)`, sidebar shows
  the image itself scaled into the 40×56 slot.

## Red flags

- **None known.** The change is purely additive rendering; no state, no
  effects, no async work added.
- One minor visual note: the 40×56 slot adds ~48px to each row's left
  padding budget. Filenames still get `text-overflow: ellipsis`, so
  extremely narrow window widths will clip filenames sooner than before.
  Sidebar min-width is 220px (grid template), so filenames retain
  ≥130px of horizontal space — matches r2's readable range.

## Deliverables

- Edit: `src/components/OCRBatchViewV2.tsx` (sidebar row renderer inside
  `renderPages`).
- BOARD updated: UI-7 row now ends with `+ UAT r3 (per-file mini preview
  in list)`.
- This report.
