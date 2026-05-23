# OCR Compare Project AI Workplan

ข้อมูล ณ วันที่ 25 เมษายน 2026

เอกสารนี้ทำไว้สำหรับให้ AI agent หรือทีมพัฒนาอ่านแล้วทำงานต่อกับโปรเจกต์ OCR/Compare ได้ทันที โดยโฟกัสเฉพาะ **สิ่งที่ต้องแก้ไข ปรับปรุง และต่อยอดในฝั่ง project/codebase** ไม่รวม business pitch, market analysis หรือ sales deck

## เป้าหมายหลักของโปรเจกต์

เปลี่ยนระบบจาก OCR/Compare SaaS ที่ใช้งานได้ระดับ prototype/product beta ให้กลายเป็น **Document Intelligence Workflow** ที่:

- อ่านเอกสารได้แม่นขึ้น
- compare เฉพาะ field ที่ผู้ใช้เลือก
- highlight ตำแหน่งในเอกสารได้น่าเชื่อถือ
- เก็บ compare history และ audit trail ได้
- export report ได้
- รองรับ workflow review/approve
- เตรียมต่อยอดไป RPA/action layer ได้

## Stack และพื้นที่สำคัญ

| Area | Path |
|---|---|
| Upload API | `src/app/api/upload/route.ts` |
| Status API | `src/app/api/status/route.ts` |
| Extraction API | `src/app/api/v1/extract/route.ts` |
| Compare API | `src/app/api/compare/route.ts` |
| Compare UI | `src/components/CompareWorkspace.tsx` |
| Templates API | `src/app/api/templates/route.ts` |
| Text/OCR logic | `src/lib/text-extractor.ts` |
| Shared types | `src/lib/types.ts` |
| Logger | `src/lib/logger.ts` |
| Admin logs API | `src/app/api/admin/logs/route.ts` |
| Admin settings/users | `src/app/api/admin/settings/route.ts`, `src/app/api/admin/users/route.ts` |
| Billing | `src/app/api/billing/prices/route.ts`, `src/app/api/billing/checkout/route.ts`, `src/app/api/webhook/stripe/route.ts` |
| Database schema | `schema.sql` |
| Deployment | `wrangler.jsonc`, `next.config.ts`, `open-next.config.ts`, `package.json` |

## Current Product State

มีอยู่แล้ว:

- authentication / registration / session cookie
- upload PDF/image
- OCR/extraction pipeline
- status tracking
- field-based extraction
- compare 2-3 documents
- selected-fields-only compare behavior
- missing fields return เป็น `null`
- prevention ไม่ให้ AI invent extra fields
- highlight preview
- templates ทั้ง system และ user
- admin settings/users/logs
- Stripe billing/checkout/webhook
- Cloudflare/OpenNext/D1 deployment path

ยังต้องปรับ:

- highlight accuracy โดยเฉพาะ table, scanned PDF, repeated values
- OCR/text extraction architecture ให้ชัดขึ้น
- scanned PDF runtime บน Cloudflare/OpenNext
- confidence score ต่อ field
- compare history persistence
- export report
- template versioning
- approval/review workflow
- auth/session/admin security hardening
- usage-based billing ที่ผูกกับ document/page/compare run

## Guiding Principles

1. **Field-driven first**: compare เฉพาะ field ที่ผู้ใช้เลือก อย่า compare ทั้งเอกสารแบบกว้างโดยไม่จำเป็น
2. **Do not invent data**: field ที่ไม่มีในเอกสารต้องเป็น `null` หรือ `missing` พร้อม confidence ต่ำ
3. **Report value before perfect highlight**: ถ้า highlight ยังไม่แม่น ให้ report field mismatch ให้เชื่อถือได้ก่อน
4. **Human-in-the-loop**: action สำคัญต้องมี review/approve
5. **Audit everything**: เก็บว่าใคร upload, AI อ่านว่าอะไร, ใครแก้, ใคร approve, export เมื่อไหร่
6. **Cache extraction results**: OCR/text position ควร cache ต่อไฟล์เพื่อลด cost และ debug ง่าย
7. **Design for RPA handoff**: export/report/job output ต้อง structured พอให้ Python RPA ใช้ต่อได้

