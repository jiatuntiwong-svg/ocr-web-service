# OCR-2 — Prompt regression suite

**Status:** 🚫 BLOCKED (infrastructure + fixtures scaffolded; execution requires operator handoff — same blocker set as TEST-1)
**Owner:** qa-tester agent
**Sprint:** OCR Stabilization
**Related:** `docs/OCR_TESTING_LOG.md` §1 & §2, `pm/tasks/ocr-pipeline.md` §OCR-2, `pm/reports/TEST-1.md`

---

## Needed to execute (operator action list)

Identical to TEST-1 items 2–4, plus one OCR-2-specific env var:

1. **Playwright install** (shared with TEST-1) — not yet in `package.json`. Approve and run:
   ```bash
   npm install --save-dev @playwright/test
   npx playwright install chromium
   ```
2. **Dev/test credentials** in `.env.local`:
   ```
   OCR_E2E_BASE_URL=http://localhost:8788
   OCR_E2E_EMAIL=<dev/test account email>
   OCR_E2E_PASSWORD=<dev/test account password>
   OCR_E2E_REGRESSION_TEMPLATE=<template with the 5 target fields, NO bbox_hint on "Receiver">
   ```
   Credit budget: 5 cases × 3 runs × ≈1 credit each = **≥ 15 credits** on the dev account. Add ≈5 buffer for retries.
3. **Preview server up** — `npm run preview` in one shell, then in another:
   ```bash
   node scripts/ocr-regression/generate-fixtures.mjs      # one-time (regenerates on HTML changes)
   node scripts/ocr-regression/run.mjs --config scripts/ocr-regression/cases/ocr-2.json
   ```
4. **Thai font on the dev machine** — `verbatim` and Thai-language fixtures need a Thai-capable font (`Sarabun` / `Noto Sans Thai` / `TH Sarabun New`) so the HTML→PDF step produces readable glyphs. Windows 10 ships with `Leelawadee UI`; the fallback stack should still work but confirm the generated PDFs look right before running the suite.

Once the runner writes `pm/reports/OCR-2-runs/*.json`, paste the pass rates and per-run raw values into the tables below.

---

## Reconciliation: UI harness vs `/api/v1/extract`

The task spec says "runs the known failure cases against `/api/v1/extract`". This is in tension with qa-tester rule #1 (never POST raw files to the API and call it an OCR test — client conversion matters).

