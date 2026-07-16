# UI-7 — Batch flow in v2 style — Implementation report

**Date:** 2026-07-14
**Status:** 👀 review (frontend-ui → PM)
**Decisions applied:** D1–D8 from `pm/reports/UI-7-decisions.md`
**Sprint deploy:** `fb169356` in prod (v2 workspace flag ON, dual-scale crops, API-4b MIME fixes, baseline 100 %)

## Summary

Replaced the UI-4c stopgap (v2 batch = embedded v1 workspace) with a
v2-native batch view. Owns its own state, its own stepper, its own
per-file page picker, sequential extraction, spreadsheet results and
export — no v1 code runs when the user flips the ModeSwitch to
"หลายไฟล์" anymore.

## Files landed

- **New** `src/components/OCRBatchViewV2.tsx` — self-contained batch
  view (~980 lines). Shares no state with `OCRWorkspaceV2` — parent
  simply mounts it in the batch branch. Reuses `pdfFileToImageDetailed`,
  `docxFileToImage`, `buildFieldCrops`, `interleaveDualScaleCrops`,
  `estimateCredits`, `evaluateConfirm`/`shouldSkipDialog`, `fetchJson`,
  `apiError`, `CreditConfirmDialog`, `exportOCRBatch`.
- **Modified** `src/components/OCRWorkspaceV2.tsx` — dropped
  `OCRWorkspaceV1` import; the batch branch (formerly lines 1957–1988,
  the v1 embed) now renders `<OCRBatchViewV2 headerRight={…}/>`.
  Passes the QuickModeToggle + ModeSwitch as `headerRight` so the flip-
  back to single-file remains 1 click. Nothing else in v2 changed.
- **Modified** `src/lib/i18n/locales/{en,th}.ts` — added
  `ocr.v2.batch.*` namespace (52 keys each locale).
- **Not touched** `src/components/OCRWorkspace.tsx` — md5
  `4ae60c50a0fe59a57d994350c2cd44d5` unchanged vs HEAD. Rollback path
  intact: flip `ENABLE_OCR_WORKSPACE_V2 = false` → both single and batch
  fall back to v1 verbatim.
- **Not touched** `src/app/(app)/ocr/page.tsx` — the "kill `?mode=batch`
  → v1 legacy redirect" note in the brief maps to killing the v1
  *embed inside v2* (there was no URL-level `?mode=batch` route to
  remove). Grep confirmed no `?mode=batch`, `initialMode`, or URL-
  based batch routing anywhere in `src/`. Done via the OCRWorkspaceV2
  edit above.

## Decisions applied (D1–D8)

- **D1 shared stepper** — same 6 steps as single-file: upload → pages
  → fields → run → results → export. `canJumpTo` gates each step by
  its prerequisite (files present, fields present, extractions done).
- **D2 shared template** — one template dropdown; picking it seeds a
  single `extractFields[]` used for every file. No per-file override.
- **D3 per-file page selection** — horizontal file tabs at the top of
  the pages stage; each tab keeps its own `selectedPages[]`. Default =
  auto-select up to `PAGE_SELECTION_MAX` (5) when raster completes; if
  a file has more pages, its tab shows `⚠ … (N/M)` and the Next-Fields
  CTA is disabled until the user reduces the count under cap. Uses the
  existing `PAGE_SELECTION_MAX` constant.
- **D4 sequential + 500ms pacing** — `BATCH_INTER_FILE_DELAY_MS` const
  at the top of the file (tunable). `runAll()` iterates ids in order,
  `await`s each `runOne`, then `await`s the delay. Matches v1 semantics
  except concurrency was 3, we chose 1 to keep CF/AI RL headroom (see
  Red flags).
