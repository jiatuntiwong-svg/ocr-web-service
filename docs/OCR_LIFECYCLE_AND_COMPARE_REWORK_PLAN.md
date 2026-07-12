# OCR Lifecycle + Compare Rework — Decision Record + Plan

> สถานะ: **DECISIONS LOCKED, NOT IMPLEMENTED YET**
> วันที่บันทึก: 2026-06-18
> ขอบเขต: 2 งานที่ผูกกัน
> 1. **OCR re-upload lifecycle** (dedup + stamp count + overwrite)
> 2. **Compare rework** — เปลี่ยน Compare เป็น downstream consumer ที่อ่านจาก OCR store

---

## 0. Architectural Principle (สำคัญที่สุด)

> **OCR คือทางเข้าเดียวของระบบ. ทุก document ที่ระบบรู้จัก = ผ่าน OCR มาก่อน.**
> **Compare = downstream consumer — ไม่ ingest ไฟล์เอง, ดึงจาก OCR store.**

ผลที่ตามมา:
- ลบ "Compare = อัปโหลดไฟล์เปรียบเทียบ" ออก → กลายเป็น "เลือก document ที่ OCR แล้ว"
- ถ้า user ต้องการ compare ไฟล์ที่ไม่เคย OCR → flow จะ "auto OCR ก่อน แล้ว compare"
- documents table = single source of truth สำหรับเอกสารทั้งหมด

---

## ส่วนที่ 1 — OCR Re-Upload Lifecycle

### 1.1 โจทย์
อัปโหลดไฟล์เดิมซ้ำ → **update ทับ** (ไม่สร้าง row ใหม่) + stamp นับจำนวนครั้งที่ OCR

### 1.2 Decisions ที่ตัดสินใจแล้ว

| # | ประเด็น | คำตอบ |
|--|--|--|
| L1 | จุดยึดระบุเอกสารเดียวกัน | **ชื่อไฟล์** (เริ่มต้น), ออกแบบ helper ให้สลับเป็น field-based ได้อนาคต |
| L2 | Backfill row เก่า | **ทำด้วย** — รวมเป็น 1 row ต่อ `(user, document_key)`, `ocr_count = นับ row เก่า`, เลือก latest เป็น canonical |
| L3 | แจ้งเตือน re-upload | **Modal บล็อก** + checkbox "ไม่ต้องถามอีก"; batch mode = รวบเป็นครั้งเดียว ("3 ไฟล์ซ้ำ: ทำต่อทั้งหมด / ข้ามไฟล์ซ้ำ / เลือกรายไฟล์") |
| L4 | Normalize ชื่อไฟล์ | `trim().toLowerCase()` + **NFC Unicode normalize** + **ตัด `(N)` suffix** (กัน browser auto-rename) |
| L5 | Template ต่างตอน re-upload | **Overwrite หมด** — ฟิลด์เดิมที่ใหม่ไม่มีจะหาย; modal warn ให้ชัด |
| L6 | Race ใน batch (ไฟล์ชื่อซ้ำในรอบเดียวกัน) | **dedup ก่อนยิง** ที่ batch runner (app-level) ไม่พึ่ง DB UNIQUE |
| L7 | Notification re-upload | **ส่งทุกครั้ง** ผู้ใช้รู้ว่า OCR เสร็จ |
| L8 | DocumentsView sort | `last_ocr_at DESC` (ล่าสุด); แสดง 2 timestamps "อัปเดต X / สร้าง Y" |

### 1.3 DB Schema
ไฟล์ใหม่: `db/migrations/document_ocr_stamp.sql`
```sql
ALTER TABLE documents ADD COLUMN document_key TEXT;
ALTER TABLE documents ADD COLUMN ocr_count INTEGER DEFAULT 1;
ALTER TABLE documents ADD COLUMN last_ocr_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_documents_user_key
  ON documents(user_id, document_key, type);
```

