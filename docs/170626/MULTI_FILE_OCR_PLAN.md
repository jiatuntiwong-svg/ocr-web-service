# Multi-File OCR → Single Summary Export — Implementation Plan

> สถานะ: ร่างแผน (ยังไม่เริ่ม implement)
> เป้าหมาย: ให้ OCR Workspace อัปโหลดได้ทีละหลายไฟล์ แล้วสรุปผลทั้งหมดเป็น
> ไฟล์เดียว (Excel / CSV) โดยไม่ต้องรื้อ backend

---

## 1. สรุปของเดิม (รองรับทีละ 1 ไฟล์)

**Frontend — `src/components/OCRWorkspace.tsx`**
- เก็บ `file: File | null` แค่ไฟล์เดียว (บรรทัด ~56)
- `<input type="file">` ไม่มี `multiple` (บรรทัด ~931)
- `handleUpload()` ส่ง 1 ไฟล์ → ได้ `documentId` → `poll()` เช็คสถานะ (บรรทัด ~332–399)
- Export ทีละ 1 เอกสารผ่าน `exportOCRResult` (`src/lib/exportUtils.ts:22`)

**Backend — `src/app/api/upload/route.ts`**
- รับ `file` เดียวต่อ 1 request
- หักเครดิตต่อไฟล์ (charge หลัง OCR สำเร็จเท่านั้น)
- ประมวลผล async (`ctx.waitUntil`) แล้วเก็บลง D1 → เช็คผลผ่าน `src/app/api/status/route.ts`

**ข้อสรุป:** ทำได้ และทำได้แบบ **ไม่ต้องแตะ backend** — orchestrate ที่ frontend
โดยวนยิง `/api/upload` เดิมทีละไฟล์ เพราะ logic หักเครดิต / แจ้งเตือน / retention
ทำงานต่อไฟล์อยู่แล้ว reuse ได้ทันที และถ้าไฟล์ใดพังก็ไม่ล้มทั้งชุด

---

## 2. การตัดสินใจที่ยืนยันแล้ว

| ประเด็น | ตัวเลือกที่เลือก |
|---|---|
| รูปแบบไฟล์สรุปรวม | **1 แถว = 1 ไฟล์** (คอลัมน์ = field ทั้งหมด) |
| เครดิตไม่พอครบทุกไฟล์ | **ทำเท่าที่เครดิตพอ** — ไฟล์ที่ไม่พอทำเครื่องหมาย "ข้าม" |
| จำนวนไฟล์สูงสุด/ครั้ง | เริ่มที่ **10 ไฟล์** แต่ทำให้ **ปรับได้ง่าย** เพื่อทดสอบหา limit จริง |
| Concurrency | ยิงพร้อมกันสูงสุด **3 ไฟล์** (กัน rate limit ของ Gemini) |
| อัปโหลดไฟล์เดิมซ้ำ | **overwrite ทับ row เดิม** (ไม่แยก row ใหม่) + เก็บแค่ผลล่าสุด |
| Stamp จำนวนครั้ง OCR | นับเก็บเป็นตัวเลข `ocr_count` (ไม่เก็บประวัติรายครั้ง) |
| จุดยึดระบุ "เอกสารเดียวกัน" | **ชื่อไฟล์** เป็นค่าเริ่มต้น + ออกแบบให้สลับเป็น field ที่กำหนดเองได้ |

---

## 3. ขอบเขตงาน

### 3.1 `src/components/OCRWorkspace.tsx` (งานหลัก)
- เปลี่ยน state `file: File | null` → `files: File[]`
- เพิ่ม `multiple` ที่ `<input type="file">` + drag & drop รับหลายไฟล์
- บังคับเพดานจำนวนไฟล์ด้วยค่าคงที่ตัวเดียว (ดู §5) — เกินให้แจ้งเตือนและตัดส่วนเกินทิ้ง
- UI รายการไฟล์: ชื่อไฟล์ + สถานะรายไฟล์ + ปุ่มลบรายไฟล์
  - สถานะ: `queued → processing → done ✓ / error ✗ / skipped (เครดิตไม่พอ)`
