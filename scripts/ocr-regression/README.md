# ocr-regression — S2-1 benchmark-style regression suite

Purpose: variance-aware pass-rate scoring for the OCR pipeline across 5 benchmark categories. Every prompt/config change must be re-run through this suite before ship.

Origin: extended from the OCR-2 scaffold (Session 2026-07-06). S2-1 grew it into a benchmark shape per `docs/080726/OCR_IMPROVEMENT_TECHNIQUES_KB.md` §3.

## Categories

| Category | Cases | Regression class guarded |
|---|---|---|
| `thai-form` | 3 | Multi-line, prefix retention, dense Thai forms (OCR-2 §2.1 / §2.2, OCR-6 real-page1-multiline P0) |
| `dense` | 2 | Content-density attention dilution (OCR-6), sibling-label blend on dense grids (OCR-6b) |
| `landscape` | 2 | Letterbox coordinate remap on A4 landscape (OCR-6c) |
| `tables` | 2 | Structured table extraction, `type === "table"` credit branch |
| `multi-column` | 4 | Columnar disambiguation, verbatim, corrections reporting (OCR-2 §1.1 / §1.4) |

Total: **13 cases**, default 10 runs each → 130 runs per full suite invocation.

Full case list: `scripts/ocr-regression/cases/benchmark.json` (`categories{}` + `cases[]`).

## Files

- `run.mjs` — runner. Auto-detects benchmark vs legacy config shape.
- `generate-fixtures.mjs` — Playwright HTML→PDF renderer. Recurses category subfolders. Landscape category rendered A4 landscape.
- `smoke-config.mjs` — parses a config + prints the plan. No browser, no network. Use to catch JSON/schema errors before burning credits.
- `cases/benchmark.json` — S2-1 benchmark config (13 cases, 5 categories).
- `cases/ocr-2.json` — legacy OCR-2 config (5 cases). Kept working for back-compat.
- `cases/ocr-6b.json` — legacy OCR-6b landscape case.

## Prereqs

Same as `scripts/ocr-e2e/` — Playwright + `.env.local` creds. See `scripts/ocr-e2e/README.md`. Env vars used by `benchmark.json`:

```
OCR_E2E_BASE_URL=http://localhost:8788
OCR_E2E_EMAIL=<dev/test account>
OCR_E2E_PASSWORD=<dev/test account>

# Templates (each must contain the fields listed by cases in that category).
# See "How to add a case" for the field/template pairing rules.
OCR_E2E_REGRESSION_TEMPLATE=<thai-form + multi-column fields, NO bbox_hint on disambiguation targets>
OCR_E2E_DENSE_TEMPLATE=<dense fields ผู้จัดทำ + ศูนย์ผู้รับ>
OCR_E2E_LANDSCAPE_TEMPLATE=<landscape field ชื่อและรหัสศูนย์รับผิดชอบ, with bbox_hint>
OCR_E2E_TABLE_TEMPLATE=<InventoryTable + SummaryTable, both type=table>
```

If a template env var is unset, its cases are **skipped** (not failed). If `OCR_E2E_TABLE_TEMPLATE` is unset the whole `tables` category is skipped.

## Running

```bash
# 1. Generate PDF fixtures (deterministic; re-runs on HTML edits)
node scripts/ocr-regression/generate-fixtures.mjs
#    Or single category:
node scripts/ocr-regression/generate-fixtures.mjs --category thai-form

# 2. Start the app
npm run preview

# 3. Run the full benchmark
node scripts/ocr-regression/run.mjs --config scripts/ocr-regression/cases/benchmark.json

# 3b. Filter
node scripts/ocr-regression/run.mjs \
  --config scripts/ocr-regression/cases/benchmark.json \
  --category dense \
  --runs 5

# 3c. Single case, verbose
node scripts/ocr-regression/run.mjs \
  --config scripts/ocr-regression/cases/benchmark.json \
  --case multiline-join --runs 3 --log verbose

# 3d. CI gate example (fail on regressions)
node scripts/ocr-regression/run.mjs \
  --config scripts/ocr-regression/cases/benchmark.json \
  --fail-under 0.7
```

Dry-run (parse + print plan, no browser):

```bash
node scripts/ocr-regression/run.mjs --config scripts/ocr-regression/cases/benchmark.json --dry-run
```

## Output & scoring

Every invocation writes:

- `pm/reports/OCR-2-runs/<caseId>-<timestamp>.json` — raw per-case, one file per case.
- `pm/reports/OCR-2-runs/_summary-<timestamp>.json` — suite roll-up: overall score, per-category pass rate, meets-threshold flag, delta vs previous run.
- `pm/reports/OCR-2-latest.md` — 30-second human-readable snapshot (overwritten each run).

### Scoring rubric

- **Per-case pass rate** = `passing runs / total runs`.
- **Per-category pass rate** = arithmetic mean of case pass rates in that category.
- **Overall score** = pooled pass rate across all runs (`total passing runs / total runs`).
- **Meets threshold** = per-case rate `>= min_pass_rate` (default 0.8; each case can override).

Legend in the Markdown report:

- ✅ meets threshold
- 🟡 mitigated but marginal (>= half of threshold)
- 🔴 below half of threshold — likely regression
- ⏭ skipped (template unset, fixture absent for a `skip_if_missing` case, or unknown assertion)

