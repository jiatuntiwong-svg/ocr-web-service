# Work orders — qa-tester agent

Sprint: OCR Stabilization. Update pm/BOARD.md status when you start/finish a task.

---

## TEST-1 (P0) — Control test: single-page split of the Thai form

**Goal:** Determine whether the `ผู้รับโอน` extraction failure (see pm/reports/OCR-1.md §Observed run 2026-07-06) is caused by multi-page stacking/cross-page label confusion, or by the bbox_hint mechanism itself.

**Steps:**
1. **Split fixture:** source file is the 7-page bundle "ใบตัดจ่ายภาคฯ 3 รอบที่ 2 ม.ค.69.pdf" (ask the human operator for the file — not yet committed). Use `pdf-lib` in a small script (`scripts/split-pdf.mjs`) to produce:
   - `test_fixtures/thai-form/page1-only.pdf` (page 1)
   - Keep the full bundle as `test_fixtures/thai-form/full-7page.pdf`
   - Commit both (no PII concerns confirmed by operator? ask first — the doc contains staff names).
2. **Harness:** Playwright script (`scripts/ocr-e2e/`) that: logs in (credentials from operator via env vars), opens OCR page, uploads `page1-only.pdf`, selects the existing template (hints already persisted in it), runs extraction, scrapes the `ผู้รับโอน` result value.
3. **Run matrix:**
   - `page1-only.pdf` × 3 runs
   - `full-7page.pdf` × 3 runs (baseline, same session — confirms the failure reproduces)
4. **Record:** results table in `pm/reports/TEST-1.md` + append to docs/OCR_TESTING_LOG.md. Expected value: `คลังภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี\nวัตถุดิบและงานระหว่างทำ`

**Interpretation guide (for the PM decision):**
- page1 ≥ 2/3 ถูก, full-bundle ผิด → multi-page คือตัวการหลัก → API-1/UI-1 เป็น fix จริง
- page1 ≤ 1/3 ถูก → hint mechanism ล้มเหลว → เริ่ม OCR-5 guardrails
- Both pass → ตรวจว่า OCR-4 prompt deploy แล้วหรือยัง (แปลว่า fix ได้ผล)

**Environment:** `npm run preview` + dev user ก่อน (ไม่เปลือง credit); ยืนยันบน production 1 รอบท้ายสุด

**Done when:** `pm/reports/TEST-1.md` filled in with per-run values, environment, build hash.

---

**Future:** this Playwright harness becomes the foundation for OCR-2 (regression suite) — build it reusable (config-driven: file, template, expected values).

---

## OCR-2 addendum (PM, 2026-07-06)

The scaffolded case matrix (5 synthetic fixtures) is missing the P0 case: add `real-page1-multiline` — fixture `test_fixtures/thai-form/page1-only.pdf`, field `ผู้รับโอน`, template with hint (`OCR_E2E_TEMPLATE_NAME`), **10 runs**, assertion = both lines present. This real-document pass rate (not the synthetic one) is the number that decides the self-consistency investment. Synthetic multiline-join stays as a secondary signal.
