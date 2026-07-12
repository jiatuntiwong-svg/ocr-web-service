# PM Board — Sprint: OCR Stabilization ✅ CLOSED 2026-07-11

**Sprint goal:** ทำให้ OCR ปกติ (single + batch) สมบูรณ์และเชื่อถือได้ ก่อนไปต่อเรื่องอื่น — **บรรลุ**
**เริ่ม:** 2026-07-05 | **ปิด:** 2026-07-11 (เร็วกว่าเป้า 2 สัปดาห์) | Deploy: `a878584d` | Sprint close docs: `pm/reports/DOC-1-sprint-close.md` + `docs/OCR_TESTING_LOG.md` §13
**อ้างอิง:** docs/OCR_TESTING_LOG.md §4 (unsolved), docs/PENDING_ISSUES.md §H (error UX), §F4

## สถานะรวม

| ID | งาน | Agent | Priority | สถานะ | Blocked by |
|----|-----|-------|----------|-------|------------|
| OCR-1 | Verify bbox_hint กับ case ค่านอกกรอบเส้น (issue 1.2) | ocr-pipeline | 🔴 P0 | ✅ done — hint ใช้ได้เมื่อ layout ตรง, ตัวการคือ multi-page | — |
| OCR-4 | Quick fix: gate auto-capture ด้วย confidence + prompt "ค้นใต้กรอบเสมอ" | ocr-pipeline | 🔴 P0 | ✅ done | — |
| OCR-2 | Regression suite baseline | qa-tester + ocr-pipeline | 🔴 P0 | ✅ done (user ปิด 2026-07-11) — baseline บันทึกใน pm/reports/OCR-2.md; suite + fixtures พร้อม reuse ใน S2-1 | — |
| OCR-3 | Retry mechanism (temp 0.6) ฝั่ง handler | ocr-pipeline | 🟡 P1 | ✅ done (PM approved) — ปุ่มกดจะมีชีวิตตอน UI-4b เสร็จ (handoff notes ในรายงาน §7) | — |
| OCR-6 | Crop-based extraction สำหรับ field ที่มี hint | ocr-pipeline | 🔴 P0 | ✅ done (doc1 ผ่าน) แต่พบ gap บนฟอร์มใหม่ → OCR-6b | — |
| OCR-6b | Debug crop pass: prompt rules + merge observability + page remap | ocr-pipeline | 🔴 P0 | ✅ done — verify แล้ว: แก้ blend/สะกดได้, observability ชี้สาเหตุถัดไป (crop_miss) | — |
| OCR-6c | Hint coordinate เพี้ยนบนหน้า landscape (iframe letterbox) → crop หลุดเป้า | ocr-pipeline | 🔴 P0 | ✅ done — user verify แล้ว ฟอร์ม landscape ใช้งานได้ | — |
| OCR-5 | Hint guardrails: bbox-overlap validation + no-fallback→null | ocr-pipeline | ⚪ hold | ✅ closed — OCR-6 subsumed the observed failure mode (crop_miss + manifest-restricted merge). Reopen only if future eval shows hint-vs-returned-bbox drift | — |
| TEST-1 | Control test: split page 1 เทียบทั้งชุด | qa-tester | 🔴 P0 | ✅ done (manual โดย user) — page1 PASS → GO API-1/UI-1 | — |
| API-1 | Page-selection param ใน upload/extract | backend-api | 🔴 P0 | ✅ done (PM approved) — contract ใน pm/reports/API-1.md; ปลดล็อก UI-1 | — |
| API-2 | Error codes แทน raw message (OCR routes) | backend-api | 🟡 P1 | ✅ done (PM approved) — 3 routes coded 100%, raw payload stripped, BC `error` field | — |
| API-3 | Upload size guard (F4) | backend-api | 🟢 P2 | ✅ done (PM approved) — 20MB cap, ตัดก่อนหัก credit/แตะ memory; ปิด F4 | — |
| UI-1 | Page selection UI ก่อนรัน OCR (issue 1.3) | frontend-ui | 🔴 P0 | ✅ done — user verify แล้ว → ปิด issue 1.3 | — |
| UI-4 | จัดระเบียบหน้า OCR (mockup) | frontend-ui + PM | 🟡 P1 | ✅ done — v3 approved 2026-07-09 | — |
| UI-4b | Implement workspace v3 หลัง flag `ocrWorkspaceV2` | frontend-ui | 🟡 P1 | ✅ done (PM approved, flag OFF — deploy ปลอดภัย) — **ห้ามเปิด flag ON จนกว่า UI-4c ผ่าน** | — |
| UI-4c | Flag-ON punch list + UAT findings ×5 รอบ | frontend-ui | 🟡 P1 | ✅ done (PM approved 2026-07-11) — §3a-e ครบ, deploy ทั้งหมด, v2 workspace flag ON stable ใน prod | — |
| UI-7 | Batch flow ในสไตล์ v2 (แทน stopgap ที่เปิด UI เดิม) | frontend-ui | ⚪ backlog | ⏳ รอ operator ตัดสิน priority | UI-4c |
| API-4 | Backend full-doc mode: อ่าน `mode=fulldoc` + verbatim_transcribe profile + `{pages:[...]}` shape | backend-api + ocr-pipeline | 🟡 P1 | ⏳ todo (Sprint 2 — มัดรวม S2-2 prompt profiles) | S2-2 |
| UI-5 | ⚡ Quick mode — ข้าม step ที่มี default | frontend-ui | 🟢 P2 | ✅ done — ship รวมกับ UI-6 (verified: OCRWorkspaceV2:387 auto-advance + credit-confirm ไม่ถูก bypass) | — |
| UI-6 | Template UX: picker (⭐/🕐/📋) + save semantics + delete + Quick mode | frontend-ui | 🟡 P1 | ✅ done — deploy `a878584d` + docs-manager verify ใน code แล้ว (BEHAVIOR_REFERENCE §4.2) | — |
| AI-1 | รองรับ Vertex AI key (express mode) + 🔒 security gate | ocr-pipeline | 🔴 P0 🔥 | ✅ done — security 2 ชั้นผ่าน, user เทสจริง + deploy แล้ว 2026-07-09 | — |
| UI-2 | Retry button ใน OCR result | frontend-ui | 🟡 P1 | 🔀 merged เข้า UI-4b (retry อยู่ใน overflow menu + kbd R ของ mockup v3 แล้ว) — กัน conflict ที่ OCRWorkspace | OCR-3 |
| UI-3 | friendlyError ใน OCR flow (H4 quick win) | frontend-ui | 🟡 P1 | ✅ done (PM approved) — 0 raw err.message ใน OCR/login/register, catalog th/en ครบ | — |
| BILL-1 | Credit model สลับได้ 3 โหมด + security fixes (race + masking) | billing-payment | 🟡 P1 | ✅ done (PM approved) — ⚠️ deploy แล้วราคาเปลี่ยนเป็น per_page ทันที (สลับกลับได้ใน admin ไม่ต้อง redeploy) | — |
| DB-1 | Review schema (corrections/bbox_hint/status_code/attempts) | database | 🟢 P2 | ✅ done (PM approved) — **ตัดสิน: apply `status_code` (user รัน wrangler), hold `document_attempts` (ยังไม่มี consumer)**; persistence เดิมครบทุกตัว | — |
| DB-2 | Schema hygiene: rewrite schema.sql (ASCII) + system_settings/is_retry parity + wire status_code consumers (upload catch, /api/status) | database + backend-api | 🟢 P2 | ⏳ todo (คิว Sprint 2 tail) | status_code applied |
| OPS-1 | Verify OCR path ใน workerd (preview) + limits check | devops-cloudflare | 🟡 P1 | ✅ done 2026-07-09 — sprint deploys ทุกตัวผ่านการ verify (OCR-6/6b/6c + UI-1 + AI-1 + BILL-1); limits table + smoke runbook + Windows EPERM fix บันทึกไว้ใน pm/reports/OPS-1.md; sprint DoD gate closed | — |
| DOC-1 | อัปเดต OCR_TESTING_LOG + BEHAVIOR_REFERENCE ทุกครั้งที่ปิดงาน | docs-manager | 🟡 P1 | 🔁 ongoing — sprint-close sync 2026-07-11 → pm/reports/DOC-1-sprint-close.md | — |