- Batch runner: วนอัปโหลด + poll แบบจำกัด concurrency (ดู §5)
  - เก็บผลเป็น `results: { fileName: string; data: Record<string, any> }[]`
  - ไฟล์ที่ backend ตอบ `INSUFFICIENT_CREDITS` → mark `skipped`, ทำไฟล์ต่อไป
  - ไฟล์ที่ status = `error` → mark `error`, ไม่รวมใน output
- Progress รวม เช่น "กำลังประมวลผล 4/10 ไฟล์"
- ปุ่ม export เปลี่ยนเป็น **"ดาวน์โหลดสรุปรวม"** เรียก `exportOCRBatch` (ดู §3.2)

### 3.2 `src/lib/exportUtils.ts` — เพิ่ม `exportOCRBatch(results, filename, format)`
- Sheet **"Summary"**: 1 แถว = 1 ไฟล์
  - คอลัมน์ = `File` + union ของทุก field ที่พบในทุกไฟล์ (ไฟล์ที่ขาด field → เว้นว่าง)
  - unwrap `{ value, confidence }` → ใช้ `value` (เหมือน `exportOCRResult` เดิม)
- Field ประเภท table (ค่าเป็น array of object): รวมทุกแถวไว้ sheet เดียวต่อ field
  - เพิ่มคอลัมน์ `Source File` เพื่อบอกว่าแถวนั้นมาจากไฟล์ใด
- รองรับ `.xlsx` และ `.csv`
  - หมายเหตุ: CSV เก็บได้แค่ sheet เดียว → export CSV จะได้เฉพาะ "Summary"
    (แจ้งผู้ใช้ หรือแนะนำให้ใช้ Excel เมื่อมี table field)

### 3.3 i18n — `src/lib/i18n`
- เพิ่มข้อความ TH/EN: สถานะรายไฟล์, ปุ่ม "ดาวน์โหลดสรุปรวม",
  แจ้งเตือน "เกิน N ไฟล์", "ข้ามเพราะเครดิตไม่พอ", progress รวม

### 3.4 สิ่งที่ **ไม่ต้องทำ**
- ไม่แก้ DB schema
- ไม่แก้ credit / notification / retention logic
- ไม่เพิ่ม API endpoint ใหม่ (`/api/upload`, `/api/status` ใช้เดิม)

---

## 4. Flow การทำงาน (frontend orchestration)

```
เลือกหลายไฟล์ (≤ MAX_BATCH_FILES)
        │
        ▼
   batch runner (concurrency = OCR_BATCH_CONCURRENCY)
        │  ต่อไฟล์:
        │   1) POST /api/upload  → documentId
        │   2) poll /api/status?id=…  จน completed / error
        │   3) completed → push เข้า results[]
        │      INSUFFICIENT_CREDITS → mark skipped
        │      error → mark error
        ▼
  ครบทุกไฟล์ → เปิดปุ่ม "ดาวน์โหลดสรุปรวม"
        │
        ▼
  exportOCRBatch(results) → ไฟล์เดียว (.xlsx / .csv)
```

---

## 5. ทำให้ "limit" ปรับง่าย + ทดสอบหา max จริง

### 5.1 รวมค่าคุมไว้ที่ไฟล์ config เดียว
สร้างไฟล์ใหม่ `src/lib/ocrBatchConfig.ts` เก็บทุกค่าที่ต้องจูน เพื่อแก้ที่เดียวจบ:

```ts
// src/lib/ocrBatchConfig.ts
// ปรับค่าทั้งหมดของ batch OCR ที่นี่ที่เดียว — แก้แล้วมีผลทั้ง UI และ runner

/** จำนวนไฟล์สูงสุดต่อการอัปโหลด 1 ครั้ง. ตั้ง 10 เป็นค่าเริ่มต้น.
 *  เพิ่มค่านี้เพื่อทดสอบหา limit จริง (ดู §5.2). */
export const MAX_BATCH_FILES = 10;

/** จำนวนไฟล์ที่ยิงขนานพร้อมกัน. สูงไป = เสี่ยง rate limit ของ Gemini. */
export const OCR_BATCH_CONCURRENCY = 3;

/** เพดานเวลารวมต่อ 1 ไฟล์ (ms) ก่อนถือว่า timeout แล้ว mark error.
 *  กัน poll ค้างถ้าไฟล์ไหนค้างฝั่ง backend. */
export const PER_FILE_TIMEOUT_MS = 120_000;
```

