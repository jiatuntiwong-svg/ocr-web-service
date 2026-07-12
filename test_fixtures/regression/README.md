# Regression fixtures — S2-1 benchmark suite

Synthetic form-like documents grouped into 5 benchmark categories per `docs/080726/OCR_IMPROVEMENT_TECHNIQUES_KB.md` §3.

**Commit-safe:** all HTML content is synthetic — no PII, no proprietary data. IDs and names were fabricated. Thai text is real prose but organizational names are illustrative variants of publicly-known Red Cross unit names. The one real fixture (`landscape/landscape-sibling-labels/source.pdf`) is **uncommitted per PII decision** — see its `CASE.md`.

## Layout

```
test_fixtures/regression/
├── thai-form/
│   ├── multiline-join.html                      (OCR-2 issue 2.1)
│   ├── prefix-retention.html                    (OCR-2 issue 2.2)
│   └── dense-multiline-repro.html               (OCR-2 real-page1-multiline P0)
├── dense/
│   ├── dense-22-row-table.html                  (OCR-6 content density)
│   └── dense-sibling-blend.html                 (OCR-6b sibling blend)
├── landscape/
│   ├── landscape-sibling-labels/                (uncommitted real fixture, OCR-6b/6c)
│   └── landscape-a4-widefield.html              (OCR-6c letterbox drift)
├── tables/
│   ├── tables-3col-inventory.html               (type=table credit branch)
│   └── tables-rowheader-summary.html            (row-header table)
└── multi-column/
    ├── column-disambiguation.html               (OCR-2 issue 1.4)
    ├── multicolumn-2col-thai.html               (issue 1.4 on Thai)
    ├── verbatim-plastelet.html                  (OCR-2 issue 1.1)
    └── corrections-recieve.html                 (OCR-2 issue 1.1)
```

Generated PDFs go under `<category>/generated/` (gitignored — regeneration is deterministic from the committed HTML sources).

## Case matrix

| Category | HTML source | Target field | Assertion | Guards |
|---|---|---|---|---|
| thai-form | `thai-form/multiline-join.html` | `ผู้รับโอน` | multiline | OCR-2 §2.1 |
| thai-form | `thai-form/prefix-retention.html` | `หน่วยงาน` | prefix | OCR-2 §2.2 |
| thai-form | `thai-form/dense-multiline-repro.html` | `ผู้รับโอน` | multiline | OCR-2 real-page1-multiline (P0) |
| dense | `dense/dense-22-row-table.html` | `ผู้จัดทำ` | verbatim | OCR-6 content-density |
| dense | `dense/dense-sibling-blend.html` | `ศูนย์ผู้รับ` | multiline (+ mustNotContain) | OCR-6b sibling-label blend |
| landscape | `landscape/landscape-sibling-labels/source.pdf` (real) | `ชื่อและรหัสศูนย์รับผิดชอบ` | multiline | OCR-6b (skip_if_missing) |
| landscape | `landscape/landscape-a4-widefield.html` | `ชื่อและรหัสศูนย์รับผิดชอบ` | multiline | OCR-6c letterbox drift |
| tables | `tables/tables-3col-inventory.html` | `InventoryTable` | table_structure | `type=table` credit branch |
| tables | `tables/tables-rowheader-summary.html` | `SummaryTable` | table_structure | row-header tables |
| multi-column | `multi-column/column-disambiguation.html` | `Receiver` | disambiguation | OCR-2 §1.4 |
| multi-column | `multi-column/multicolumn-2col-thai.html` | `ผู้รับ` | disambiguation | OCR-2 §1.4 (Thai) |
| multi-column | `multi-column/verbatim-plastelet.html` | `Product` | verbatim | OCR-2 §1.1 |
| multi-column | `multi-column/corrections-recieve.html` | `Action` | corrections_report | OCR-2 §1.1 |

## Generating the PDFs

```bash
node scripts/ocr-regression/generate-fixtures.mjs                 # all categories
node scripts/ocr-regression/generate-fixtures.mjs --category dense
node scripts/ocr-regression/generate-fixtures.mjs --dry-run       # plan only
```

Requires Playwright chromium (same as the runner). Outputs go under `<category>/generated/`. Landscape category is rendered A4 landscape automatically.

## Design constraints

- **Font**: HTML relies on system fonts (`Times New Roman` / `Sarabun` fallbacks). If your dev machine lacks a Thai font, the Thai fixtures will render as boxes — install `TH Sarabun New` or `Noto Sans Thai` before generating PDFs.
- **Layout**: form-like tables and grids, high-contrast, 12–18pt+ text — the client-side 3600px conversion at `src/components/OCRWorkspaceV2.tsx` will rasterize this crisply. Dense fixtures deliberately use 9–10pt to reproduce the content-density failure mode.
- **No hint dependency**: `column-disambiguation.html` and `multicolumn-2col-thai.html` MUST be run against a template with NO `bbox_hint` on the target field. Otherwise the spatial anchor trivially disambiguates and there is no regression signal.
- **Table cases**: require template fields of `type: "table"`. If `OCR_E2E_TABLE_TEMPLATE` is unset the runner skips the whole `tables` category.

## Adding a new case

See `scripts/ocr-regression/README.md` § "How to add a case".