### Delta vs previous run

If a `_summary-*.json` already exists in `pm/reports/OCR-2-runs/`, the newer run's Markdown report shows Δ per category + overall. Use to catch prompt-drift regressions across sprints.

## Config schema (benchmark shape)

Top level:

```jsonc
{
  "suite": "OCR-2-benchmark",
  "version": "1.0.0",
  "defaults": {
    "templateName": "${OCR_E2E_REGRESSION_TEMPLATE}",
    "runs": 10,
    "min_pass_rate": 0.8
  },
  "categories": {
    "<id>": { "label": "...", "description": "..." }
  },
  "cases": [ ... ]
}
```

Per case:

```jsonc
{
  "id": "kebab-case-unique-id",
  "category": "one of the keys in categories{}",
  "fixture": "test_fixtures/regression/<cat>/generated/<slug>.pdf",
  "template": "${OCR_E2E_..._TEMPLATE}",   // interpolated from env
  "field": "field name as it appears in the template",
  "assertion": "verbatim | prefix | multiline | disambiguation | corrections_report | table_structure",
  "expected": { /* shape depends on assertion, see run.mjs ASSERTIONS */ },
  "min_pass_rate": 0.8,                    // optional override, default from defaults
  "runs": 10,                              // optional override
  "guards_issue": "docs/... or pm/reports/...#anchor",  // required link back to the failure this guards
  "skip_if_missing": false,                // if true, absent fixture file = SKIP not FAIL
  "notes": "human-readable context"
}
```

### Assertion specs

| Assertion | `expected` fields |
|---|---|
| `verbatim` | `expected: string` |
| `prefix` | `expected: string`, `prefix: string` |
| `multiline` | `lines: string[]`, optional `mustNotContain: string[]`, optional `provenanceExpected: "crop"` |
| `disambiguation` | `expected: string` (target), `sibling: string` (fail if equals) |
| `corrections_report` | `original: string`, `corrected: string` — silent correction = FAIL |
| `table_structure` | `rows: string[][]` — row-by-row containment match with whitespace tolerance |

## How to add a case

1. Drop `<slug>.html` under `test_fixtures/regression/<category>/`. Categories: `thai-form`, `dense`, `landscape`, `tables`, `multi-column`.
2. Append a case entry to `scripts/ocr-regression/cases/benchmark.json` with:
   - a `category` that already exists in `categories{}`
   - a `guards_issue` link to the sprint issue / testing-log section / PM report it protects against
   - `fixture` path pointing to `test_fixtures/regression/<category>/generated/<slug>.pdf`
3. If your assertion is new, add it to `ASSERTIONS` in `run.mjs`.
4. Update `test_fixtures/regression/README.md` (fixture manifest).
5. Regenerate PDFs: `node scripts/ocr-regression/generate-fixtures.mjs --category <cat>`.
6. Smoke-check: `node scripts/ocr-regression/smoke-config.mjs scripts/ocr-regression/cases/benchmark.json` — should still say "Smoke OK." with your new case counted.

## Blocker section (why the suite is not running yet)

S2-1 is **design + code only**. Executing the suite requires:

1. **Playwright installed** (approved in Sprint 1 as devDependency, not yet installed):
   ```bash
   npm install --save-dev @playwright/test
   npx playwright install chromium
   ```
2. **`.env.local` credentials** (see the block above). At minimum: `OCR_E2E_EMAIL`, `OCR_E2E_PASSWORD`, and the template env vars whose categories you want to score. Missing template vars = category skipped, not error.
3. **Dev/test templates set up** on the account with the required fields:
   - Regression template: `Product`, `หน่วยงาน`, `ผู้รับโอน`, `Receiver`, `ผู้รับ`, `Action` — **no `bbox_hint`** on `Receiver` / `ผู้รับ` (disambiguation trivially passes with a hint).
   - Dense template: `ผู้จัดทำ`, `ศูนย์ผู้รับ`.
   - Landscape template: `ชื่อและรหัสศูนย์รับผิดชอบ` with `bbox_hint`.
   - Tables template: `InventoryTable`, `SummaryTable`, both `type: "table"`.
4. **Credit budget** on the dev account. Default full run = 13 cases × 10 runs ≈ **130 credits + ~20 buffer**. Use `--runs 3` for spot checks (~40 credits).
5. **Thai font on the dev machine** — the two Thai categories need a Thai-capable font (`Sarabun` / `Noto Sans Thai` / `TH Sarabun New`) or the HTML→PDF step renders boxes.
6. **v2 workspace flag ON** (already the case in prod). The harness targets the real `/ocr` v2 UI selectors. If v2 is toggled OFF, `runOcrCase` may fail to find the extract CTA — see `scripts/ocr-e2e/harness.mjs`.

## Why NOT `/api/v1/extract`

`/api/v1/extract` skips the client-side PDF→3600px PNG conversion. Server-side and client-side conversions produce **different bytes** for the model (`docs/OCR_TESTING_LOG.md` §2.4). All qa-tester runs go through the real UI. `v1/extract` also lacks bbox_hint support (see OCR-4 decision).

## Backward compatibility

The runner still accepts the legacy shape (`cases[]` with `assertion` + `expect` fields). `cases/ocr-2.json` and `cases/ocr-6b.json` continue to work unchanged — invoke with `--config <legacy.json>` as before.