## Priority 0: Stabilize Compare/Highlight Core

### P0.1 แยก pipeline ของ text PDF และ scanned PDF

ปัญหา:

- text PDF กับ scanned PDF ต้องใช้วิธีหา location ต่างกัน
- ปัจจุบัน hybrid stack อาจทำให้ highlight เพี้ยน

แนวทาง:

- text PDF: ใช้ PDF.js text layer / text positions
- scanned PDF/image: ใช้ OCR token coordinates
- compare result ต้อง map กลับไปที่ token/position ก่อน render highlight

Files:

- `src/lib/text-extractor.ts`
- `src/app/api/compare/route.ts`
- `src/components/CompareWorkspace.tsx`
- `src/lib/types.ts`

Acceptance criteria:

- ระบบรู้ว่าเอกสารเป็น text PDF หรือ scanned/image
- compare result มี `sourceMethod`: `text-layer`, `ocr-token`, หรือ `ai-only`
- highlight ของ text PDF ใช้ text positions
- highlight ของ scanned/image ใช้ OCR token boxes
- ถ้าหา position ไม่ได้ ต้องแสดง result ใน report โดยไม่ fake highlight

### P0.2 ทำ OCR/text position cache

ปัญหา:

- compare ซ้ำอาจต้อง OCR ใหม่
- debug highlight ยาก
- cost สูงขึ้นเมื่อเอกสารเดิมถูกใช้ซ้ำ

ควรเก็บ:

- document id
- page number
- raw text
- tokens
- bounding boxes
- confidence
- extraction method
- created timestamp

Possible tables:

- `documents`
- `document_pages`
- `document_tokens`

Acceptance criteria:

- upload/extract ครั้งแรกสร้าง token cache
- compare ใช้ cache ถ้ามี
- มี fallback เมื่อ cache เสียหรือ version ไม่ตรง
- logs ระบุว่าใช้ cache หรือ OCR ใหม่

### P0.3 ปรับ highlight ให้ degrade gracefully

ปัญหา:

- highlight ที่ผิดทำให้ผู้ใช้ไม่เชื่อระบบ

แนวทาง:

- ถ้าตำแหน่งไม่มั่นใจ ไม่ควร highlight แบบมั่ว
- ใช้ confidence threshold
- แสดง field mismatch ใน results panel และ report แทน

Acceptance criteria:

- highlight แต่ละจุดมี confidence
- low-confidence highlight แสดงเป็น warning หรือไม่แสดง
- results panel ยังบอกความต่างครบแม้ไม่มี highlight
- ไม่สร้าง bounding box จาก AI แบบเดาสุ่ม

## Priority 1: Turn Compare Into Reportable Workflow

### P1.1 Save compare history

เป้าหมาย:

- ผู้ใช้กลับมาเปิด compare run เดิมได้
- ใช้เป็นหลักฐาน audit ได้
- รองรับ billing ตาม compare run

Files:

- `src/app/api/compare/route.ts`
- `src/components/CompareWorkspace.tsx`
- `schema.sql`

Suggested tables:

- `compare_runs`
- `compare_documents`
- `compare_fields`
- `compare_highlights`

Fields ที่ควรมี:

- `compare_run_id`
- `user_id`
- `template_id`
- `template_version_id`
- `status`
- `documents`
- `selected_fields`
- `results_json`
- `created_at`
- `updated_at`

Acceptance criteria:

- ทุก compare run มี id
- user เปิด history ได้
- compare result reload ได้โดยไม่ต้อง re-run AI
- admin/log เห็น compare run failure ได้

### P1.2 Export compare report เป็น PDF/Excel

เป้าหมาย:

- ทำให้ output ส่งต่อผู้บริหาร/บัญชี/procurement/supplier ได้

Report content:

- document names
- compare date/time
- template used
- selected fields
- match/mismatch/missing summary
- confidence ต่อ field
- reviewer status
- highlight references ถ้ามี
- notes/comments

Files:

- `src/components/CompareWorkspace.tsx`
- new route เช่น `src/app/api/compare/[id]/export/route.ts`

Acceptance criteria:

- export PDF ได้
- export Excel/CSV field mismatch ได้
- export ใช้ข้อมูลจาก saved compare run
- report ไม่ต้อง re-run extraction/compare