- `OCRWorkspace.tsx` import `MAX_BATCH_FILES` มาใช้ทั้งในการ validate ตอนเลือกไฟล์
  และข้อความแจ้งเตือน (ไม่ hardcode เลข 10 ที่อื่น)
- ปรับ limit = แก้บรรทัดเดียวใน `ocrBatchConfig.ts`

### 5.2 (ทางเลือก) override ผ่าน env เพื่อทดสอบไม่ต้องแก้โค้ด
ถ้าอยากจูนตอน dev โดยไม่ commit:

```ts
export const MAX_BATCH_FILES =
    Number(process.env.NEXT_PUBLIC_MAX_BATCH_FILES) || 10;
```

แล้วใส่ใน `.dev.vars` / `.env.local`:
```
NEXT_PUBLIC_MAX_BATCH_FILES=25
```
> ใช้ prefix `NEXT_PUBLIC_` เพราะค่านี้ถูกอ่านฝั่ง client (UI)

### 5.3 ขั้นตอนทดสอบหา limit จริง
ทดสอบเพื่อหาว่า "สูงสุดกี่ไฟล์ถึงจะยังเสถียร" — ตัวแปรที่ชนเพดานก่อนมักเป็น
**rate limit ของ Gemini** และ **เวลา/หน่วยความจำฝั่ง browser** (ไม่ใช่ backend
เพราะแต่ละไฟล์เป็น request แยก)

1. ตั้ง `MAX_BATCH_FILES` สูง (เช่น 50) ชั่วคราว
2. อัปโหลดชุดทดสอบ 10 → 20 → 30 → … ไฟล์ (ใช้ไฟล์ตัวอย่างซ้ำได้)
3. จับตา 3 สัญญาณนี้:
   - **Rate limit / 429** จาก Gemini ใน log (`OCR_EXTRACTION_ERROR`) → ลด
     `OCR_BATCH_CONCURRENCY` หรือเพิ่ม delay ระหว่างไฟล์
   - **เครดิตหมดกลางคัน** → เป็นไปตามดีไซน์ (mark skipped) ไม่ใช่ bug
   - **Browser ค้าง/ช้า** ตอน export → ขนาด workbook ใหญ่เกิน → จุดนี้คือ
     limit ฝั่ง client
4. ตั้ง `MAX_BATCH_FILES` กลับเป็นค่าที่ "ต่ำกว่าจุดเริ่มมีปัญหา" สัก buffer หนึ่ง
5. บันทึกตัวเลขที่ได้ไว้ในไฟล์นี้ (ตาราง §5.4)

### 5.4 บันทึกผลทดสอบ (เติมหลังทดสอบจริง)

| จำนวนไฟล์ | concurrency | ผลลัพธ์ | หมายเหตุ |
|---|---|---|---|
| 10 | 3 | — | (รอทดสอบ) |
| 20 | 3 | — | |
| 30 | 3 | — | |

---

## 6. จุดที่ต้องระวัง
- **Rate limit ของ Gemini** — คุมด้วย `OCR_BATCH_CONCURRENCY`; ถ้าเจอ 429 ให้ลดค่า
- แต่ละไฟล์ยังเป็น 1 document แยกในประวัติตามเดิม — การสรุปรวมเกิดตอน export เท่านั้น
- เครดิตหักต่อไฟล์ → batch ใหญ่อาจหมดเครดิตกลางคัน (ดีไซน์: mark skipped, ทำต่อ)
- CSV รองรับ sheet เดียว → ถ้ามี table field แนะนำ export เป็น Excel

---

## 7. ลำดับการ implement ที่เสนอ (ส่วน Multi-file)
1. เพิ่ม `src/lib/ocrBatchConfig.ts` (§5.1)
2. เพิ่ม `exportOCRBatch` ใน `exportUtils.ts` (§3.2)
3. ปรับ `OCRWorkspace.tsx`: state + UI หลายไฟล์ + batch runner (§3.1)
4. เพิ่มข้อความ i18n (§3.3)
5. ทดสอบหา limit จริง + เติมตาราง §5.4

