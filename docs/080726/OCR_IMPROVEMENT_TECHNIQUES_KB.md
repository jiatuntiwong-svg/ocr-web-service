# Knowledge Base — เทคนิคปรับปรุง OCR บน Gemini Base (ใช้ได้ทันที ไม่กระทบ License)

> **สถานะปัจจุบัน (2026-07-08):** Gemini เป็น base engine — ทุกข้อในไฟล์นี้ทำได้เลย
> **ไม่ต้องใช้ GPU, ไม่แตะ model weights ใคร** (เป็นแนวคิด/methodology สาธารณะ)
> ส่วน SLM models เก็บไว้ที่ [`OCR_SLM_MODELS_KB.md`](./OCR_SLM_MODELS_KB.md)

---

## 1. Per-page parallel pipeline

- แตก multi-page PDF เป็น per-page request ยิงขนาน (คุม `OCR_BATCH_CONCURRENCY` เดิม)
  แทน tall stacked PNG 3600px
- **แก้:** 1.3 (multi-page ช้า) + ลด attention dilution ต้นเหตุ 1.2/1.4
- เก็บ per-page latency + failure rate เป็น metric
- **Effort:** ~1 sprint | **Priority: 1**

## 2. Shared prompt rule block + prompt types

- แยก prompt profile ตามงาน: `extract_fields` / `verbatim_transcribe` / `layout_scan` / `compare`
- Rule ชุดกลาง (no-autocorrect, multi-line join, anti-borrowing) เป็น shared block
  ที่ทุก prompt ต้อง include — กัน regression แบบ OCR-6b (crop prompt หลุด rules)
- **Effort:** ~2-3 วัน | **Priority: 2**

## 3. Regression suite ตาม benchmark methodology

- ยกโครงหมวดของ olmOCR-bench (dataset เปิด ODC-BY ใช้ได้เลย): tables, old scans,
  multi-column, headers/footers, long tiny text — เพิ่มหมวดของเรา: Thai form,
  dense page, landscape
- รายงานคะแนนต่อหมวด + variance (±) ทุกครั้งที่แก้ prompt/config
- ต่อยอด scaffold OCR-2 + TEST-1 ที่มีอยู่แล้ว
- **Effort:** ~2-3 วัน | **Priority: 3**

## 4. Confidence-based escalation (Flash → Pro)

- Trigger: `confidence < threshold`, `crop_miss:true`, หรือ user กด WRONG
- ถูกกว่า self-consistency 3-run vote — แก้ Gemini variance (§2.5) ทางอ้อม
- ผูก model multiplier กับ credit pricing ที่ design ไว้แล้ว (`CREDIT_PRICING_SUMMARY.md`)
- **Effort:** ~3-5 วัน | **Priority: 4**

## 5. Layout-first highlight (text PDF ไม่ต้องใช้ AI เลย)

- **Text PDF:** ใช้ pdf.js text layer ดึงพิกัดคำจริง → map ค่า field ที่ Gemini
  extract กลับไปหา bbox ด้วย string match — highlight แม่น 100% ไม่มี AI cost เพิ่ม
- **Scanned PDF:** ระยะนี้ใช้ bbox_hint + crop (OCR-6) ต่อไป; bbox จาก SLM
  เป็นเรื่องอนาคต (ดู SLM KB §2)
- **แก้:** highlight accuracy — ปัญหายากสุดใน `PROJECT_ANALYSIS.md`
- **Effort:** ใหญ่ ต้อง design ก่อน | **Priority: 5**

## 6. Structured output schema (blocks + layout)

- ปรับ response schema ให้ Gemini คืนโครงสร้างเอกสารเต็ม (blocks: table/form/paragraph)
  ไม่ใช่แค่ field values → เก็บใน `raw_json`
- Compare เทียบระดับ block ได้แม่นขึ้น + replay ไม่ต้องยิง AI ซ้ำ
- **Effort:** ผูกกับข้อ 5 | **Priority: 6**

## 7. Prompt-type แยก mode (แนวคิดจาก Chandra `ocr_layout`)

- ไม่ใช้ prompt เดียวโตขึ้นเรื่อยๆ — mode ละ prompt, วัดผลแยก mode ใน regression suite
- รวมเข้ากับข้อ 2 ตอน implement

---

## 8. ประเมินผลกระทบต่อระบบเดิม & Rollback

> หลักการรวม: ทุกข้อที่แตะ production path ต้องอยู่หลัง **feature flag** และผ่าน
> **regression suite (ข้อ 3) ก่อน deploy** — ดังนั้นควรทำข้อ 3 ให้เสร็จก่อนข้ออื่นทั้งหมด
> แม้ลำดับ priority เดิมจะวางข้อ 1 ไว้แรก

