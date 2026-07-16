# OCR-9 — Same-name field on multiple pages returns only page-1 value

**Sprint:** Sprint 2 (tail) | **Agent:** ocr-pipeline
**Deploy state at start:** `34f5dc3e` live
**Status:** 👀 review (shared-rules change + fixture + benchmark case landed; benchmark run pending PM deploy)

## Bug (UAT 2026-07-15 item #7)

PDF contains the same field label (e.g. "เลขที่เอกสาร") on 2 pages with different values. AI returns only the page-1 value; the page-2 value is silently dropped.

Root cause: response schema is single-value per field (`result[fieldName] = { value, ... }`). The multi-image `generateContent` call sees both pages but the model collapses to one value because the schema forces a single string.

## Option A vs Option B — decision

Two paths considered:

| | A — Structural multi-value schema | B — Prompt rule: joined string |
|---|---|---|
| Change | `result[field] = { values: [{page, value}, ...] }` + BC alias `.value = values[0].value` | Shared rule: model returns `[หน้า 1: X \| หน้า 2: Y]` in the existing single-value field |
| UI ripple | Single-file panel + batch spreadsheet must both learn a new shape | None — string renders as-is |
| Backward compat | New shape + alias, but exports/JSON API consumers break | Fully additive; value type unchanged |
| Data fidelity | High — structured, machine-readable | Low — user parses visually / regex |
| Effort | Large (schema, 2 UI surfaces, tests) | Small (rule string + version bump) |
| Fix time | ~1 sprint | ~1 hour + benchmark |

**Chosen: Option B** for this task, per the task brief. Fast, targeted, no schema/UI disruption. If PM wants structured multi-value later, open follow-up ticket **OCR-9b** — this rule is easy to remove because the model reverts to single-value when the rule is stripped.

## Code changes

### 1. `src/lib/promptProfiles/sharedRules.ts`

- Bumped `SHARED_RULES_VERSION`: `2026-07-12-v2` → `2026-07-15-v3`
- Added rule (Thai) inside `SHARED_RULES_TH`, placed just before the existing multi-scale rule:

  ```
  - ถ้า field ที่ระบุปรากฏหลายหน้าและค่าต่างกัน: คืน value ทุกค่าคั่นด้วย " | " โดยระบุหน้าไว้ข้างหน้าแต่ละค่า เช่น "[หน้า 1: XYZ-001 | หน้า 2: XYZ-002]". ถ้าค่าเหมือนกันทุกหน้า ให้คืนค่าเดียว (ไม่ต้องใส่ "[หน้า ...]" prefix)
  ```

- Comment header notes the bump reason and points to this report.

Rule shared by all 4 field profiles (extractFields, layoutScan, verbatimTranscribe, compare — all import `SHARED_RULES_TH` per S2-2 canonical-source design). No per-profile edit required.

### 2. Fixture

- New folder: `test_fixtures/regression/multi-page/`
- New HTML: `test_fixtures/regression/multi-page/multipage-same-field-different-values.html`
  - 2 pages via `page-break-before: always`
  - Same label "เลขที่เอกสาร" on both pages, different values `DOC-001` (p1) and `DOC-002` (p2)
  - Realistic Thai form layout (label + underlined value + body paragraph mentioning the doc number to give the model context)
  - Same-value fields on both pages (วันที่, ผู้ส่ง) as a sanity guard — the "if identical, return single value" clause in the rule should keep those from being pagified

- `scripts/ocr-regression/generate-fixtures.mjs`: added `"multi-page"` to `CATEGORIES` array so the generator picks up the folder. No landscape flag (portrait A4 default).

### 3. `scripts/ocr-regression/cases/benchmark.json`

- New category entry `multi-page` in `categories{}`
- New case `multipage-same-field-different-values`:
  - `assertion: "multiline"` with `expected.lines: ["DOC-001", "DOC-002"]`
  - `min_pass_rate: 0.66` (2-of-3 acceptance per brief; model may not always page-tag consistently, but must contain both values)
  - `guards_issue: "pm/reports/OCR-9.md"`

Assertion choice: `multiline` was picked because its check is exactly what we need — both substrings must appear in the returned string, and they must be separated (not concatenated). The `[หน้า 1: DOC-001 | หน้า 2: DOC-002]` output satisfies both conditions (separator `" | "` exists between the two values after whitespace-normalization).

## Verify (in-repo)

- `npx tsc --noEmit` — exit 0 (clean)
- `npm run build` — clean, all 43 routes emitted
- `git status` confirms `src/components/OCRWorkspace.tsx` untouched (v1 FROZEN respected)
- Only 1 code file modified: `src/lib/promptProfiles/sharedRules.ts` (+7 lines / -1 line)

## Post-deploy verification plan (PM to run after deploy)

```
node scripts/ocr-regression/generate-fixtures.mjs --category multi-page
node scripts/ocr-regression/run.mjs \
  --config scripts/ocr-regression/cases/benchmark.json \
  --case multipage-same-field-different-values \
  --runs 3
```

**Acceptance:** value contains BOTH `"DOC-001"` and `"DOC-002"` in ≥ 2 of 3 runs (≥ 66% pass rate as encoded in `min_pass_rate`).

**Prerequisite:** template pointed to by env `OCR_E2E_REGRESSION_TEMPLATE` must include a field named exactly `"เลขที่เอกสาร"` (no bbox_hint required — this test is about multi-page collapse, not crop legibility). If not present, PM must add the field to that template row in D1 (or point env var at a template that has it) before running.

**Baseline regression gate — MANDATORY before flip-live:**

```
node scripts/ocr-regression/run.mjs \
  --config scripts/ocr-regression/cases/benchmark.json
```

Full 13-case benchmark must remain ≥ 91.7% case-level (S2-1 baseline) — content-level pass must not drop. The new rule is additive; risk is that the model over-applies the "[หน้า N: ...]" prefix on single-page docs. Watch specifically: `multiline-join`, `prefix-retention`, `dense-sibling-blend`, `landscape-a4-widefield` (all `multiline` assertion cases — most likely to false-positive the format if the model gets confused). If any regression, first hypothesis is over-triggering — tighten the rule with an example of when NOT to prefix.

## Follow-ups (not done here)

- **OCR-9b (open if PM wants structured shape):** change response shape to `values: [{page, value}, ...]` with BC `.value = values[0].value`. Ripple: single-file result panel, batch spreadsheet cell renderer, JSON export, `/api/v1/extract` schema doc, downstream consumers. Estimate: 1 sprint.
- If the joined-string format catches on with users, consider a helper in the batch export that splits `[หน้า N: ...]` back into per-page columns.
- v1 `OCRWorkspace.tsx` will render the joined string as-is (no code change needed) — FROZEN status preserved.

## Files touched

- `src/lib/promptProfiles/sharedRules.ts` (rule + version bump)
- `scripts/ocr-regression/generate-fixtures.mjs` (added `multi-page` to CATEGORIES)
- `scripts/ocr-regression/cases/benchmark.json` (new category + new case)
- `test_fixtures/regression/multi-page/multipage-same-field-different-values.html` (new)
- `pm/reports/OCR-9.md` (this report)
- `pm/BOARD.md` (row added under Sprint 2 tail)