### P1.3 Review/approval workflow

Statuses:

- `draft`
- `reviewed`
- `approved`
- `rejected`
- `request_correction`

Actions:

- add note
- assign reviewer
- approve
- reject
- request correction
- export report

Suggested table:

- `review_actions`

Acceptance criteria:

- action ทุกครั้งมี user/timestamp
- compare run status เปลี่ยนตาม action
- history แสดง reviewer actions
- export report include latest status

## Priority 2: Templates and Vertical Packages

### P2.1 Template versioning

ปัญหา:

- template ที่ใช้ compare วันนี้อาจเปลี่ยนในอนาคต
- compare run เก่าต้องอ้างอิง template version เดิมได้

Suggested tables:

- `templates`
- `template_versions`

Acceptance criteria:

- template มี version
- compare run lock กับ template version
- clone template ได้
- admin publish/unpublish system template ได้

### P2.2 System template packs

ควรเริ่มจาก 5 packs:

1. Basic invoice compare
2. Quotation vs PO
3. PO vs invoice
4. Contract key clauses
5. Tax readiness

Template field examples:

Invoice:

- invoice number
- invoice date
- seller name
- seller tax id
- buyer name
- buyer tax id
- subtotal
- VAT
- total
- payment terms

Quotation/PO/Invoice:

- vendor/customer
- document number
- date
- item/SKU/description
- quantity
- unit price
- discount
- VAT
- total
- payment term

Contract:

- parties
- effective date
- contract term
- payment term
- termination
- renewal
- confidentiality
- liability cap
- PDPA/data processing

## Priority 3: Confidence, Exception Queue, and Rules

### P3.1 Field confidence score

ทุก extracted/compared field ควรมี:

- value
- normalized value
- confidence
- source page
- source box/reference
- extraction method

Acceptance criteria:

- confidence แสดงใน UI
- low confidence เข้า exception queue
- report include confidence

### P3.2 Exception taxonomy

เริ่มจาก:

- missing field
- low confidence
- duplicate document number
- total mismatch
- VAT mismatch
- price variance
- quantity variance
- supplier/customer mismatch
- payment term mismatch
- no highlight position found

Acceptance criteria:

- compare result มี `exceptions[]`
- UI filter เฉพาะ exception ได้
- export report แยก exception summary ได้

### P3.3 Tolerance rules

ใช้กับ Quotation/PO/Invoice:

- amount difference <= X บาท
- percentage difference <= Y%
- date difference <= N days
- allow missing optional fields

Acceptance criteria:

- template หรือ compare run ตั้ง tolerance ได้
- result แยก `match`, `warning`, `mismatch`, `missing`

## Priority 4: Production Reliability

### P4.1 Test scanned PDF path บน Cloudflare/OpenNext

ต้องทดสอบ:

- text PDF
- scanned PDF
- image upload
- multi-page PDF
- Thai text
- table-heavy document

Acceptance criteria:

- deploy environment ใช้ OCR fallback ได้จริง
- optional dependencies ไม่ทำให้ runtime แตก
- error log ชัดเจนเมื่อ OCR ใช้ไม่ได้

### P4.2 Admin logs end-to-end

จาก analysis route เคยมีปัญหาใช้ `process.env.DB` แต่แก้มาใช้ `getCloudflareContext()` แล้ว ต้อง retest

Acceptance criteria:

- trigger upload/extract/compare error แล้ว log ถูกบันทึก
- admin logs page เห็น record
- log มี request id / user id / route / error summary

### P4.3 Stripe webhook validation

Acceptance criteria:

- checkout success updates plan/limits
- webhook signature validate
- failed webhook ถูก log
- usage limit ไม่ bypass ได้ง่าย

## Priority 5: Security Hardening

ตรวจ:

- password hashing
- session cookie flags
- cookie integrity
- admin authorization ทุก route
- user can access only own documents/compare runs
- file upload validation
- rate limit / usage limit
- PII/data retention policy

Acceptance criteria:

- admin route ทุกตัวมี authorization check
- compare/export/history route ตรวจ ownership
- uploaded file type/size validated
- sensitive logs ไม่เก็บ raw secrets หรือ private document content เกินจำเป็น

