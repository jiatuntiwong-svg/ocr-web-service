# Documents Menu — Design (สรุปหลังหารือ)

> บันทึกการตัดสินใจออกแบบ ก่อนลงมือสร้าง · 2026-06-17
> เกี่ยวข้อง: `DB_STAMP_SPEC.md` (stamp), `RULEBASE_FEATURE_SPEC.md` (validation)

---

## ✅ ข้อสรุปที่ตกลงกันแล้ว

| ประเด็น | สรุป |
|---|---|
| โครง DB (field ไม่เท่ากัน) | **Hybrid เป็นเฟส** — ใช้ `raw_json` ตอนนี้ + เพิ่มตาราง EAV ภายหลังเมื่อต้องค้น/analytics ราย field |
| Flow บันทึก | **Draft → ผู้ใช้แก้ → ยืนยันค่อย commit** |
| Confidence ต่ำ | **ตั้งค่าได้** — default = เตือน+ไฮไลต์ (soft) · opt-in hard-block |
| Error | ไม่หักเครดิต · re-OCR fail ไม่ทับผลดีเดิม · มีปุ่ม retry |

---

## 1. วงจรชีวิตเอกสาร (State machine)

```
อัปโหลด → processing ──(สำเร็จ)──► draft ──(ผู้ใช้กดยืนยัน)──► completed
                │                    ▲
                │(fail)              │ (แก้ไข + re-validate)
                ▼                    │
              error ──(retry)────────┘
```
สถานะใน `documents.status`: `processing | draft | completed | error`
(เพิ่ม `draft` จากเดิมที่มี processing/completed/error)

---

## 2. โครง DB (Hybrid — เฟส)

### เฟสนี้ (ใช้ของเดิม + เพิ่มเล็กน้อย)
`raw_json` schema-less รับ field อะไรก็ได้อยู่แล้ว → เพิ่มเฉพาะคอลัมน์ที่จำเป็น:
```sql
-- lifecycle + audit + error + schema snapshot
ALTER TABLE documents ADD COLUMN edited_at  DATETIME;
ALTER TABLE documents ADD COLUMN edited_by  TEXT;
ALTER TABLE documents ADD COLUMN last_error TEXT;
ALTER TABLE documents ADD COLUMN fields_snapshot_json TEXT;  -- ชื่อ+type ที่ดึงรอบนั้น
-- (status เพิ่มค่า 'draft' — ไม่ต้อง ALTER, เป็น TEXT อยู่แล้ว)
-- + คอลัมน์ stamp จาก DB_STAMP_SPEC: document_key, ocr_count, last_ocr_at
```
> **`fields_snapshot_json` สำคัญ:** เก็บว่า "รอบนี้ดึง field อะไร type อะไร" เพราะเอกสารเดิมอาจ re-OCR
> ด้วย template คนละชุด → ต้องรู้ schema ของรอบนั้นเพื่อ render/แก้ไข/validate ให้ถูก

### เฟสถัดไป (เมื่อต้องค้น/กรอง/analytics ราย field ข้ามเอกสาร)
```sql
CREATE TABLE document_fields (
  doc_id     TEXT,
  field_name TEXT,
  field_type TEXT,
  value      TEXT,
  confidence REAL,
  PRIMARY KEY (doc_id, field_name)
);
CREATE INDEX idx_docfields_name_val ON document_fields(field_name, value);
```
- populate จาก `raw_json` ทุกครั้งที่ OCR สำเร็จ + ตอน confirm (sync ค่าที่แก้)
- table-type fields (array) คงอยู่ใน raw_json (หรือทำ `document_table_rows` แยกภายหลังถ้าจำเป็น)
- **raw_json ยังเป็น source of truth เสมอ** — EAV เป็น index สำหรับ query

---

## 3. Flow บันทึก (Draft → Confirm)