| ข้อ | ความเสี่ยงต่อของเดิม | จุดที่อาจพัง | Rollback |
|---|---|---|---|
| 1. Per-page parallel | 🔴 **สูง** | แตะ core pipeline ทั้งเส้น: `field_crops` คำนวณ y จาก stacked canvas (OCR-6/6b/6c) → เปลี่ยนเป็น per-page ต้อง remap พิกัดใหม่หมด เสี่ยง regression class เดียวกับ OCR-6c; page selection (API-1), batch mode, และ metering (`logAiUsage` 1 row/operation → หลาย call) กระทบทั้งหมด | ✅ ได้ **ถ้า**สร้างเป็น path ใหม่คู่ path เดิม + flag `OCR_PIPELINE_MODE=stacked\|per_page` — ห้าม refactor ทับของเดิม; สลับ flag กลับได้ทันทีไม่ต้อง redeploy schema |
| 2. Shared prompt rules + types | 🟡 กลาง | Prompt เปลี่ยน = พฤติกรรม Gemini เปลี่ยนแบบคาดเดายาก — ปัญหาที่เคย mitigate ด้วย prompt (1.1, 2.2, 2.1) อาจกลับมา แม้ข้อความ rule "เหมือนเดิม" แต่ลำดับ/บริบทต่างก็มีผล | ✅ ง่ายสุด — เก็บ prompt เป็น version (v1, v2, ...) ใน config, revert version เดียวจบ; แต่ต้องรัน regression 3× ก่อน/หลังเสมอเพราะ variance ทำให้ pass ครั้งเดียวเชื่อไม่ได้ |
| 3. Regression suite | 🟢 **ไม่มี** | Test-only, additive — ไม่แตะ production code; cost แค่ credit บน dev account | ไม่ต้อง rollback |
| 4. Flash→Pro escalation | 🟡 กลาง (ฝั่ง cost/billing) | การทำงานเดิมไม่พัง แต่เสี่ยง **cost พุ่ง** (Pro แพง 10-50×) ถ้า threshold ตั้งหลวมหรือ retry loop; credit deduction ต้องคิด multiplier ถูก — ผิดแล้วกระทบเงินลูกค้าจริง ต้อง test webhook/refund path | ✅ ได้ทันที — flag ปิด escalation กลับเป็น Flash-only; แต่ credit ที่หักไปแล้วผิด rollback ไม่ได้ ต้องมี reconciliation/refund script เตรียมไว้ |
| 5. pdf.js text-layer highlight | 🟡 กลาง | เป็น path ใหม่เฉพาะ text PDF — scanned path เดิมไม่แตะ; ความเสี่ยงหลักคือ coordinate-space mismatch ระหว่าง text layer กับ preview render (บั๊กตระกูลเดียวกับ OCR-6c letterbox) และ PDF ที่ text layer เพี้ยน (embedded font แปลก) ให้พิกัดผิดแบบมั่นใจ | ✅ ได้ — fallback อัตโนมัติไป AI-highlight เดิมเมื่อ match ไม่เจอ + flag เปิด/ปิดทั้ง feature; ไม่มี data เขียนถาวร |
| 6. Structured output schema | 🔴 **สูง** (ฝั่ง data) | `raw_json` format เปลี่ยน → consumer ทุกตัว (Compare, rulebase, UI result panel, replay) ต้องรองรับ 2 format; record เก่า vs ใหม่ปนกันใน D1; token output ใหญ่ขึ้น = cost ต่อ call เพิ่ม | ⚠️ **ครึ่งเดียว** — ใส่ `schema_version` ใน raw_json ตั้งแต่วันแรก จึงปิด flag ให้ record ใหม่กลับ format เดิมได้ แต่ record ที่เขียนไปแล้วเป็น format ใหม่ **ย้อนไม่ได้** — consumer ต้องอ่าน 2 format ตลอดไป (หรือเขียน migration) |
| 7. Prompt-type แยก mode | 🟡 กลาง | เหมือนข้อ 2 (implement รวมกัน) | เหมือนข้อ 2 |

### เงื่อนไขก่อน deploy ทุกข้อ (checklist)

- [ ] Regression suite (ข้อ 3) รันผ่านบน branch ก่อน merge — 3 runs ต่อ case
- [ ] Feature flag มีค่า default = พฤติกรรมเดิม (opt-in)
- [ ] ข้อ 1 และ 6: ห้าม deploy พร้อมกัน — คนละ sprint เพื่อให้ isolate ปัญหาได้
- [ ] ข้อ 4: ตั้ง cost alert + daily cap ก่อนเปิด escalation จริง

---

## สรุปลำดับทำ (ปรับตาม impact assessment §8)

| ลำดับ | Item | แก้ปัญหา (อ้าง OCR_TESTING_LOG) | เหตุผลลำดับ |
|---|---|---|---|
| 1 | Regression suite ต่อหมวด | วัดผลทุก change | 🟢 ไม่มีความเสี่ยง + เป็น safety gate ของทุกข้อถัดไป |
| 2 | Shared prompt rules + types | OCR-6b class | Rollback ง่ายสุด, มี suite คุมแล้ว |
| 3 | Per-page parallel | 1.2, 1.3, 1.4 | Impact สูงสุด — ทำหลังมี suite + ต้องมี flag คู่ path เดิม |
| 4 | Flash→Pro escalation | 2.5 variance | ต้องมี cost alert + cap ก่อนเปิด |
| 5 | pdf.js text-layer highlight | Highlight accuracy | Path ใหม่ + fallback ของเดิม |
| 6 | Structured output schema | Compare precision | ⚠️ Data ย้อนไม่ได้ — ทำท้ายสุด, ห้ามพร้อมข้อ 3 |

_ที่มา: วิเคราะห์จาก Chandra OCR 2, olmOCR-bench methodology, และ pain points ใน `OCR_TESTING_LOG.md` — 2026-07-08_