## Priority 6: RPA Handoff Readiness

เพื่อให้ Python RPA ใช้ต่อได้ ควรมี structured output:

### P6.1 Job-ready export schema

สำหรับ RPA:

```json
{
  "compareRunId": "string",
  "status": "approved",
  "documents": [],
  "fields": [],
  "exceptions": [],
  "reviewActions": [],
  "exportedAt": "ISO timestamp"
}
```

### P6.2 Webhook/job queue endpoint

อนาคตควรมี:

- create RPA job
- job status
- job result
- screenshot/evidence links
- retry/idempotency key

Suggested tables:

- `automation_jobs`
- `automation_job_events`

Acceptance criteria:

- approved compare run สามารถส่งต่อเป็น job ได้
- job มี idempotency key
- RPA result กลับมา update status ได้

## Suggested Database Additions

```sql
-- conceptual only; adjust to current schema style
documents
document_pages
document_tokens
compare_runs
compare_documents
compare_fields
compare_highlights
review_actions
templates
template_versions
usage_events
automation_jobs
automation_job_events
```

## Suggested API Additions

| API | Purpose |
|---|---|
| `GET /api/compare/history` | list compare runs |
| `GET /api/compare/:id` | get saved compare result |
| `POST /api/compare/:id/review` | approve/reject/request correction |
| `GET /api/compare/:id/export.pdf` | export PDF report |
| `GET /api/compare/:id/export.xlsx` | export Excel report |
| `POST /api/templates/:id/version` | create template version |
| `POST /api/automation/jobs` | create RPA/action job |
| `GET /api/automation/jobs/:id` | get job status |

## Suggested UI Additions

CompareWorkspace:

- compare history panel
- selected template version display
- field confidence badges
- exception filter
- review status control
- reviewer notes
- export PDF/Excel buttons
- no-highlight warning state

Admin:

- template pack management
- usage events
- OCR/AI error dashboard
- compare run failures
- automation job monitor

## Testing Checklist

Document types:

- text PDF ภาษาไทย
- scanned PDF ภาษาไทย
- image receipt/slip
- invoice with table
- quotation vs PO
- PO vs invoice
- contract 2 versions

Behavior:

- selected fields only
- missing fields return `null`
- no invented fields
- repeated values do not highlight wrong location
- table rows do not mismatch randomly
- low confidence goes to exception
- report export uses saved result
- user cannot open another user's compare run

Deployment:

- local
- Cloudflare/OpenNext
- D1 migration
- Stripe webhook
- admin logs

## Definition of Done for Next Milestone

Milestone: **DocMatch AI Report MVP**

ต้องมี:

- compare run saved
- compare history list
- export PDF/Excel report
- confidence per field
- exception summary
- review status
- basic audit log
- text PDF highlight stable enough for pilot
- scanned PDF fallback works or clearly reports limitation
- 5 system templates

ไม่จำเป็นต้องมีใน milestone นี้:

- perfect table matching
- full AP 3-way matching
- auto RPA execution
- e-Tax submission
- legal/medical advice
- autonomous agent

## Do Not Do Yet

- อย่าให้ AI auto-approve payment/tax/legal actions
- อย่า promise accuracy 100%
- อย่า build vertical หลายตัวพร้อมกัน
- อย่า fine-tune model ก่อนมี evaluation set และ labeled corrections
- อย่า rely on AI-generated bounding boxes ถ้าไม่มี token/text position support
- อย่าเปิด enterprise/healthcare/loan use case ก่อน security และ audit แข็งแรง

## Recommended First Sprint

Sprint goal:

> Make compare output persistent, exportable, and reviewable

Tasks:

1. Read current `schema.sql`
2. Design tables for compare history and review actions
3. Update `src/app/api/compare/route.ts` to persist compare result
4. Add history/reopen UI in `src/components/CompareWorkspace.tsx`
5. Add export JSON/CSV first, then PDF/Excel
6. Add confidence and exception fields to `src/lib/types.ts`
7. Add admin log events for compare/export/review
8. Add tests or manual fixtures for text PDF, scanned PDF, invoice table

Acceptance:

- user can compare, close page, reopen result
- user can export mismatch report
- result has status and audit trail
- low confidence/no highlight is visible and honest