```
OCR สำเร็จ → status='draft', เขียน raw_json + fields_snapshot
   │
   ▼
ผู้ใช้แก้ค่าในตารางผล (updateField/updateCell มีอยู่แล้วใน OCRWorkspace)
   │
   ▼
กด "ยืนยันบันทึก" → PATCH /api/documents/:id
   - เขียน raw_json ที่แก้แล้ว + edited_by/edited_at
   - recompute extracted_data (+ document_fields เฟส 2)
   - รัน rulebase ใหม่กับค่าที่แก้
   - status='completed'
```
- **เครดิต:** หักตอน OCR สำเร็จเหมือนเดิม (ใช้ AI ไปแล้ว) — confirm ไม่หักซ้ำ
- ต้องมี endpoint ใหม่ `PATCH /api/documents/:id` (แก้ไข + ยืนยัน)
- draft ที่ไม่ยืนยัน: ยังอยู่ใน DB (ไม่หาย) — โชว์ในประวัติด้วยป้าย "ฉบับร่าง"

---

## 4. Confidence ต่ำ (Configurable, default soft)

ต่อยอด pref ที่มี (`confidence_threshold`, `block_export_low_confidence`):
```sql
ALTER TABLE user_preferences ADD COLUMN block_save_low_confidence INTEGER DEFAULT 0;
```
- **default (soft):** บันทึกเป็น draft เสมอ + **ไฮไลต์ช่อง confidence < threshold** + notification `low_confidence` (มีแล้ว) + ตอนกดยืนยันเตือน "N ช่องมั่นใจต่ำ ยืนยันไหม"
- **opt-in (hard):** ถ้า `block_save_low_confidence=1` → บล็อกปุ่มยืนยันจนกว่าช่องต่ำจะถูกแก้/override
- **หลักการ:** ไม่ทิ้งงาน/ไม่เผาเครดิตฟรี → เก็บ draft เสมอ, ความเข้มอยู่ที่ขั้น "ยืนยัน" ไม่ใช่ "บันทึก"

---

## 5. Error handling

| กรณี | จัดการ |
|---|---|
| OCR fail | `status='error'`, เก็บใน `last_error`, **ไม่หักเครดิต** (ของเดิมดีอยู่แล้ว), ไม่สร้าง extracted_data ว่าง |
| re-OCR ไฟล์เดิม fail | **คงผลดีเดิม** (raw_json/extracted) ไม่ทับ — mark `last_error` + status='error' (ref DB_STAMP_SPEC §7) |
| AI คืนค่า null/ต่ำ | ไม่ใช่ error → low confidence (ข้อ 4) |
| save/edit fail | คงค่าที่แก้ใน UI, retry ได้ |
| ก่อน OCR (เครดิต/ไฟล์/feature) | reject ก่อนสร้าง doc |

ทุก error → ปุ่ม **"ลองใหม่"** จากหน้า Documents/OCR (re-run ด้วย doc เดิม)

---

## 6. จุดแก้ในโค้ด

| ส่วน | ไฟล์ | งาน |
|---|---|---|
| Migration | `db/migrations/documents_lifecycle.sql` *(ใหม่)* | คอลัมน์ §2 + (รวมกับ stamp migration ได้) |
| OCR pipeline | `src/app/api/upload/route.ts` | สำเร็จ → `status='draft'` (ไม่ใช่ completed), เก็บ fields_snapshot, error → last_error |
| แก้ไข/ยืนยัน | `src/app/api/documents/[id]/route.ts` *(ใหม่ PATCH)* | save raw_json ที่แก้ + recompute + status='completed' |
| EAV (เฟส 2) | `src/lib/document-fields.ts` *(ใหม่)* | sync raw_json → document_fields |
| UI ผล + ยืนยัน | `src/components/OCRWorkspace.tsx` | ปุ่ม "ยืนยันบันทึก", ไฮไลต์ช่อง conf ต่ำ, เตือนตอนยืนยัน |
| UI ประวัติ | `src/components/DocumentsView.tsx` | ป้าย draft/completed/error + ocr_count + ปุ่ม retry |
| Pref | `user_preferences` + APISettings/ReviewSettings UI | `block_save_low_confidence` |
| i18n | `src/lib/i18n/locales/{th,en}.ts` | ข้อความ draft/ยืนยัน/เตือน conf/retry |

---

## 7. ลำดับทำ (เฟส)

