# PDF Edit Feature — Discussion Document

> สถานะ: **DISCUSSION ONLY — ยังไม่ตัดสินใจและยังไม่เริ่ม implement**
> วันที่บันทึก: 2026-06-18
> สำหรับคุยกับทีม / stakeholder ก่อนตัดสิน scope

---

## 1. โจทย์เบื้องต้น

หลังจาก Compare workspace เจอจุดต่างระหว่างเอกสาร 2 ฝั่ง → ผู้ใช้ต้องการให้ระบบ
**แก้ไขตัวไฟล์ PDF ให้ถูกต้องและ export ออกมา** เพื่อใช้งานต่อ

ตัวอย่าง flow ที่อยากได้:
```
Doc 1:   "Bangkok Thailand"
Doc 2:   "Bankok Thailand"
DIFF:    Bangkok : Bankok
   ↓
User คลิก "แก้ Doc 2 ให้ตรงกับ Doc 1"
   ↓
ระบบแก้ "Bankok" → "Bangkok" ใน PDF
   ↓
Export PDF ที่แก้แล้ว → download
```

---

## 2. Requirements ที่ผู้ใช้ระบุ (locked decisions)

| # | ประเด็น | คำตอบ |
|--|--|--|
| R1 | **กลุ่มเป้าหมาย** | Enterprise (มี audit / compliance ที่เคร่งครัด) |
| R2 | **ประเภท PDF ส่วนใหญ่** | Text PDF (ไม่ใช่ scanned) |
| R3 | **ภาษา** | English |
| R4 | **ปริมาณการแก้** | สามารถทำเป็น batch ได้ (ไม่จำกัดทีละ field) |
| R5 | **คุณภาพ output** | Pixel-perfect (ถ้าไม่ได้จริงๆ ค่อยคุยใหม่) |
| R6 | **งบประมาณ commercial library** | ไม่มี (ใช้ open source / free only) |

---

## 3. Architecture ปัจจุบัน — Preview vs Source

> Misconception ที่ต้องชี้แจง: **Preview เป็น "การ render ให้ดู" ไม่ได้แปลงไฟล์ — Original PDF bytes ถูกเก็บไว้และใช้สำหรับ edit ได้ตรงๆ**

```
Original PDF (user upload)
     │
     ├─→ Preview: browser/PDF.js render สดๆ (ไม่ใช่ image file)
     │
     ├─→ ส่ง image → Gemini AI
     │       └─→ AI ตอบ bbox ratio 0-1 (normalized ต่อหน้า)
     │
     └─→ Original PDF bytes เก็บไว้ → ใช้สำหรับ edit
```

**Bbox จาก AI map 1:1 กลับ PDF coord ได้** เพราะ AI เห็น image ที่ render มาจาก PDF page เดียวกัน:

```ts
// AI bbox (0..1 ratio) → PDF coords (points, y-axis flipped)
const x = box.x * page.getWidth();
const y = page.getHeight() - (box.y + box.height) * page.getHeight();
const w = box.width * page.getWidth();
const h = box.height * page.getHeight();
```

→ **Preview แปลงเป็น image ไม่กระทบ editing capability** ✅

---

## 4. 5 ระดับการ "แก้ PDF" — เปรียบเทียบ

| ระดับ | วิธี | Effort | ทำงานกับ | คุณภาพ | ข้อจำกัดหลัก |
|--|--|--|--|--|--|
| **1** Annotation | sticky note + highlight overlay | 2-3 วัน | ทุก PDF | n/a | ไม่ได้แก้เนื้อหา แค่ comment |
| **2** Form fill | AcroForm fields (native) | 2-3 วัน | PDF ที่มี form fields | สูง | ต้องเป็น "fillable PDF" เท่านั้น |
| **3** Whiteout + overlay | วาด rect ขาวทับ + เขียน text ใหม่ | 5-7 วัน | ทุก PDF | กลาง | ของเดิมยังอยู่ใน stream (audit fail) |
| **4** Content stream edit | parse + replace text operators | 4-6 สัปดาห์ | text PDF เท่านั้น | สูง | fragile, low-level API |
| **5** Generate new PDF | สร้าง "Corrected PDF" ใหม่ | 2-3 วัน | structured PDF | สูง | layout เปลี่ยน (ไม่ใช่ edit) |

---

## 5. ปัญหาเฉพาะของ Requirements

### 5.1 Pixel-perfect (R5) — ⚠️ Fontmatching คือกำแพง

**Pdf-lib (open source ที่ใช้ได้ฟรี) ไม่สามารถ reuse embedded font จาก original PDF ได้ผ่าน high-level API**

ตัวเลือก font ของ pdf-lib:
- **Standard fonts** (Helvetica, Times, Courier — built-in)
- **Embed font ใหม่** (เช่น Noto Sans จาก Google Fonts)
- **ไม่มี API ง่ายๆ** สำหรับการดึง font ที่ embed ใน PDF เดิมมาใช้ต่อ

