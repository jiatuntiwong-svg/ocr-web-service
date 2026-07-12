# TEST-1 — Control test: single-page split of the Thai form

**Status:** 🚫 BLOCKED (infrastructure scaffolded; execution requires operator handoff)
**Owner:** qa-tester agent
**Sprint:** OCR Stabilization
**Related:** pm/reports/OCR-1.md §"Observed run 2026-07-06", pm/tasks/qa-tester.md §TEST-1

---

## Needed to complete (operator action list)

The agent has built all the infrastructure that does not depend on external assets. To finish TEST-1, the operator must supply:

1. **Source PDF** — `ใบตัดจ่ายภาคฯ 3 รอบที่ 2 ม.ค.69.pdf` (the 7-page bundle referenced in OCR-1.md §Observed run 2026-07-06). Not committed. Place anywhere and run:
   ```bash
   node scripts/split-pdf.mjs "<path-to-source.pdf>"
   ```
   That writes `test_fixtures/thai-form/page1-only.pdf` and `test_fixtures/thai-form/full-7page.pdf`.
   **PII decision required:** the doc contains staff names. Confirm before `git add`. Default recommendation: do NOT commit; add `test_fixtures/thai-form/*.pdf` to `.gitignore`.
2. **Playwright install** — not currently in `package.json`. Approve and run:
   ```bash
   npm install --save-dev @playwright/test
   npx playwright install chromium
   ```
   (~200 MB dev dep. Not added blindly.)
3. **Test-account credentials** — must be dev/test account, not production. Add to `.env.local`:
   ```
   OCR_E2E_BASE_URL=http://localhost:8788
   OCR_E2E_EMAIL=<dev/test account email>
   OCR_E2E_PASSWORD=<dev/test account password>
   OCR_E2E_TEMPLATE_NAME=<name of the template with ผู้รับโอน hint already persisted>
   ```
   Credit budget confirmation: 6 runs × ~1 credit/field × N fields — please confirm the dev account has ≥ 30 credits before running.
4. **Preview server up** — in one shell: `npm run preview`. In another: `node scripts/ocr-e2e/run.mjs --config scripts/ocr-e2e/cases/test-1.json`.
5. **Production confirm run** — ONLY after preview passes. 1 run of each case against production.

Once the JSON output lands in `pm/reports/test-1-runs/run-*.json`, transcribe the raw values into the tables below. Do not summarize prematurely.

---

## What was built (this pass)