สถานะ: ⏳ todo → 🔨 in progress → 👀 review → ✅ done | 🚫 blocked

## Decision log

- 2026-07-05: OCR-1 static review = NO-GO เบื้องต้น → อนุมัติ quick fix (OCR-4) ก่อน, user จะรันเทสจริง 18-run หลัง OCR-4 เสร็จ, **ยังไม่อนุมัติ two-pass extraction**
- 2026-07-05: Public API v1/extract ยังไม่มีผู้ใช้ → bbox_hint support ใน v1/extract ลง backlog (ไม่ทำ sprint นี้)
- 2026-07-05: API-1 เพิ่ม requirement: page selection ต้อง remap page number ใน bbox_hint (coordinate drift — ดู OCR-1 report §Surprises)
- 2026-07-06: qa-tester scaffolded TEST-1 (split-pdf.mjs + Playwright harness at scripts/ocr-e2e/ + fill-in report at pm/reports/TEST-1.md). Blocked on operator handoff: source PDF (PII decision needed), Playwright install, dev-account credentials. OCR-5 remains gated on TEST-1 result.
- 2026-07-06: เทสจริงครั้งแรก (7-page bundle) ❌ — AI คืนค่าของ field "ผู้โอน" จากหน้า 4/5/7 แทน "ผู้รับโอน" หน้า 1 = cross-page label confusion ไม่ใช่แค่ hint ล้มเหลว → user รัน control test (หน้า 1 เดี่ยว, 3×) ก่อนตัดสิน; ถ้าผ่าน = ยกน้ำหนักไป API-1/UI-1, ถ้าไม่ผ่าน = เริ่ม OCR-5
- 2026-07-06: TEST-1 blockers ตัดสินครบ — (1) PII: ไม่ commit fixture, เก็บ local + gitignore `test_fixtures/` และ `pm/reports/test-1-runs/` แล้ว (2) อนุมัติ Playwright เป็น devDependency (เป็นฐาน OCR-2 ต่อ) (3) credentials: user ใส่ `.env.local` เอง ห้ามส่งผ่าน chat/commit
- 2026-07-06 (ค่ำ): **crop validation ผ่าน** — capture เฉพาะบริเวณ header ของ doc1 แล้วได้ครบ 2 บรรทัด → ยืนยัน content-density theory → **อนุมัติ OCR-6** (crop hinted fields, batch เป็น 1 AI call, merge policy + fallback) แทน two-pass เต็มรูปแบบ
- 2026-07-06 (ค่ำ): Case 6 ผล deterministic — doc1 (หน้าแน่น) 0/3, doc2 (หน้าโปร่ง) 3/3, hint กว้างสุดก็ไม่ช่วย → ไม่ใช่ variance, ไม่ใช่ hint coverage → ทฤษฎี content density → รอ crop validation test จาก user; ถ้าผ่าน = เปิด OCR-6 (crop-based extraction สำหรับ field ที่มี hint) | นัยเพิ่ม: Retry (OCR-3/UI-2) ช่วย case deterministic ไม่ได้ → ลดกลับเป็น P1
- 2026-07-06: หน้า 1 เดี่ยวพบ intermittent multi-line drop (บางรอบได้แค่บรรทัดแรก ไม่มี "วัตถุดิบและงานระหว่างทำ") = issue 2.1 + 2.5 เดิม ไม่ใช่ bug ใหม่ → ยก OCR-2 (วัด pass rate ด้วย harness), OCR-3 + UI-2 (retry) ขึ้น P0; self-consistency (3-run vote) ยังไม่อนุมัติจนกว่าจะเห็นตัวเลข pass rate จาก OCR-2
- 2026-07-06: qa-tester scaffolded OCR-2 (5 synthetic fixtures ที่ `test_fixtures/regression/` + `scripts/ocr-regression/` runner + fixture generator ที่ reuse harness ของ TEST-1). Reconciliation: เลือก UI/Playwright path (ไม่ hit `/api/v1/extract`) + disambiguation case ใช้ template ไม่มี bbox_hint. Blocker เดียวกับ TEST-1 (Playwright install + creds + credits). ดู `pm/reports/OCR-2.md`
- 2026-07-06: **TEST-1 ผล: page1 เดี่ยว = ถูกต้อง ✅** → ยืนยัน multi-page stacking คือตัวการหลัก → **GO: API-1 + UI-1 เป็นงานถัดไปทันที** | หน้า 5 (ฟอร์มใบเบิก) ที่ดูเหมือน "ดึงไม่ครบ" จริงๆ AI อ่านถูกตาม label ในหน้านั้น — เป็นข้อจำกัด "hint ข้าม layout ไม่ได้" ไม่ใช่ bug → แนวทาง: 1 template/1 layout | OCR-5 → hold (no-fallback rule จะทำให้ case ที่ fallback ตอบถูกกลายเป็น null)