**Chosen path: UI/Playwright harness** (spec's preferred option).

Justification:
1. **Consistency** — TEST-1 already exercises the real UI; reusing the same harness (with a small `withCorrections` extension) keeps the whole test surface identical and eliminates apples-vs-oranges when comparing runs.
2. **PDF→3600px conversion matters for the multi-line case** — `multiline-join.html` is intentionally rendered as a form-like PDF. The 3600px client rasterization at `src/components/OCRWorkspace.tsx:615` is what the model actually sees in production; `v1/extract` skips it.
3. **`corrections[]` is a UI-rendered artifact** — the harness already scrapes the badge (`OCRWorkspace.tsx:1966`). The `v1/extract` response schema may not be identical (needs verification per OCR-4 note that v1 diverged before), so scoring the "corrections reporting" case via the UI is unambiguous.
4. **bbox_hint / disambiguation** — `v1/extract` does NOT get bbox_hint per OCR-4 decision. Even if we ran disambiguation without a hint (as we do), the base prompt paths have diverged before; scoring via UI matches what real users experience.

**Not chosen: direct `/api/v1/extract` path.** Would only be safe for fixtures that are already PNG at ≈3600px. Since we're generating PDFs from HTML (deterministic + easy to add cases), the UI path costs nothing extra and eliminates the conversion-divergence footgun.

---

## Case matrix

Baseline: 5 cases × 3 runs = 15 runs per suite invocation.

| # | Case ID | Fixture | Issue | Assertion | Expected value |
|---|---|---|---|---|---|
| 1 | `verbatim-plastelet` | `test_fixtures/regression/generated/verbatim-plastelet.pdf` | 1.1 | verbatim | `Plastelet` (or corrections[] entry) |
| 2 | `prefix-retention` | `test_fixtures/regression/generated/prefix-retention.pdf` | 2.2 | prefix | starts with `คลัง` |
| 3 | `multiline-join` | `test_fixtures/regression/generated/multiline-join.pdf` | 2.1 | multiline | both lines, `\n`-joined |
| 4 | `column-disambiguation` | `test_fixtures/regression/generated/column-disambiguation.pdf` | 1.4 | disambiguation | `Warehouse B` (not `Warehouse A`) |
| 5 | `corrections-recieve` | `test_fixtures/regression/generated/corrections-recieve.pdf` | 1.1 | corrections_report | `recieve` OR `receive` + corrections entry |

### Case 4 — bbox_hint policy note

The disambiguation case is **run WITHOUT `bbox_hint` on the `Receiver` field**. Rationale: if a spatial anchor covers only the target column, the model trivially picks the right value and there is no regression signal. The failure this test guards against is the pre-Session-2026-07-02 behavior where the label-match prompt confused two adjacent columns.

If a future run wants to measure disambiguation under both conditions, add a `column-disambiguation-with-hint` case with a template variant that has the hint drawn, and record both pass rates side-by-side.

---

## Environment (fill in per run set)

| Field | Preview run | Production confirm |
|---|---|---|
| Date | | |
| Build hash | | |
| Env | `npm run preview` (workerd) | production |
| Base URL | http://localhost:8788 | https://<prod> |
| Credits at start | | |
| Template name | | |
| Deployed prompt commit | | |

---

## Results

Legend: paste the actual raw string returned by the model in each row. Do NOT paste ✅/❌ only.

### Case 1 — `verbatim-plastelet`  (issue 1.1)

Expected: `Plastelet` (verbatim) OR any value + a `corrections[]` entry whose `original` includes `Plastelet`.

| Run | Returned value | corrections[] | Pass? | Notes |
|---|---|---|---|---|
| 1 | | | Y / N | |
| 2 | | | Y / N | |
| 3 | | | Y / N | |

**Pass rate: __ /3**

---

### Case 2 — `prefix-retention`  (issue 2.2)

Expected: starts with `คลัง`, full string `คลังภาคบริการโลหิตแห่งชาติที่ 7 จ.อุบลราชธานี`.

| Run | Returned value | Starts with `คลัง`? | Pass? | Notes |
|---|---|---|---|---|
| 1 | | Y / N | Y / N | |
| 2 | | Y / N | Y / N | |
| 3 | | Y / N | Y / N | |

**Pass rate: __ /3**

---

### Case 3 — `multiline-join`  (issue 2.1)

Expected: `คลังภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี\nวัตถุดิบและงานระหว่างทำ` (literal `\n`, both lines present).

| Run | Returned value | Both lines? | `\n`-joined? | Pass? | Notes |
|---|---|---|---|---|---|
| 1 | | Y / N | Y / N | Y / N | |
| 2 | | Y / N | Y / N | Y / N | |
| 3 | | Y / N | Y / N | Y / N | |

**Pass rate: __ /3**

---

### Case 4 — `column-disambiguation`  (issue 1.4, no bbox_hint)

Expected: `Warehouse B`. Fail modes: `Warehouse A` (sibling column) or anything else.

| Run | Returned value | Which column? | Pass? | Notes |
|---|---|---|---|---|
| 1 | | Target / Sibling / Other | Y / N | |
| 2 | | Target / Sibling / Other | Y / N | |
| 3 | | Target / Sibling / Other | Y / N | |

**Pass rate: __ /3**

---

### Case 5 — `corrections-recieve`  (issue 1.1)

Pass = (a) value = `recieve` with empty corrections[], OR (b) value = `receive` AND corrections[] contains `{ original: "recieve", corrected: "receive" }`. Fail = value = `receive` with empty corrections[] (silent correction).

| Run | Returned value | corrections[] entry | Pass? | Notes |
|---|---|---|---|---|
| 1 | | | Y / N | |
| 2 | | | Y / N | |
| 3 | | | Y / N | |

**Pass rate: __ /3**

---

## Pass-rate summary — **pending execution**

_This block is populated by the runner's `_summary-*.json` output once the operator supplies credentials + runs the suite. Do not fill it manually from spot checks._

| Case | Pass rate | Regression? |
|---|---|---|
| verbatim-plastelet | pending | pending |
| prefix-retention | pending | pending |
| multiline-join | pending | pending |
| column-disambiguation | pending | pending |
| corrections-recieve | pending | pending |

Rule of thumb for "regression?":
- ≥ 2/3 → 🟢 within variance floor of Session 2026-07-02 baseline
- 1/3 → 🟡 mitigated but marginal — investigate prompt drift
- 0/3 → 🔴 regressed — block ship

---

## What was built (this pass)

| Artifact | Path | Purpose |
|---|---|---|
| Runner | `scripts/ocr-regression/run.mjs` | Iterates cases, applies typed assertions, writes per-case + summary JSONs. Reuses TEST-1 harness. |
| Fixture generator | `scripts/ocr-regression/generate-fixtures.mjs` | Playwright HTML→PDF renderer (deterministic, no new deps). |
| Case config | `scripts/ocr-regression/cases/ocr-2.json` | 5 baseline cases with assertion types. |
| Script README | `scripts/ocr-regression/README.md` | Operator run instructions + reconciliation restated. |
| Fixture sources | `test_fixtures/regression/*.html` | 5 synthetic form-like docs, commit-safe. |
| Fixture README | `test_fixtures/regression/README.md` | What each fixture demonstrates, generation instructions. |
| Harness extension | `scripts/ocr-e2e/harness.mjs` | Added `withCorrections` mode returning `{ value, corrections }`. Backward-compatible with TEST-1 (default off). |

Design notes:
- Runner does NOT overwrite `OCR-2.md`. It writes machine-readable JSON and prints a summary; the operator hand-merges pass rates into the tables above. This keeps the human report editable without stomping annotations.
- Assertions are pure functions in `run.mjs` (`ASSERTIONS` map). Adding a new failure class is: new fixture HTML + new case entry + new assertion function. No harness changes.
- HTML sources are the source of truth; generated PDFs are gitignore-eligible (regeneration is deterministic).

---

## Case 6 — real-page1-multiline (manual run by operator, 2026-07-06)

Field `ผู้รับโอน`, template with hint. Expected: `คลังภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี\nวัตถุดิบและงานระหว่างทำ`

| Doc | Run | Returned value | Both lines? |
|---|---|---|---|
| เอกสารที่ 1 | 1 | `คลังภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี` | N |
| เอกสารที่ 1 | 2 | `คลังภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี` | N |
| เอกสารที่ 1 | 3 | `คลังภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี` | N |
| เอกสารที่ 2 | 1 | ครบ 2 บรรทัด | Y |
| เอกสารที่ 2 | 2 | ครบ 2 บรรทัด | Y |
| เอกสารที่ 2 | 3 | ครบ 2 บรรทัด | Y |

**Pass rate: doc1 = 0/3, doc2 = 3/3**

**PM analysis:** ผลเสถียร 100% ทั้งสองทาง (0/3 vs 3/3) → **ไม่ใช่ Gemini variance** แต่เป็น deterministic per-document

**Follow-up 2026-07-06:**
- ระบุเอกสารแล้ว: doc1 = หน้า 1/3 (ตาราง 22 รายการ หนาแน่น), doc2 = หน้า 2/3 (13 รายการ + ที่ว่างเยอะ) — ฟอร์มเดียวกัน header เหมือนกัน ค่า `ผู้รับโอน` เหมือนกัน
- **Hint-coverage theory: ตัดทิ้ง** — operator วาด hint กว้างคลุมถึง `วันที่จ่าย` แล้ว doc1 ยังพลาดเหมือนเดิม
- **ทฤษฎีคงเหลือ: content density** — ภาพหน้าแน่นดึง attention จนโมเดลตัดบรรทัด 2 ทิ้ง; prompt/hint แก้ไม่ได้
- **Next: crop validation test** — operator crop เฉพาะ header block ของ doc1 เป็นภาพ อัปโหลดรันตรง; ถ้าครบ 2 บรรทัด → GO สำหรับ crop-based extraction (OCR-6)

_(Paste anomalies, latency spikes, unexpected corrections[] shapes, credit consumption per run, screenshots if useful.)_

---

_Scaffold author: qa-tester agent, 2026-07-06_