---

# ส่วนที่ 2 — บันทึกลง DB + Stamp จำนวนครั้งที่ส่ง OCR

## 8. โจทย์
ผู้ใช้ต้องการ:
- อัปโหลดไฟล์ **เดิมซ้ำ** → ให้ **update ทับข้อมูลเดิม** (ไม่สร้าง row ใหม่ทุกครั้ง)
- มี **stamp** บอกว่าเอกสารนี้ "ถูกส่งมา OCR กี่ครั้ง" (เก็บแค่ตัวเลข)
- จุดยึดว่าเป็น "เอกสารเดียวกัน" = **ชื่อไฟล์** หรือ field ที่กำหนดเองได้
  (เนื้อหาอาจต่างกันเล็กน้อยระหว่างครั้ง → ใช้ content hash ไม่ได้)

## 9. ปัญหาเชิงโครงสร้างปัจจุบัน
`src/app/api/upload/route.ts:26` สร้าง row ใหม่ทุกครั้งด้วย UUID ใหม่:
```ts
const docId = crypto.randomUUID();   // → ทุกอัปโหลด = row ใหม่เสมอ
```
ระบบจึง **ไม่รู้ว่าเป็นเอกสารเดียวกัน** ต้องเพิ่มแนวคิด "document key" (จุดยึด)
แล้วทำ find-or-create + overwrite

## 10. การเปลี่ยน Database

ไฟล์ migration ใหม่: `db/migrations/document_ocr_stamp.sql`
```sql
-- จุดยึดระบุเอกสารเดียวกัน (ค่าเริ่มต้น = ชื่อไฟล์ที่ normalize แล้ว)
ALTER TABLE documents ADD COLUMN document_key TEXT;
-- จำนวนครั้งที่ส่ง OCR (stamp) — เริ่มที่ 1 เมื่อสร้างครั้งแรก
ALTER TABLE documents ADD COLUMN ocr_count INTEGER DEFAULT 1;
-- เวลา OCR ล่าสุด (created_at เดิม = ครั้งแรก)
ALTER TABLE documents ADD COLUMN last_ocr_at DATETIME;

-- ใช้ค้นหา canonical row เร็ว ๆ ตอน find-or-create
CREATE INDEX IF NOT EXISTS idx_documents_user_key
  ON documents(user_id, document_key, type);
```
> ใช้ app-level dedup (SELECT ก่อน INSERT) ไม่ใส่ UNIQUE constraint เพื่อไม่ให้
> ชน row เดิมในฐานข้อมูล production ที่อาจมีชื่อไฟล์ซ้ำอยู่แล้ว

## 11. การเปลี่ยน Backend — `src/app/api/upload/route.ts`

### 11.1 helper ระบุ document key (ทำให้สลับจุดยึดได้ง่าย)
ไฟล์ใหม่ `src/lib/documentKey.ts` — รวม logic จุดยึดไว้ที่เดียว:
```ts
// ค่าเริ่มต้น = ชื่อไฟล์ normalize (ตัดช่องว่าง + lowercase)
// อนาคต: เพิ่ม anchor แบบ "ค่าจาก field ที่ผู้ใช้เลือก" ได้ที่ฟังก์ชันเดียวนี้
export function resolveDocumentKey(opts: {
  fileName: string;
  anchor?: "filename" | { field: string; value: string };
}): string {
  if (opts.anchor && opts.anchor !== "filename") {
    return `field:${opts.anchor.field}=${opts.anchor.value}`.trim().toLowerCase();
  }
  return opts.fileName.trim().toLowerCase();
}
```