| เฟส | งาน |
|---|---|
| **0** | แก้ security ก่อน (`SECURITY_AUDIT.md`) |
| **1** | lifecycle (draft→confirm) + PATCH endpoint + แก้/ยืนยันใน UI + เก็บ fields_snapshot |
| **2** | stamp (`ocr_count`) + ป้ายใน Documents (`DB_STAMP_SPEC.md`) |
| **3** | confidence soft/hard + pref UI |
| **4** | EAV `document_fields` + ค้น/กรองราย field |
| **5** | rulebase validation (`RULEBASE_FEATURE_SPEC.md`) ผูกขั้น confirm |

---

## 8. ความสัมพันธ์กับ spec อื่น
- **stamp** (DB_STAMP_SPEC) — upsert/ocr_count ทำงานร่วมกับ lifecycle นี้ (upsert ตอนรับ → draft ตอนสำเร็จ)
- **rulebase** (RULEBASE_FEATURE_SPEC) — รันตอน confirm (กับค่าที่แก้แล้ว) + แสดงผลตรวจในหน้า Documents
- **raw_json = source of truth** ตลอด · document_fields (EAV) = projection สำหรับ query

---

## 9. Pre-flight checklist — ข้อสรุปก่อนเขียน migration (รอบ 2)

ตรวจสอบโค้ดจริงแล้ว + เคาะข้อที่เป็นทางเลือก:

| # | ประเด็น | ข้อสรุป |
|---|---|---|
| 1 | `draft` ทำ poll พัง | `draft` = terminal "พร้อมรีวิว" · `status/route` คืน data เมื่อ `status IN ('draft','completed')` · poll หยุดที่ draft\|completed\|error · stats นับ draft+completed |
| 2 | Batch × draft | **Batch → สร้าง draft ทั้งหมด + ปุ่ม "ยืนยันทั้งหมด" (bulk review)** |
| 3 | Migration tracking | **รวม stamp+lifecycle เป็น migration เดียว** + ตาราง `schema_migrations(name, applied_at)` กันรันซ้ำ |
| 4 | `extracted_data` (legacy) | **Dead code — ไม่มีใคร SELECT** (v1/extract = ชื่อ field ใน response, stats = อ่าน raw_json) → **เลิกเขียน (deprecate) INSERT** ที่ upload:165 · ใช้ raw_json + EAV · DROP ตารางใน cleanup ภายหลัง |
| 5 | EAV value typing | `document_fields` มี `value_text` + `value_num` + `value_date` (เก็บตาม field_type) ตั้งแต่ออกแบบ |
| 6 | Re-OCR ทับ draft ที่แก้ค้าง | **เตือนก่อนทับ** ("มีฉบับร่างที่ยังไม่ยืนยัน OCR ใหม่ทับไหม") |
| 7 | Soft-delete | **เพิ่ม `deleted_at` ตอนนี้เลย** · ทุก list query กรอง `deleted_at IS NULL` |
| 8 | Encoding | migration files = **UTF-8** เสมอ (เคยเจอบั๊ก UTF-16) |
| 9 | field_name (EAV key) | normalize: trim + lowercase · ซ้ำในเอกสารเดียว → ต่อ suffix |
| 10 | Timezone | เก็บ UTC (`CURRENT_TIMESTAMP`) · แสดง/เทียบ (rule `date<=today`) อิงเวลาไทย |
| 11 | PII ใน EAV | index PII (เลขภาษี ฯลฯ) → **เฟส 0 (security) ต้องมาก่อน** · query ราย field ต้องผ่าน authz |
| 12 | raw_json ใหญ่ | จับขนาด/เตือนถ้าใกล้ limit ของ D1 |

