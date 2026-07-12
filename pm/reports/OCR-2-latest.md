# OCR-2-benchmark — latest benchmark run

**Timestamp:** `2026-07-12T09-44-27-882Z`  
**Config:** `scripts/ocr-regression/cases/benchmark.json`

## Overall score: **88.9%** (+0%)

## Per category

| Category | Cases | Pass rate | Meets threshold | Δ vs prev |
|---|---|---|---|---|
| thai-form | 3 | 100% | 100% | +0% |
| dense | 2 | 100% | 100% | +16.7% |
| landscape | 1 | 0% | 0% | +0% |
| tables | 2 | 100% | 100% | +0% |
| multi-column | 4 | 91.7% | 75% | -8.3% |

## Per case

| Case | Category | Runs | Pass rate | Threshold | Status | Guards |
|---|---|---|---|---|---|---|
| multiline-join | thai-form | 3/3 | 100% | 80% | ✅ | docs/OCR_TESTING_LOG.md#21-multi-line-value-ถูกตัดเหลือบรรทัดเดียว |
| prefix-retention | thai-form | 3/3 | 100% | 80% | ✅ | docs/OCR_TESTING_LOG.md#22-prefix-dropping |
| thai-dense-multiline-repro | thai-form | 3/3 | 100% | 70% | ✅ | pm/reports/OCR-2.md#case-6--real-page1-multiline |
| dense-22-row-table | dense | 3/3 | 100% | 70% | ✅ | pm/reports/OCR-6.md |
| dense-sibling-blend | dense | 3/3 | 100% | 70% | ✅ | pm/reports/OCR-6b.md |
| landscape-sibling-labels | landscape | — | — | — | ⏭ skipped: fixture file absent | pm/reports/OCR-6b.md |
| landscape-a4-widefield | landscape | 0/3 | 0% | 80% | 🔴 | pm/reports/OCR-6c.md |
| tables-3col-inventory | tables | 3/3 | 100% | 70% | ✅ | docs/BEHAVIOR_REFERENCE.md — table credit branch |
| tables-rowheader-summary | tables | 3/3 | 100% | 70% | ✅ | docs/BEHAVIOR_REFERENCE.md — table credit branch |
| column-disambiguation | multi-column | 3/3 | 100% | 80% | ✅ | docs/OCR_TESTING_LOG.md#14-ai-ตีความคำใกล้เคียง |
| multicolumn-2col-thai | multi-column | 3/3 | 100% | 80% | ✅ | docs/OCR_TESTING_LOG.md#14-ai-ตีความคำใกล้เคียง |
| verbatim-plastelet | multi-column | 2/3 | 66.7% | 80% | 🟡 | docs/OCR_TESTING_LOG.md#11-ai-แกตัดคำเอง |
| corrections-recieve | multi-column | 3/3 | 100% | 80% | ✅ | docs/OCR_TESTING_LOG.md#11-ai-แกตัดคำเอง |

_Legend: ✅ meets threshold · 🟡 mitigated but marginal · 🔴 below half of threshold · ⏭ skipped._

_Raw per-run values in `pm/reports/OCR-2-runs/*-2026-07-12T09-44-27-882Z.json`._