- 2026-07-06 (ดึก): **OCR-6 ผ่านการเทสโดย user → ปิด issue 1.2 (ค่านอกกรอบ/หน้าแน่นตัดบรรทัด)** — เหลืองานหลักของ sprint: API-1 → UI-1 (page selection, แก้ cross-page confusion + ความช้า), API-2 → UI-3 (error UX), OCR-2 synthetic suite, OPS-1 | docs-manager ต้อง sync OCR_TESTING_LOG §1.2 → ✅ และ §4
- 2026-07-06 (ดึก): **OCR-5 closed (was on hold)** — OCR-6's `crop_miss` observability + manifest-restricted merge subsume the hint-guardrail concerns for the observed failure mode. Explicit bbox-overlap validation stays deferred; reopen only if a future eval shows hint-vs-returned-bbox drift.
- 2026-07-06 (ดึก): docs-manager DOC-1 pass — synced `docs/OCR_TESTING_LOG.md` §1.2/§4/§5/§8, added `docs/BEHAVIOR_REFERENCE.md` §4.2a (bbox_hint + crop pass), updated BOARD OCR-5 status. `docs/PENDING_ISSUES.md` had no items referencing issue 1.2 / OCR-6 / F4-crop (F4 is upload size guard, unrelated) — nothing to close there.