### Schema รวม (migration เดียว `documents_v2.sql`)
```sql
-- lifecycle + audit + error + schema snapshot
ALTER TABLE documents ADD COLUMN edited_at  DATETIME;
ALTER TABLE documents ADD COLUMN edited_by  TEXT;
ALTER TABLE documents ADD COLUMN last_error TEXT;
ALTER TABLE documents ADD COLUMN fields_snapshot_json TEXT;
ALTER TABLE documents ADD COLUMN deleted_at DATETIME;            -- #7 soft-delete
-- stamp (DB_STAMP_SPEC)
ALTER TABLE documents ADD COLUMN document_key TEXT;
ALTER TABLE documents ADD COLUMN ocr_count INTEGER DEFAULT 1;
ALTER TABLE documents ADD COLUMN last_ocr_at DATETIME;
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_user_key ON documents(user_id, document_key);
-- migration tracking
CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);
-- (#4) เลิก INSERT extracted_data ในโค้ด — ตารางปล่อยไว้ก่อน, DROP ใน cleanup migration แยก
```

### EAV (เฟส 2)
```sql
CREATE TABLE document_fields (
  doc_id TEXT, field_name TEXT, field_type TEXT,
  value_text TEXT, value_num REAL, value_date TEXT, confidence REAL,
  PRIMARY KEY (doc_id, field_name)
);
CREATE INDEX idx_docfields_name ON document_fields(field_name, value_text);
```

→ **พร้อมเขียน migration จริงแล้ว** (หลังเฟส 0 security)

---

## 10. Cross-document Search (ค้นข้ามประวัติด้วยค่า field + NL + export)

รองรับด้วย EAV ที่ออกแบบไว้แล้ว (decision #5 typed values) — ตัวอย่าง "ใบกำกับผู้ขาย X เกิน 100k":

### 10.1 Query บน EAV (deterministic)
```sql
SELECT d.* FROM documents d
WHERE d.user_id = ? AND d.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM document_fields f
              WHERE f.doc_id=d.id AND f.field_name='ผู้ขาย' AND f.value_text LIKE 'X%')
  AND EXISTS (SELECT 1 FROM document_fields f
              WHERE f.doc_id=d.id AND f.field_name='ยอดรวม' AND f.value_num > 100000);
```
- **EXISTS ต่อเงื่อนไข** → AND ข้าม field + ใช้ index ได้ (ไม่ต้อง pivot)
- `value_num` รองรับ `> / <` · `value_date` รองรับช่วงวันที่

### 10.2 NL → search query (reuse กลไก rulebase)
> **search = "rule ที่ใช้กรอง" → ใช้ operator set + AI compiler ชุดเดียวกับ rulebase**
```
NL "ใบกำกับผู้ขาย X เกิน 100k" → [AI compile 1 ครั้ง] → query JSON (operator เดิม)
  [{field:"ผู้ขาย", op:"contains", value:"X"}, {field:"ยอดรวม", op:"gt", value:100000}]
  → user ยืนยัน → รัน SQL deterministic บน EAV → รายการเอกสาร
```
→ ลงทุน operator+compiler ครั้งเดียว ใช้ได้ทั้ง validate + search

### 10.3 Export ผลค้นหา
ผลค้น = ชุดเอกสาร → **reuse `exportOCRBatch`** (1 แถว/เอกสาร + รวม field) ที่ทำไว้แล้ว

### 10.4 ⚠️ ต้องเพิ่ม/ระวัง
1. **Backfill EAV จาก raw_json เอกสารเก่า** — migration job อ่าน raw_json เดิม → เติม document_fields ไม่งั้น search เจอแค่เอกสารใหม่
2. **Performance ที่ scale** — EXISTS หลายเงื่อนไขช้าเมื่อข้อมูลมาก → index + (ถ้าหนัก) materialized/FTS
3. **Access control** — scope `user_id` + `deleted_at IS NULL` เสมอ (ผูก security เฟส 0)
4. **Full-text search** (ค้นเนื้อความในเอกสาร) = คนละกลไก ต้องใช้ SQLite FTS5 แยก — ไว้พิจารณาทีหลัง

### 10.5 จุดแก้/เฟส
- เฟส 4 (EAV) — เพิ่ม backfill job + search query builder (deterministic) + UI ค้นขั้นสูงในเมนู Documents
- เฟสถัดไป — NL→query compiler (reuse rulebase) + export ผลค้น
- ไฟล์: `src/lib/document-fields.ts` (sync+backfill), `src/app/api/documents/search/route.ts` *(ใหม่)*, `DocumentsView.tsx` (UI ค้น+export)