Backfill script (รัน 1 ครั้งหลัง alter):
```sql
-- 1. เติม document_key ให้ row เก่าทั้งหมด (lowercase + trim + NFC + strip (N))
--    → ทำใน script Node ที่ apply normalize logic แล้ว UPDATE
-- 2. รวม row ซ้ำ (user_id, document_key, type='ocr') → เก็บ latest, set ocr_count = COUNT, ลบ row อื่น
-- 3. last_ocr_at = MAX(created_at) ของ row ที่รวม
```

### 1.4 ขอบเขตงานสรุป
1. Migration + backfill script
2. `src/lib/documentKey.ts` — helper normalize + future-proof anchor
3. `src/app/api/upload/route.ts` — find-or-create + overwrite + stamp
4. `src/app/api/status/route.ts` — return `ocr_count`, `last_ocr_at`
5. `src/components/OCRWorkspace.tsx` — re-upload modal + batch dedup detection
6. `src/components/DocumentsView.tsx` — badge "OCR แล้ว N ครั้ง", 2 timestamps
7. i18n TH/EN
8. ทดสอบ flow re-upload (single + batch)

---

## ส่วนที่ 2 — Compare Rework (เป็น downstream consumer ของ OCR)

### 2.1 โจทย์
เปลี่ยน Compare จาก "ingest ไฟล์เอง" → "เลือก document ที่ OCR แล้ว"

### 2.2 Decisions ที่ตัดสินใจแล้ว

| # | ประเด็น | คำตอบ |
|--|--|--|
| C1 | Highlight สำคัญ? | **A — ขาดไม่ได้** (เป็น value proposition หลัก) → ต้องเก็บไฟล์ |
| C2 | File retention policy | **TBD — เก็บแบบจำนวนไฟล์ต่อ tier** เช่น Free=100, Pro=ตลอด (รอตัดสินตัวเลข) |
| C3 | Field ที่ต้อง compare ไม่อยู่ใน OCR | **Ask + Partial (C+D)** — modal: "field 'X' ไม่มี: 'Re-OCR ใหม่ (N เครดิต)' / 'ดูเฉพาะ field ที่มี (ฟรี)'" |
| C4 | OCR ของ source doc เปลี่ยน (re-OCR) | **Live reference** — compare อ่าน document state ปัจจุบันเสมอ. Semantic: "re-OCR = เอกสารถูกแก้และเอามาตรวจซ้ำ", ผลล่าสุด = ผลที่ควรเห็น |
| C5 | ลบ document ที่มี compare อ้างอยู่ | **Block + บอก count** — "เอกสารนี้ถูกอ้างใน compare 3 รายการ ลบไม่ได้ — กรุณาลบ compare ก่อน" |
| C6 | Template ต่างระหว่าง 2 doc ใน compare | **เฉพาะ field ร่วม + warn** — แสดงเฉพาะ intersection, มี banner "doc A มี 5 field, doc B มี 3 field, compare เฉพาะ 3 field ที่ทั้งคู่มี" |
| C7 | Credit charge | **Compare cost เท่านั้น** (OCR ใช้ของเดิม ไม่หักซ้ำ); ถ้า user เลือก re-OCR ใน C3 → หัก OCR cost ปกติ |
| C8 | UI doc picker | **List + search + drag** — list view มี search box, รองรับ drag จาก documents tab/sidebar ไปลง compare slot |

### 2.3 ผลกระทบเชิงโครงสร้าง

#### 2.3.1 ลบ R2 delete หลัง OCR success
`src/app/api/upload/route.ts:210` — ปัจจุบัน `env.BUCKET.delete(fileName)`
→ ต้องเปลี่ยนเป็น **เก็บไฟล์ใน R2** (เพราะ Compare ต้องการ render highlight)
→ ต้องเพิ่ม column `file_key` ใน documents เพื่อรู้ว่า R2 object อยู่ที่ไหน
→ ต้อง enforce retention policy (C2 — TBD)