**ผลคือ:** ข้อความใหม่จะใช้ font Helvetica/Times → visual ไม่ตรง 100%
**Pixel-perfect ผ่านได้เฉพาะ** กรณี original PDF ใช้ font เดียวกับที่เรา embed (ความบังเอิญต่ำ)

### 5.2 Audit-clean (R1: Enterprise) — ⚠️ Whiteout ทำ audit fail

Whiteout + overlay = ตัวอักษรเดิมยังอยู่ใน content stream
- **Ctrl+F หาเจอ** text เดิมที่ทาทับ
- Text extraction tools เห็นทั้ง 2 versions
- Forensic analysis เจอ "เปลี่ยนแปลง"

Enterprise compliance ส่วนใหญ่ **ไม่ยอมรับ** เพราะ:
- ดูเหมือนพยายามซ่อนข้อมูล
- ขัด "data integrity" requirements
- ขัด GDPR/PDPA "right to know what's processed"

### 5.3 No budget (R6) — ⚠️ ตัด commercial libraries ออก

**Commercial libraries ที่ทำได้ดี:**
| Library | License | Cost (estimate) |
|--|--|--|
| Apryse (PDFTron) | Commercial | ~$3,000-50,000/ปี |
| Foxit PDF SDK | Commercial | $5,000+/ปี |
| iText | AGPL / Commercial | $4,500+/ปี |
| MuPDF | AGPL / Commercial | ~$2,500/ปี (commercial license) |

→ **ใช้ไม่ได้** สำหรับ constraint นี้

**Open source ที่เป็นไปได้:**
- **pdf-lib** (MIT) — ที่ใช้อยู่แล้วใน deps. Limited editing capability.
- **pdf.js** (Apache 2.0) — render only ไม่ edit
- **PDFKit** (MIT) — generate PDF only ไม่ edit existing
- **MuPDF** (AGPL) — ต้อง open source ทั้ง app หรือซื้อ commercial license

---

## 6. ทางเลือกสำหรับ Requirements ปัจจุบัน

### Option A — Whiteout + overlay (MVP)
- ⏱ Live ใน 1-2 สัปดาห์
- ใช้ Helvetica/Times standard
- **❌ ไม่ผ่าน audit** (text เดิมซ่อนอยู่)
- **⚠️ ไม่ pixel-perfect** (font ต่าง)
- ✅ ทำงานทุก PDF, code ง่าย

### Option B — Real content-stream edit
- ⏱ Live ใน 4-6 สัปดาห์
- ✅ ผ่าน audit (แก้ของจริง)
- ✅ Pixel-perfect (ใช้ font เดิม — ถ้า parse ได้)
- ❌ Fragile (PDF format ซับซ้อน, edge cases เยอะ)
- ❌ ต้อง maintenance ยาว

### Option C — Hybrid (Whiteout + XMP audit log) ⭐ แนะนำ
- ⏱ Live ใน 2-3 สัปดาห์
- Whiteout + overlay สำหรับ visual edit
- **บวกกับ** ฝัง XMP metadata audit trail ใน PDF เก็บ:
  - field ที่แก้แต่ละจุด
  - ค่าเก่า / ค่าใหม่
  - timestamp + user ID + reason
  - signature/hash ของการแก้
- Enterprise audit tools อ่าน XMP → เห็นประวัติแก้ครบ
- **⚠️ ยัง not pixel-perfect** (font ต่าง) — แต่ audit-clean
- ✅ ความเสี่ยง compliance ลดลงมาก

### Option D — Generate "Corrected PDF" (Cleanest)
- ⏱ Live ใน 2-3 สัปดาห์
- สร้าง PDF ใหม่หมดด้วยค่าที่แก้แล้ว — **ไม่แก้ของเดิม**
- 100% clean (no whiteout, no hidden text)
- ✅ Audit-clean สมบูรณ์
- ⚠️ **Layout เปลี่ยน** (ไม่ใช่ "edit" จริง — เป็น regenerate)
- เหมาะถ้า PDF เป็น structured form/invoice ที่ใช้ template ได้
- ไม่เหมาะถ้า PDF มี layout ซับซ้อน/รูปภาพ/header-footer พิเศษ

---

## 7. คำถามที่ต้องคุยและตัดสิน