| Artifact | Path | Purpose |
|---|---|---|
| PDF splitter | `scripts/split-pdf.mjs` | pdf-lib script: page 1 → `page1-only.pdf`, copy source → `full-7page.pdf`. Idempotent, no network. |
| E2E harness (core) | `scripts/ocr-e2e/harness.mjs` | Real UI flow: login → OCR page → template pick → upload → extract → scrape target field. Uses the client-side PDF→3600px PNG path (qa-tester rule #1). |
| E2E runner (CLI) | `scripts/ocr-e2e/run.mjs` | Loads case JSON, runs N iterations per case, writes results JSON. Reads `.env.local` for creds — never hardcodes. |
| Case config | `scripts/ocr-e2e/cases/test-1.json` | Config-driven so OCR-2 (regression suite) reuses the same harness with new case files. |
| README | `scripts/ocr-e2e/README.md` | Operator run instructions + Playwright install steps. |
| Report scaffold | `pm/reports/TEST-1.md` (this file) | Fill-in tables + interpretation rubric. |
| Runs output dir | `pm/reports/test-1-runs/` | Auto-created by runner; JSON per invocation. |

Design notes:
- Harness drives the real UI, so it exercises the `pdfFileToImage` client-side conversion at `src/components/OCRWorkspace.tsx:615` — critical because server-side conversion produced different results (docs/OCR_TESTING_LOG.md §2.4).
- Case JSON supports `${OCR_E2E_TEMPLATE_NAME}` interpolation so template name stays out of the committed file.
- Runner writes per-run raw values (not pass/fail). Fabrication risk is minimized — you either see a value or an error.

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

## Results — page1-only.pdf (single-page control)

Legend: raw string value AI returned. Do NOT paste ✅/❌ only; paste the actual string. Expected: `คลังภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี\nวัตถุดิบและงานระหว่างทำ`

| Run | Returned `ผู้รับโอน` value | Exact match? | Notes |
|---|---|---|---|
| 1 | | Y / partial / N | |
| 2 | | Y / partial / N | |
| 3 | | Y / partial / N | |

**Pass rate: __ /3**

---

## Results — full-7page.pdf (baseline reproduction)

Expected outcome from OCR-1 §Observed run: `ศูนย์บริการโลหิตแห่งชาติ` (wrong, from `ผู้โอน` on pages 4/5/7). Confirms cross-page label confusion still reproduces.

| Run | Returned `ผู้รับโอน` value | Exact match? | Notes |
|---|---|---|---|
| 1 | | Y / partial / N | |
| 2 | | Y / partial / N | |
| 3 | | Y / partial / N | |

**Pass rate: __ /3**

---

## PM interpretation (applied after runs complete)

Apply the rubric from pm/tasks/qa-tester.md §TEST-1:

| Observed | Diagnosis | Sprint action |
|---|---|---|
| page1 ≥ 2/3 pass AND full-7page fails | Multi-page stacking / cross-page label confusion is the culprit | Prioritize **API-1** (page selection param) + **UI-1** (page picker). bbox_hint mechanism itself works. |
| page1 ≤ 1/3 pass | bbox_hint mechanism is fundamentally broken | Start **OCR-5** (hint guardrails: bbox-overlap validation, no fallback→null). |
| Both pass | OCR-4 fix may already be effective | Verify OCR-4 deploy commit is live in preview + prod. Close TEST-1 with confirmation. |
| Inconclusive (mixed 2/3 vs 2/3, or blockers mid-run) | Insufficient data | Run 3 more per case; if still mixed, escalate to PM. |

**Verdict (PM, 2026-07-06 — จากการรันแบบ manual ของ operator):**

- **page1-only: PASS** — อ่าน `ผู้รับโอน` ถูกต้องครบ (ยืนยัน: multi-page stacking คือตัวการของ failure เดิม, กลไก bbox_hint ทำงานได้เมื่อ layout ตรงกับตอนวาด hint)
- **หน้า 5 (ฟอร์มใบเบิก, คนละ layout):** AI คืน `ภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี` — operator มองว่าไม่ครบ แต่ตรวจเอกสารจริงแล้ว **นี่คือค่าตรงตัวของ label `ผู้รับโอน` ในหน้านั้น** (บรรทัด `วัตถุดิบและงานระหว่างทำ` เป็นของ `คลังรับโอน`) → ไม่นับเป็น extraction bug; เป็นข้อจำกัดเชิงออกแบบ: **hint ใช้ข้ามฟอร์มคนละ layout ไม่ได้**
- **Decision: GO for API-1 + UI-1** (page selection = fix หลัก) | **OCR-5 → hold** (guardrail แบบ no-fallback จะทำให้ case หน้า 5 ที่ semantic fallback ตอบถูก กลายเป็น null — ต้องคิดใหม่ถ้าจะทำ)
- แนวปฏิบัติ user ระหว่างนี้: 1 template ต่อ 1 layout ฟอร์ม + รันเฉพาะหน้าฟอร์มเดียวกัน

_หมายเหตุ: รันแบบ manual ผ่าน UI ไม่ใช่ harness — ตาราง per-run ด้านบนยังไม่ได้กรอกเป็นรายรอบ; harness พร้อมใช้สำหรับ OCR-2 ต่อไป_

---

## Production confirm (single run each, after preview passes)

| Case | Returned value | Match? |
|---|---|---|
| page1-only | | |
| full-7page | | |

---

## Raw observations (append to docs/OCR_TESTING_LOG.md too)

_(Paste anomalies, latency spikes, bbox values returned, credit consumption per run, screenshots if useful.)_

---

_Scaffold author: qa-tester agent, 2026-07-06_
_Do not delete the "Needed to complete" section after filling — future TEST-N runs will reference this template._
