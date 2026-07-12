# UI/UX Improvement Ideas — จาก OCR Projects ที่วิเคราะห์

> **โจทย์:** เครื่องมือ/หน้าต่างใน app เริ่มเยอะเกินไปและใช้งานยาก
> (OCR workspace, Compare workspace, templates, bbox_hint draw, corrections badge,
> batch table, page picker, WRONG panel — สะสมมาหลาย iteration)
>
> เอกสารนี้ถอด UI pattern จาก projects ที่วิเคราะห์ใน
> [`OCR_SLM_MODELS_KB.md`](./OCR_SLM_MODELS_KB.md) — เอาเฉพาะ **แนวคิด UI** ไม่แตะ license

---

## 1. Pattern จากแต่ละ Project

### 1.1 Datalab Playground (Chandra/Marker) — Split-pane synced workspace

- **Pattern:** เอกสารซ้าย / ผลลัพธ์ขวา ใน pane เดียวตลอด flow, ผลลัพธ์สลับ tab
  (Markdown | HTML | JSON) โดยไม่เปลี่ยนหน้า, scroll sync สองฝั่ง
- **ปรับใช้:** รวม preview + result panel + corrections ให้อยู่ split-pane เดียว
  ทุก interaction (แก้ค่า, WRONG, ดู correction diff) เกิดฝั่งขวาโดยไม่ปิดเอกสาร
  — ต่อยอด right-side panel ที่ทำไปแล้ว (`47348b18`) ให้เป็นบ้านของ*ทุก* secondary tool
- อ้างอิง: [Datalab Playground](https://www.datalab.to/playground/documents/new)

### 1.2 dots.ocr demo — Layout overlay บนตัวเอกสาร

- **Pattern:** วาด bbox สีตาม category (text/table/form) **ทับบนภาพเอกสารโดยตรง**
  คลิก box → กระโดดไป block ผลลัพธ์; ผลลัพธ์กับตำแหน่งเป็นสิ่งเดียวกัน ไม่ใช่ 2 panel แยก
- **ปรับใช้:** field ที่ extract แล้วแสดงเป็นกรอบ hover/click บน preview —
  คลิกกรอบ = focus field card ฝั่งขวา, คลิก field card = scroll preview ไปที่กรอบ
  ลดความจำเป็นต้องเปิดหน้าต่างเทียบเอง; bbox_hint ที่ user วาดก็อยู่ layer เดียวกัน
- อ้างอิง: [dots.ocr GitHub](https://github.com/rednote-hilab/dots.ocr)

### 1.3 olmOCR viewer — Page strip + per-page status

- **Pattern:** thumbnail strip แนวข้างแสดงทุกหน้า พร้อม status ต่อหน้า
  (pending/processing/done/error) — เห็นภาพรวม multi-page ตลอดเวลา
- **ปรับใช้:** ยกระดับ page picker (UI-1) จาก "เลือกก่อน extract" เป็น strip ถาวร:
  เลือกหน้า, เห็น progress ต่อหน้า (รองรับ per-page parallel ใน Techniques KB ข้อ 1),
  คลิกหน้าเพื่อ jump preview — ใช้ร่วมกันทั้ง single + batch

### 1.4 HF Spaces demos — Progressive disclosure

- **Pattern:** หน้าจอมีแค่ upload + ผลลัพธ์; ตัวเลือกขั้นสูงพับใน "Advanced" accordion
  คน 80% ไม่เคยต้องเห็นเครื่องมือที่ใช้โดย 20%
- **ปรับใช้:** default flow เหลือ 3 อย่าง: **วางไฟล์ → เลือก template → Extract**
  ส่วน bbox_hint draw, raw_text type, page selection, model options → พับเป็น
  "ตัวเลือกขั้นสูง" โผล่เมื่อกดหรือเมื่อระบบตรวจพบว่าจำเป็น (เช่น multi-page → เสนอ page strip)

## 2. หลักการแก้ปัญหา "เครื่องมือเยอะเกินไป"

| หลักการ | รูปธรรมใน app เรา |
|---|---|
| **One workspace, many modes** | OCR / Compare / Batch เป็น mode tab ใน workspace เดียว ไม่ใช่คนละหน้า — layout ซ้าย(เอกสาร)/ขวา(ผลลัพธ์) เหมือนกันทุก mode ลด learning curve |
| **เครื่องมือปรากฏตามบริบท** | corrections badge โผล่เฉพาะเมื่อมี correction; landscape toast เฉพาะเมื่อเจอ landscape; ไม่มี toolbar ถาวรที่มีปุ่มครบทุกฟีเจอร์ |
| **ตำแหน่ง = ผลลัพธ์** (จาก 1.2) | ทุกอย่างชี้กลับไปที่ตัวเอกสาร ผู้ใช้ไม่ต้องสลับหน้าต่างเพื่อ verify |
| **Wizard สำหรับงานตั้งค่า** | สร้าง template / rulebase เป็น stepper (เลือกไฟล์ตัวอย่าง → ตี field → ทดสอบ → save) แทน form ใหญ่หน้าเดียว |
| **Keyboard-first review** | โหมด review ผลลัพธ์: ↑↓ เลื่อน field, Enter ยืนยัน, W = WRONG — งาน operator ตรวจเอกสารเยอะๆ เร็วขึ้นมาก |

## 3. ประเมิน Impact / Effort

| # | Idea | แก้ pain | Effort | เสี่ยงต่อของเดิม |
|---|---|---|---|---|
| 1 | Progressive disclosure (1.4) | ลดความรก **ได้ผลเร็วสุด** | ~3-5 วัน (จัด layout ใหม่ ไม่แตะ logic) | 🟢 ต่ำ — ซ่อน/ย้าย ไม่ลบ |
| 2 | Click-sync overlay (1.2) | verify ง่ายขึ้น, ลดสลับหน้าต่าง | ~1 sprint | 🟡 ผูกกับพิกัด bbox (ระวัง class OCR-6c) |
| 3 | Page strip ถาวร (1.3) | multi-page UX + รองรับ per-page parallel | ~1 sprint | 🟢 ต่อยอด UI-1 เดิม |
| 4 | One workspace, mode tabs | โครงสร้างรวม ลดหน้าซ้ำซ้อน | ใหญ่ — ทำเป็นเฟส | 🔴 แตะทุกหน้า ต้องมี design ก่อน |
| 5 | Keyboard review mode | ความเร็ว operator | ~2-3 วัน | 🟢 additive |

**ลำดับแนะนำ:** 1 → 5 → 3 → 2 → 4 (เก็บ quick win ให้ผู้ใช้รู้สึก "โล่งขึ้น" ก่อน
แล้วค่อย restructure ใหญ่ข้อ 4 ซึ่งควรทำ UX audit + wireframe ก่อนเขียน code)

> ข้อ 4 ควรอัปเดต `UX_DESIGN_BRIEF.md` ให้สอดคล้องก่อนเริ่ม

---

_ที่มา: [Datalab Playground](https://www.datalab.to/playground/documents/new) · [dots.ocr](https://github.com/rednote-hilab/dots.ocr) · [Chandra GitHub](https://github.com/datalab-to/chandra) · วิเคราะห์ 2026-07-08_