#### 2.3.2 DB Schema — table `comparisons` ใหม่ (แทนที่ row type='compare' เดิม)
```sql
CREATE TABLE IF NOT EXISTS comparisons (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  doc_a_id    TEXT NOT NULL REFERENCES documents(id),
  doc_b_id    TEXT NOT NULL REFERENCES documents(id),
  diff_json   TEXT,             -- AI diff output
  field_scope TEXT,             -- JSON: list of fields used in this compare (สำหรับ C6)
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_run_at DATETIME,
  status      TEXT NOT NULL DEFAULT 'completed'
);
CREATE INDEX idx_comparisons_user      ON comparisons(user_id);
CREATE INDEX idx_comparisons_doc_a     ON comparisons(doc_a_id);
CREATE INDEX idx_comparisons_doc_b     ON comparisons(doc_b_id);
```

Migration:
- Backfill row เดิม `documents WHERE type='compare'` → unpack `file_name='A.pdf / B.pdf'` + `raw_json` → ย้ายเข้า comparisons (ต้อง infer doc_a/b_id จากชื่อไฟล์ → fragile, อาจต้องวิธีพิเศษหรือยอม drop history เก่า)

#### 2.3.3 Document deletion check (C5)
ก่อนลบ document → `SELECT COUNT(*) FROM comparisons WHERE doc_a_id=? OR doc_b_id=?`
→ ถ้า > 0 → block + return count

#### 2.3.4 Compare API rework — `/api/compare`
```
ปัจจุบัน: POST { files: [A, B] } → upload + OCR + AI compare → 1 row in documents

ใหม่:
  POST { docAId, docBId, fields[] }
    1. fetch doc A + doc B จาก documents (ต้อง user_id ตรง)
    2. ตรวจ field scope:
       - intersect(A.fields, B.fields, requested fields)
       - field ไหนขาด → return 400 { code: 'FIELDS_MISSING', missing: [...] }
         → frontend แสดง modal (C3: re-OCR / partial)
    3. fetch ไฟล์จาก R2 (ถ้าเก็บอยู่) — ถ้า expired → return 410 { code: 'FILE_EXPIRED', docId }
                                          → frontend ขอ re-upload
    4. AI compare → diff_json
    5. INSERT/UPDATE comparisons → return id
```

#### 2.3.5 UI changes
- **NavRail / Compare page** — เปลี่ยน entrypoint:
  - Default view: "เลือก 2 เอกสารจาก library ของคุณ"
  - List + search + drag (C8) — แสดง document ทั้งหมดของ user (type='ocr')
  - Slot A, Slot B — drag doc มาวาง หรือคลิก "+ Add" → modal เลือก
  - ถ้าไม่มี doc → guide "ยังไม่มีเอกสาร — ไปที่ OCR ก่อน"
  - ปุ่ม "Compare เอกสารใหม่" (ไฟล์ที่ไม่ใช่ของ library) → flow auto-OCR-then-compare
- **Documents page** — เพิ่ม action "Compare with..." ที่ document row → เปิด compare page พร้อม slot A เติมไว้

### 2.4 ขอบเขตงานสรุป
1. Migration: comparisons table + เพิ่ม `file_key` ใน documents + retention metadata
2. ลบ `BUCKET.delete()` ใน upload route + เก็บ `file_key`
3. Retention enforcement (TBD policy ตัวเลข)
4. รื้อ `/api/compare/route.ts` — ใช้ doc IDs แทน files
5. Field scope intersect + Partial compare logic
6. R2 expired → return code → frontend handle
7. Document deletion guard (C5)
8. `CompareWorkspace.tsx` รื้อ UI ใหม่ — doc picker (list + search + drag)
9. `DocumentsView.tsx` — "Compare with..." action
10. Migration script: unpack row type='compare' เดิม → comparisons (หรือ drop history with notice)
11. i18n TH/EN ครบ
12. ทดสอบทุก path: doc picker, partial compare, re-OCR upgrade, expired file, delete block

---

## 3. ลำดับ implement ที่แนะนำ

แบ่งเป็น 3 milestones:

### Milestone 1 — OCR Lifecycle (ส่วนที่ 1)
อิสระจาก Compare rework — ทำก่อนได้เลย ใช้คนเดียว ~3-4 วัน

### Milestone 2 — R2 retention + file_key
ก่อนเริ่ม Compare rework ต้องเลิกลบไฟล์ทันที + คิด retention เสร็จ ~1-2 วัน

### Milestone 3 — Compare Rework
หลังจาก M1 + M2 พร้อม → ~5-7 วัน

**ห้ามทำ M3 ก่อน M2** เพราะ M3 จะพังถ้าไม่มีไฟล์ใน R2

---

## 4. ยังต้องตัดสินใจเพิ่ม (TBD)

| # | ประเด็น | สถานะ |
|--|--|--|
| TBD1 | จำนวนไฟล์ retention ต่อ tier (C2) | Free=?, Basic=?, Pro=? |
| TBD2 | กลยุทธ์ลบเมื่อ user เกินจำนวนไฟล์ | ลบเก่าสุดอัตโนมัติ / แจ้งให้ user เลือกลบ / block upload ใหม่ |
| TBD3 | Field-based anchor (re-upload) | scope อนาคต — ยังไม่ทำ |
| TBD4 | Document soft-delete vs hard-delete | ตอนนี้สมมุติ hard; กระทบ C5 |
| TBD5 | Compare history migration | unpack row เก่า หรือ drop with notice? |
| TBD6 | "Compare เอกสารใหม่ที่ไม่ใช่ library" UX | auto-OCR แล้ว compare เลย หรือ require save เป็น doc ก่อน? |

---

## 5. เกี่ยวข้องกับ memory / docs อื่น

- ต่อยอดจาก [docs/170626/MULTI_FILE_OCR_PLAN.md](170626/MULTI_FILE_OCR_PLAN.md) §8-15 (re-upload lifecycle)
- แตะ [docs/170626/DOCUMENTS_MENU_DESIGN.md](170626/DOCUMENTS_MENU_DESIGN.md) (UI list + search)
- กระทบ [docs/PENDING_FEATURES_BACKLOG.md](PENDING_FEATURES_BACKLOG.md) — Phase 5 (EAV + search) จะใช้ schema นี้ต่อ
- กระทบ pricing model — credit per compare ยังเหมือนเดิม, แต่ OCR re-count = หักเครดิตจริง

---

## 6. ความเสี่ยง / risk register

| Risk | Likelihood | Impact | Mitigation |
|--|--|--|--|
| R2 cost พุ่ง (เก็บไฟล์ถาวร) | สูง | กลาง | retention policy + Cloudflare R2 pricing สบายๆ; ตรวจ cost รายสัปดาห์ |
| Backfill row เก่ารวมผิด (ชื่อพ้อง) | กลาง | สูง | dry-run script ก่อน, log ทุก merge, มี rollback SQL |
| Live ref ทำ compare เก่า "เปลี่ยน" → user งง | กลาง | กลาง | UX: แสดง "last data update X" + "compared at Y" + warn ถ้าต่างกัน |
| Migration compare row เก่า fail | สูง | ต่ำ | option drop history เก่า + notice "compare ก่อน 2026-XX-XX ไม่พร้อมใช้งาน" |
| User ที่ tier ต่ำเกินจำนวนไฟล์ | สูง | สูง | ออกแบบ retention UX ให้ชัด (TBD2) |
| Compare flow เก่าพังตอนเปลี่ยน | สูง | สูง | feature flag, deploy หลังบ้าน → migrate user เป็นกลุ่ม |

---

## 7. สรุปสั้น
> **OCR เป็นทางเข้าเดียว, Compare ดึงจาก OCR store, ต้องเก็บไฟล์ใน R2 (retention by count per tier), highlight ขาดไม่ได้.**
> M1 (OCR lifecycle) ทำก่อนได้ทันที — M2 + M3 รอตัดสิน TBD1-6 ให้ครบ.