- 2026-07-08: **Credit model เปลี่ยนเป็น 1 หน้า = 1 credit (default ใหม่)** สำรอง field-formula เดิม + per-file ไว้สลับได้ผ่าน admin → BILL-1; สูตร G1 ใน PENDING_ISSUES กลายเป็น reserve model | ยังไม่ครอบคลุม Compare (ใช้สูตรเดิมจนกว่าจะตัดสิน)

- 2026-07-09: **AI-1 ปิด + deploy** — Vertex AI (express, key ใน header) ใช้งานจริงแล้ว; `/security-review` cleared; ข้อสังเกต 2 จุด (credit race + masking) มัดเข้า BILL-1

- 2026-07-12: **S2-1 baseline LOCKED** — 88.9% run-level, 91.7% case-level (32/36 runs, 11/12 cases). Snapshot at `pm/reports/OCR-2-runs/_baseline.json`. Only real regression: `landscape-a4-widefield` (AI omits Thai word "รับบริจาค" deterministically) → S2-2 prompt target. Harness needed 5 fixes (v2 flow reorder + JSON-tab scraper + multiline ws-strip + table row-object shape + assertion crash guard) before real signal emerged

- 2026-07-11: **UI-4c ปิด** — 5 UAT rounds ครบ (§3a hint drawing/batch/UAT prep, §3b stage-machine deadlock + JSON theme, §3c credit chip removal + title dedup + eye toggle, §3d mode switch on stepper + loading story + 8 field types, §3e hint toggle + expander rename). v2 workspace flag ON in prod. Next: UI-6 sign-off

- 2026-07-09: **docs-manager DOC-1 batch sync** — synced `docs/OCR_TESTING_LOG.md` (§1.3 → ✅, §4 row 2 → done, §9/§10 → verified in prod, §5 pruned, new §11 API-2/3+UI-3 bundle + §12 AI-1), `docs/BEHAVIOR_REFERENCE.md` (§4.2 page picker + 20 MB cap rows, new §4.2b error UX, §4.7 Vertex + masking rows), `docs/PENDING_ISSUES.md` (F4 ✅ + H1-4 header noting OCR-flow scope closed, Compare/admin still open), `docs/PENDING_FEATURES_BACKLOG.md` (F4 ticked). BOARD status table already matched reality (all ✅ rows have reports); no in-place fixes required.

## Sprint 2 (draft — จาก research docs/080726, ประเมินโดย PM 2026-07-08)

ลำดับตาม impact assessment (Techniques KB §8) + บทเรียน sprint นี้:

| ลำดับ | งาน | ที่มา | สถานะ | เงื่อนไข |
|---|---|---|---|---|
| S2-1 | ขยาย OCR-2 เป็น benchmark-style suite (หมวด: Thai form, dense, landscape, tables, multi-column) | Techniques §3 + scaffold เดิม | ✅ done — **baseline locked 2026-07-12: 88.9% run-level, 91.7% case-level** (32/36 runs, 11/12 cases). thai-form/multi-column/tables 100%, dense 83% (1 harness timeout), landscape 0% (real AI omission → hands S2-2 evidence). Baseline snapshot at `pm/reports/OCR-2-runs/_baseline.json`; report `pm/reports/S2-1.md` §Baseline | ไม่มีความเสี่ยง — ทำก่อนทุกข้อ เป็น safety gate |
| S2-2 | Shared prompt rule block + prompt profiles (extract/verbatim/layout/compare) | Techniques §2 — แก้ root cause class OCR-6b | 👀 review — module + wiring + flag landed; deploy `836d86ae`; benchmark = **88.9% (equal to baseline)**, no regression on 11 passing cases. Landscape ยัง 0/3 — vision-side issue ไม่ใช่ prompt gap (AI ไม่ report เป็น correction ด้วย). Handoff → S2-2b (DPI bump / retry / re-crop). ดู `pm/reports/S2-2.md` §Landscape verdict | Prompt versioned; ⚠️ landscape acceptance ยังไม่ผ่าน — งานถัดไป S2-2b |
| S2-3 | UI-4b implement (progressive disclosure ตาม mockup) + keyboard review mode | UI ideas §1, §5 | ⏳ todo | หลัง mockup UI-4 ผ่าน review |
| S2-4 | Per-page parallel pipeline หลัง flag `OCR_PIPELINE_MODE` | Techniques §1 | ⏳ todo | ต้อง S2-1 เขียว + path ใหม่คู่ path เดิม ห้าม refactor ทับ + redesign ร่วม field-crops |
| S2-5 | Page strip ถาวร + click-sync overlay | UI ideas §3, §2 | ⏳ todo | ต่อยอด UI-1; overlay ระวังพิกัด (class OCR-6c) |

**เลื่อนไป Phase ถัดไป:** Flash→Pro escalation (มัดรวม pricing rework G1), pdf.js text-layer highlight + structured schema (design ก่อน, ห้ามพร้อม S2-4), SLM models (trigger-based ตาม `docs/080726/OCR_SLM_MODELS_KB.md` §3 — review trigger ทุกสิ้นเดือนจาก AI usage dashboard)

## นอก scope sprint นี้ (จงใจเลื่อน)

- Two-pass extraction — รอผลเทสจริง OCR-1 (B2/C2 cells) เท่านั้น
- bbox_hint ใน public API v1/extract — ยังไม่มีผู้ใช้
- Compare quality (PENDING_ISSUES §A) — หลัง OCR นิ่ง
- OCR Rulebase (testing log §4.4) — รอ approve, ~2 วัน MVP
- Two-pass extraction (§4.5) — ทำต่อเมื่อ OCR-1 พิสูจน์ว่า bbox_hint ไม่พอ
- Pricing rework (G1), Excel/doc support (C, D) — Phase ถัดไป
- billing-payment agent: standby sprint นี้

## วิธีใช้โฟลเดอร์นี้

1. งานของแต่ละ agent อยู่ใน `pm/tasks/<agent>.md` — เปิด session แล้วสั่ง เช่น
   "use the ocr-pipeline agent to work on OCR-1 in pm/tasks/ocr-pipeline.md"
2. Agent ปิดงานแล้ว → อัปเดตสถานะในตารางนี้ + เขียนผลใน `pm/reports/<ID>.md`
3. PM (session หลัก) review ทุกงานที่ 👀 ก่อน mark ✅

## Definition of Done (ทั้ง sprint)

- [ ] bbox_hint ผ่านการ verify กับเอกสารจริง หรือมีข้อสรุปว่าต้องทำ two-pass
- [ ] PDF 10+ หน้า รัน OCR ได้ในเวลายอมรับได้ (เลือกหน้า/skip หน้าเปล่า)
- [ ] User กด retry ได้เมื่อผล OCR เพี้ยน
- [ ] OCR flow ไม่โชว์ raw error message แก่ user
- [ ] ทุก fix ผ่านการทดสอบบน `npm run preview` (workerd) ไม่ใช่แค่ next dev