- **D5 fulldoc + batch allowed with breakdown** —
  `perFileBreakdown` builds one row per eligible file
  (`{name, pages, credits}`) and feeds it into `CreditConfirmDialog`'s
  `steps` prop plus a final "Total" row. Dialog reuses existing
  T1–T4 evaluation (via `evaluateConfirm`) so batch cannot bypass it.
  Fingerprint includes `docCount: eligibleFiles.length` so the
  "don't ask again" pref is per-shape (single-vs-batch don't collide).
- **D6 spreadsheet results** — sticky-header `<table>`: rows = files,
  columns = union of field keys across completed results, seeded with
  configured field names so the columns don't vanish for empty
  batches. Cell shows value + tiny confidence badge (colour banded by
  the 80/60 thresholds already used elsewhere). Click any cell on a
  done row → right-side drawer (`inspectorCell` state) shows value,
  confidence, source (via existing `ocr.v2.provenance.*`), AI
  corrections list, bbox JSON, and raw payload. Empty cell → `—`;
  errored file row → `⚠` glyph in every cell. Fulldoc mode collapses
  to a single `full_document` column that carries the joined
  transcript per file (drawer shows the full text).
- **D7 per-file retry** — every row's Actions column has a `↻` button
  wired to `runOne(row, true)` (`isRetry=true` → server sees
  `retry=true` in FormData → OCR-3 temp-0.6 path). Bulk "retry all
  failed" deferred to UI-7b (see Q2).
- **D8 kill v1 batch stopgap** — `OCRWorkspaceV1` import removed from
  `OCRWorkspaceV2.tsx`. Rollback = flip `ENABLE_OCR_WORKSPACE_V2` off
  in `src/lib/featureFlags.ts` → whole workspace switches back to
  `OCRWorkspace.tsx` which still owns its own batch flow.

## Open-Q answers (Q1–Q3)

- **Q1 (export shape)** — chose the v1 shape via reuse of
  `exportOCRBatch(results, "OCR_batch", format)` in
  `src/lib/exportUtils.ts`. That produces: Summary sheet (File / Status /
  Error / one column per scalar field + `(rows in <name>)` column per
  table field) plus one sheet per detected table field with a
  `Source File` column. No avg-confidence / total-credits footer row —
  operators asked for raw data-first spreadsheets historically. JSON
  export drops the whole `{file, status, error, data}[]` array so
  post-processors don't lose confidence sub-fields.
- **Q2 (retry all failed)** — deferred to UI-7b. Reason: touch-once
  retry from the row action button is enough to unblock the common
  case and the UI-7 spec explicitly labels bulk retry as "field-level
  retry / bulk retry" territory. Follow-up ticket to open.
- **Q3 (template hint mismatch)** — no pre-run inline warning.
  Rationale: cheap check is impossible without extracting first; per-
  file layout mismatch surfaces as low confidence in the spreadsheet
  (already colour-banded amber/red) and the drawer's provenance line
  reads "Crop pass returned null — falling back to whole-image result"
  when the hint didn't hit. Users see the signal without an extra
  pre-run dialog. Bulk warn deferred to UI-7b if operators actually
  complain.

## State model (as implemented)

```ts
type BatchFile = {
  id: string;
  file: File;                              // reassigned after DOCX flatten
  displayName: string;
  previewUrl: string | null;
  pdfRaster: PdfRasterResult | null;
  pageCount: number;
  selectedPages: number[];                 // default = 1..min(pageCount, PAGE_SELECTION_MAX)
  result: OCRResult | null;
  fulldocResult: { pages: { page: number; text: string }[] } | null;
  status: "pending" | "extracting" | "done" | "error";
  error?: string;
  progress: number;                        // 0..100 during "extracting"
  attempt: "initial" | "retry";
};

const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
const [activeBatchFileId, setActiveBatchFileId] = useState<string | null>(null);
```

Nearly the shape the brief proposed — added `pageCount` (needed for
tab labels + over-cap check) and `progress` (row progress display
during sequential extraction). Kept `file` mutable so DOCX conversion
can swap in the flattened PNG.

## Per-file lifecycle (as implemented)

```
addFiles(FileList) ── async ──────────────────────────┐
                                                      ▼
pending  ──enrichRowAsync──►  pending (raster ready, thumbnail + pageCount)
                                                      ▼
                              user picks pages tab / edits selectedPages
                                                      ▼
runAll() (or retryOne(id))                             │
   │ await runOne(row, false)                          │
   ▼                                                   │
extracting (progress 15 → 35 → 55 → poll +5/tick → 100) ─┬─► done  (result set, spreadsheet renders)
                                                        └─► error (error set, ⚠ glyph across row)
                                                             │
                              row action ↻ ─► retryOne(id) ──┘   (attempt = "retry")
```

Between iterations of `runAll`, a `setTimeout` waits
`BATCH_INTER_FILE_DELAY_MS = 500` ms.

## Credit-charge semantics (verify: matches v1)

Confirmed: `runOne` fires `/api/upload` per file. The backend
`chargeCreditsAtomic` runs per request, so a mid-batch failure leaves
earlier files charged (as noted in the guardrails). AI-side failure
still refunds via `refundCreditsAtomic` on the server (API-4b
pattern). Nothing on the client changed for that path.

## Verify

- `npx tsc --noEmit` → exit 0.
- `npm run build` → clean, 43 routes still present (same route list
  as HEAD; no route added or lost).
- v1 `OCRWorkspace.tsx` md5 = `4ae60c50a0fe59a57d994350c2cd44d5`
  (identical to `git show HEAD:src/components/OCRWorkspace.tsx`).

## Regression gate

Baseline `pm/reports/OCR-2-runs/_baseline.json` did NOT need a re-run.
Rationale: UI-7 touches only the client-side batch UI; it uses the
same `/api/upload` shape as single-file (already covered by the
baseline). No prompt, profile, crop pipeline, or server extraction
code changed. Server logs will still show
`prompt_profile=layoutScan/v2026-07-12-v2` for every batch call.

## Manual walkthrough sketch (for PM UAT)

1. **Upload** — flip topbar to "หลายไฟล์". Drop 3 files
   (mix PDF multi-page + image). Queue shows each row with page count.
   Click **ต่อ: เลือกหน้า**.
2. **Pages** — horizontal file tabs. Click file 2, uncheck page 3.
   Click file 3, watch that "auto = 1..5" already applied. If any file
   has > 5 pages, its tab shows `⚠` and the Next-Fields CTA is
   disabled until the user reduces the count.
3. **Fields** — dropdown to pick a template (or leave "— ไม่มี template
   —" and edit the shared field list manually). Toggle to fulldoc for
   whole-doc transcription across every file. Click **ต่อ: รัน**.
4. **Run** — credit box shows total; per-file breakdown table below
   lists every file / its page count / its progress. Click
   **รันทุกไฟล์** → CreditConfirmDialog opens showing per-file rows +
   a Total row. Confirm.
5. **Results** — spreadsheet fills row-by-row as each file finishes
   (500 ms gap visible between rows). Click any done cell → drawer on
   the right shows value / confidence / source / corrections / bbox /
   raw. Errored cells show ⚠. Click ↻ in a row's Actions cell → that
   file re-runs (retry temp 0.6).
6. **Export** — one click for Excel, CSV, or JSON. Excel = Summary
   sheet + table sheets exactly like v1's batch export.
7. **Rollback smoke** — flip topbar back to "หนึ่งไฟล์" → v2 single-
   file workspace unchanged. Flip `ENABLE_OCR_WORKSPACE_V2 = false` →
   both flows served by v1.

## Red flags

- **Speed** — sequential + 500 ms delay ≈ `N × (~10 s + 0.5 s)`. A
  10-file batch is ~2 min end-to-end. The run stage shows both a
  per-file progress column and a live "รันซ้ำไฟล์นี้ (done/total)"
  CTA label so users see forward motion. If the operator complains of
  speed we can (a) drop the delay to 250 ms, (b) lift to parallelism
  once S2-4 (per-page parallel pipeline) lands.
- **Fulldoc + batch = high credit cost** — CreditConfirmDialog shows
  a per-file breakdown *plus* the aggregate. That is the crystal-
  clear signal the guardrail asked for. Additional prose in
  `ocr.v2.batch.runNote` warns the user not to close the tab.
- **Rate limit still possible on very large batches** — 500 ms pacing
  is a cheap defence but not a guarantee, especially if the operator
  queues 10 heavy PDFs. Operator guidance: split ≥ 8-file batches
  into two runs. Consider surfacing this in the upload subtitle in a
  follow-up.
- **`chargeCreditsAtomic` per file** — deliberately matches v1
  semantics (if file 5 fails after 1–4 charged, 1–4 stay charged).
  This is loud in the UI: the error row shows ⚠ but the corresponding
  done rows still show ✓. AI-side failures still refund via
  `refundCreditsAtomic` (API-4b).
- **Kill of v1 batch stopgap** — `OCRWorkspaceV1` import gone.
  Rollback path = `ENABLE_OCR_WORKSPACE_V2 = false`, which restores
  both single + batch v1 handling in one flip (verified: page.tsx
  still routes to `<OCRWorkspace/>` under flag OFF).
- **CROP DPI / dual-scale drift risk** — `prepareUpload` in the batch
  view duplicates the OCR-8/8b logic from `OCRWorkspaceV2`. If those
  Rungs get touched again, mirror the change here. Comment placed at
  the top of the function calling this out.

## Benchmark impact

Not run — UI-7 doesn't touch the extraction backend, prompt profile,
crop-scale logic, or the OCR-3 retry path. The single-file
`/api/upload` codepath is unchanged; batch just calls it N times.
Baseline remains locked at `pm/reports/OCR-2-runs/_baseline.json` and
this change should not move it. Re-run the regression harness only if
the batch view starts sending a different FormData shape (it does
not).

## Follow-ups (UI-7b candidates)

- Per-field retry from the drawer (currently only whole-file retry).
- Bulk "retry all failed" CTA on the results header.
- Per-file template override (D2 shared today).
- Live progress bar per row during extract instead of a numeric %.
- Preflight warn if a file's hinted crop misses on all fields (Q3
  bulk warn).
- Configurable `BATCH_INTER_FILE_DELAY_MS` via an env var if operator
  reports RL issues in prod telemetry.