| # | คำถาม | กระทบ option ไหน |
|--|--|--|
| **Q1** | **Audit fail = hard blocker ไหม?** Whiteout = ตัวอักษรเดิมยังอยู่ในไฟล์ ผ่าน text extraction / forensic เจอได้. | A → ❌ ตัด, C/D → ✅ พิจารณา |
| **Q2** | **Layout เปลี่ยนได้ไหม?** Option D สร้างใหม่ → คงค่าครบแต่หน้าตาต่าง original | D → ✅ ถ้ายอมรับ |
| **Q3** | **XMP metadata audit trail** ตอบโจทย์ compliance ของ Enterprise ที่คุณตั้งเป้าไหม? — หรือต้องการ "ของเดิมหายจริง" | C ตัดสิน ใช้ได้/ไม่ได้ |
| **Q4** | **Pixel-perfect priority** vs **Audit-clean priority** — เลือกอะไรก่อน? | trade-off หลัก |
| **Q5** | **Acceptable font tolerance** — Helvetica แทนของเดิมรับได้ไหม? ใช้ "ใกล้เคียง" + watermark "EDITED" พอไหม? | A/C — กำหนด UX |
| **Q6** | **Use case จริงเป็น invoice / form / contract / freeform PDF**? — ถ้าเป็น structured form → D เหมาะมาก | D ตัดสิน fit |
| **Q7** | **Maintenance budget สำหรับ Option B** — ทีมมีคนพร้อมดูแล PDF parsing edge cases ระยะยาวไหม? | B feasibility |
| **Q8** | **Bulk apply UX** — กดปุ่มเดียวแก้ทุกความต่าง vs ทีละ field — preference? | ขนาด UI ทำ |
| **Q9** | **Permissions/role** — ใครแก้ได้บ้าง? ต้อง log per user ไหม? Sign-off step? | XMP audit shape |
| **Q10** | **เก็บ original PDF + edited version ทั้งคู่** ใน R2 ไหม? versioning? | ผูกกับ M2 (retention) |

---

## 8. ความเสี่ยงทางกฎหมาย / Compliance

> Disclaimer: ไม่ใช่คำแนะนำทางกฎหมาย — ควรปรึกษาทนาย/compliance officer ก่อนใช้งานจริง

| Risk | คำอธิบาย |
|--|--|
| **Document integrity** | การแก้ PDF ของลูกค้า → อาจถือว่า "ปลอมแปลงเอกสาร" ในบางบริบท (โดยเฉพาะใบกำกับภาษี, สัญญา) |
| **Audit trail requirement** | PDPA + SOX + ISO 27001 มักต้องการ tamper-evident audit log |
| **e-Signature impact** | PDF ที่มี digital signature → การแก้ทำให้ signature invalid |
| **Original preservation** | บางประเทศบังคับเก็บ original ไม่ลบ — แก้ = สร้าง version ใหม่ ไม่ใช่ replace |
| **Permission to edit** | ลูกค้าให้สิทธิเราแก้เอกสารของเขา/ของคู่ค้าได้ไหม? — ต้องระบุใน ToS |

---

## 9. Dependency กับ feature อื่นในระบบ

| Feature | Dependency |
|--|--|
| **OCR Lifecycle M2** (R2 file retention) | PDF Edit ต้องการ original bytes → ใช้ของจาก M2 ได้ตรงๆ ไม่ต้องอัปโหลดซ้ำ |
| **Compare highlight bbox** | AI ตอบ ratio 0-1 → ใช้ map กลับ PDF coords ได้ทันที |
| **Document versioning** | ถ้าทำ Edit → ต้องคิด version history (`v1 original`, `v2 edited`, ...) |
| **Audit log table** | ต้องสร้าง table ใหม่ `pdf_edits` หรือ extend `system_events` |
| **Credit/pricing** | คิดเงิน per edit operation? เป็น premium feature? |

---

## 10. คำแนะนำ (ของ AI assistant — รอ team ยืนยัน)

ภายใต้ constraint:
- Enterprise + Audit-clean = **must**
- No budget = **must**
- Pixel-perfect = nice-to-have

→ **เริ่มจาก Option C (Hybrid: Whiteout + XMP audit log)** เป็น MVP
- 2-3 สัปดาห์ ship ได้
- ผ่าน compliance พื้นฐาน
- ถ้าหลัง MVP user feedback ว่า "ฟอนต์ดูยี้" → ค่อยตัดสินใจลงทุน Option B หรือ commercial lib

**ทางเลือกสำรอง: Option D** ถ้าทุก PDF เป็น structured form → สะอาดกว่ามาก
แต่ถ้า PDF หลายแบบ (form + freeform + contract) → D ไม่เหมาะกับทุกกรณี

---

## 11. งานที่เกี่ยวข้องใน Backlog

- บันทึกเข้า [docs/DECISION_BACKLOG.html](DECISION_BACKLOG.html) เป็นหัวข้อใหม่
- เกี่ยวกับ [project_ocr_lifecycle_compare_rework](OCR_LIFECYCLE_AND_COMPARE_REWORK_PLAN.md) M2 (R2 retention)
- ถ้าตัดสินทำ → เพิ่มเป็น Phase ใหม่ใน roadmap (Phase 8: PDF Edit?)

---

## 12. Next steps

1. คุยกับทีม / stakeholder → ตอบคำถาม Q1-Q10
2. ปรึกษา legal/compliance officer สำหรับความเสี่ยง §8
3. ตัดสิน Option (A / B / C / D / combination)
4. ถ้าเลือก → ทำ detailed implementation plan (เหมือน OCR_LIFECYCLE_AND_COMPARE_REWORK_PLAN.md)
5. ตัดสินใจ priority vs feature อื่นใน decision backlog