### 11.2 flow ใหม่ (find-or-create + overwrite + stamp)
```
1. docKey = resolveDocumentKey({ fileName })
2. existing = SELECT id, ocr_count FROM documents
              WHERE user_id=? AND document_key=? AND type='ocr'
3. ถ้าเจอ (re-upload):
     docId = existing.id
     UPDATE documents SET
        ocr_count = ocr_count + 1,   -- stamp +1
        status='processing',
        last_ocr_at = CURRENT_TIMESTAMP
     WHERE id = docId
   ถ้าไม่เจอ (ครั้งแรก):
     docId = crypto.randomUUID()
     INSERT ... document_key=docKey, ocr_count=1,
            last_ocr_at=CURRENT_TIMESTAMP
4. รัน OCR ตามเดิม
5. เมื่อสำเร็จ → overwrite ผลทับ:
     UPDATE documents SET raw_json=?, processing_time_ms=?, status='completed'
     -- extracted_data: ลบของเดิมแล้วใส่ใหม่ (overwrite)
     DELETE FROM extracted_data WHERE doc_id = docId;
     INSERT INTO extracted_data ...
```
> **stamp นับ "จำนวนครั้งที่ส่ง"** → increment ที่ขั้นที่ 3 (ตอนรับงาน)
> ไม่ใช่ตอน OCR สำเร็จ เพื่อให้ตรงความหมาย "ถูกส่งมา OCR กี่ครั้ง"
>
> เครดิตยังหักต่อครั้งตามเดิม (การ re-OCR คือการประมวลผลใหม่จริง)

## 12. การเปลี่ยน Frontend (แสดง stamp)
- `src/app/api/status/route.ts` — เพิ่ม `ocr_count`, `last_ocr_at` ใน response
- `src/components/DocumentsView.tsx` — แสดง badge เช่น "ส่ง OCR แล้ว 3 ครั้ง"
- `src/components/OCRWorkspace.tsx` — แสดง stamp บนผลลัพธ์ + ถ้าเป็นการอัปโหลดซ้ำ
  อาจแจ้ง "อัปเดตเอกสารเดิม (ครั้งที่ N)"
- i18n: เพิ่มข้อความ stamp TH/EN

## 13. (อนาคต / ทางเลือก) จุดยึดแบบกำหนดเอง
ถ้าต้องการให้ "จุดยึด" เป็นค่าจาก field ที่สกัดได้ (เช่น เลขที่ใบกำกับ) แทนชื่อไฟล์:
- ค่า anchor รู้ได้ **หลัง** OCR → ต้องเลื่อน dedup ไปทำหลังสกัดเสร็จ
  (insert ชั่วคราว → OCR → หา canonical จากค่า field → merge + ลบ temp)
- ซับซ้อนกว่า จึงทำ **ชื่อไฟล์ก่อน (เฟส 1)** แล้วเพิ่ม anchor นี้ทีหลังที่
  `resolveDocumentKey` ฟังก์ชันเดียว — ส่วนอื่นไม่ต้องแก้

## 14. จุดที่ต้องระวัง (ส่วน DB/Stamp)
- เลือก document key จากชื่อไฟล์ → ไฟล์คนละเนื้อหาแต่ชื่อซ้ำจะถูกมองเป็นเอกสารเดียว
  (ผู้ใช้ยอมรับ trade-off นี้แล้ว) — เตือนผู้ใช้ตอนตรวจพบการอัปโหลดซ้ำได้
- การ overwrite ทำให้ผลเดิม**หายถาวร** — ถ้าต้องการกันพลาด อาจเก็บ `raw_json` ก่อนหน้า
  1 เวอร์ชันไว้ (ยังไม่อยู่ในขอบเขตนี้)
- dedup เป็นแบบ per-user (scope ด้วย `user_id`) — ผู้ใช้คนละคนไม่ชนกัน

## 15. ลำดับการ implement ที่เสนอ (ส่วน DB/Stamp)
1. migration `document_ocr_stamp.sql` (§10)
2. helper `src/lib/documentKey.ts` (§11.1)
3. ปรับ `upload/route.ts`: find-or-create + overwrite + stamp (§11.2)
4. คืน `ocr_count` ใน `status/route.ts` + แสดง badge ใน DocumentsView / OCRWorkspace (§12)
5. i18n + ทดสอบอัปโหลดซ้ำว่าตัวนับเพิ่มและข้อมูลถูก overwrite



## 16. เพิ่มให้สามารถอ่านไฟล์ docx ได้และเพิ่มระบบ zoom เอกสารเหมือนของ compare 
