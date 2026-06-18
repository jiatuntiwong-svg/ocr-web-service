# Rulebase Validation — Feature Spec (Handoff)

> เอกสารสเปคสำหรับทีมพัฒนาต่อ · ร่างโดยทีมวางแผน · อัปเดต 2026-06-17
> ฟีเจอร์: ให้ผู้ใช้กำหนด "กฎ" ตรวจความถูกต้องของเอกสารที่ OCR สกัดมา (pass/fail/warning)

---

## 1. เป้าหมาย

เพิ่มเมนูใหม่ให้ผู้ใช้ **กำหนดกฎเอง** เพื่อตรวจสอบเอกสารที่ OCR สกัดออกมา เช่น
"เลขผู้เสียภาษีต้องมี 13 หลัก", "ยอดรวม = ราคา + VAT 7%", "ต้องมีคำว่าใบกำกับภาษี"
แล้วระบบรายงานผล **ผ่าน / ไม่ผ่าน / เตือน** พร้อมเหตุผล ต่อเอกสารและแบบสรุปทั้งชุด

**คุณค่าเชิงธุรกิจ:** ดัน positioning จาก "OCR ต่อหน้า" → "Document Validation / AP Automation /
Compliance" ซึ่ง justify ราคาพรีเมียมได้ (ดู `docs/STRATEGY_REPORT.html`)

---

## 2. หลักการสำคัญ (อ่านก่อนเริ่ม)

### 2.1 Rule = data ไม่ใช่ rule = code
ทีม **ไม่ต้องเขียนกฎแต่ละข้อเป็นโค้ด** — เขียน **engine + ชุด operator พื้นฐาน ครั้งเดียว**
ผู้ใช้ประกอบกฎเองเป็น JSON (`rules_json`) เหมือนที่ระบบ extraction เก็บ `fields_json` แล้วตีความ runtime

### 2.2 รันกฎ = post-process JSON ที่ OCR คืนมา → ไม่มีต้นทุน AI เพิ่ม
```
เอกสาร → [AI OCR อ่าน 1 ครั้ง] → extracted JSON  (← token ที่นี่ที่เดียว มีอยู่แล้ว)
                                      │
                                      ▼
                          [rule engine — โค้ดล้วน] → ผล pass/fail   (ฟรี)
```
การเช็คกฎเป็นการประมวลผล JSON ที่ `/api/upload` ได้มาอยู่แล้ว **ไม่เรียก Gemini เพิ่ม**

### 2.3 กฎมี 2 ระดับ
| ระดับ | เช็คกับ | ต้อง extract field ก่อน |
|---|---|---|
| **Field-level** (เลขหลัก/ช่วงค่า/สูตร) | ค่าที่สกัดเป็น field | ใช่ |
| **Text-level** (มีคำ/regex) | ข้อความดิบ OCR ทั้งหน้า | ไม่ต้อง |

---

## 3. Rule schema (`rules_json`)

แต่ละกฎเป็น object:
```jsonc
{
  "id": "uuid",
  "label": "เลขภาษี 13 หลัก",        // ชื่อกฎ (อ่านง่าย)
  "target": "field",                  // "field" | "text"
  "field": "เลขผู้เสียภาษี",          // key ตรงกับ extraction field (ถ้า target=field)
  "op": "regex",                       // operator (ดู §4)
  "value": "^\\d{13}$",               // พารามิเตอร์ของ operator
  "severity": "error",                 // "error" | "warning" | "info"
  "engine": "deterministic"            // "deterministic" | "ai"  (ดู §6)
}
```
เก็บทั้งชุดเป็น array ใน 1 rule set (รียูสแพทเทิร์น template เดิม)

---

## 4. Operator set (เขียนครั้งเดียว ~12–15 ตัว)

| กลุ่ม | operator | value | ตัวอย่างกฎ |
|---|---|---|---|
| มีค่า | `required`, `not_empty` | — | field ต้องมีค่า |
| ข้อความ | `regex` | pattern | `^\d{13}$` |
| | `contains` | substring | มีคำว่า "ใบกำกับภาษี" |
| | `equals` | string | สถานะ = "ชำระแล้ว" |
| | `in_list` | string[] | ผู้ขายอยู่ใน whitelist |
| | `length` | `{min,max}` | ความยาว |
| ตัวเลข | `gt`/`lt`/`gte`/`lte` | number | ยอดรวม > 0 |
| | `between` | `{min,max}` | อยู่ในช่วง |
| วันที่ | `date_lte`/`date_gte` | date \| `"today"` | วันที่ ≤ วันนี้ |
| | `date_between` | `{from,to}` | ในช่วงวันที่ |
| ข้ามฟิลด์ | `expression` | นิพจน์ | `ยอดรวม == ราคา + ราคา*0.07` |

> **`expression` = ไม้เด็ด** — operator ตัวเดียวครอบกฎคณิต/ตรรกะข้ามฟิลด์ได้ไม่จำกัด
> ⚠️ ต้องใช้ **safe expression evaluator** (เช่น parser ของตัวเอง / expr-eval) — **ห้าม `eval()` ตรง ๆ**
> (security) อ้างถึง field ด้วยชื่อ key, รองรับ + − × ÷ และเปรียบเทียบ

---

## 5. Engine (core — เขียนครั้งเดียว)

ฟังก์ชันบริสุทธิ์ ทดสอบง่าย:
```ts
// src/lib/rule-engine.ts  (ไฟล์ใหม่)
type RuleResult = {
  ruleId: string; label: string; severity: "error"|"warning"|"info";
  status: "pass" | "fail" | "skip";   // skip = ไม่มีค่าให้เช็ค
  detail?: string;                     // เหตุผลเมื่อ fail
};

export function runRules(
  rules: Rule[],
  extracted: Record<string, any>,      // JSON จาก OCR (field-level)
  rawText: string,                     // ข้อความดิบ (text-level)
): RuleResult[]
```
- field-level → ดึงค่าจาก `extracted[field]` (unwrap `{value,confidence}` แบบเดียวกับ exportUtils)
- text-level → เช็คบน `rawText`
- `expression` → ป้อน map ของ field values เข้า safe evaluator

---

## 6. NL → Rule compiler (AI ตอนสร้างกฎเท่านั้น)

ให้ผู้ใช้พิมพ์กฎเป็นภาษาธรรมชาติ แล้ว AI แปลงเป็น `rules_json` **ครั้งเดียวตอนสร้าง/แก้** (ไม่ใช่ทุกเอกสาร)

```
NL: "เลขภาษี 13 หลัก และยอดรวมเท่ากับราคา + VAT 7%"
        │  (Gemini, 1 call ต่อการสร้างกฎ — ป้อน operator schema เป็น context)
        ▼
rules_json + จัดประเภท engine:
  - แปลงเข้า operator ได้   → engine:"deterministic"  (รันฟรี)
  - ต้องใช้ดุลพินิจ          → engine:"ai"            (รัน AI ต่อเอกสาร — แจ้ง cost)
  - กำกวม                   → ขอ user พิมพ์ใหม่
        │
        ▼
[user ตรวจ/ยืนยัน ก่อนเซฟ]   ← บังคับ! กัน AI แปลผิด
```

ข้อกำหนด compiler:
- prompt บังคับ output เป็น JSON ตาม schema §3 + ใช้ได้เฉพาะ operator §4
- คืน `engine` ของแต่ละกฎ เพื่อ UI โชว์ว่ากฎนี้ "ฟรี" หรือ "ใช้ AI ทุกครั้ง"
- ผูก `field` ของกฎเข้ากับ extraction field (ดู §7)

> **AI-runtime rules (engine:"ai")** — สำหรับกฎเชิงดุลพินิจ รันโดยส่งค่า+คำถามให้ Gemini ตอนตรวจเอกสาร
> มีต้นทุน token/แผ่น → ต้องแสดง cost ให้ผู้ใช้รู้ตัว (Tier 2/3)

---

## 7. การเชื่อมกับ extraction (สำคัญ)

กฎ field-level อ้างถึง **key เดียวกับ extraction field** (`fields_json`):
- ถ้ากฎอ้าง field ที่ยังไม่ได้อยู่ใน extraction template → **auto-เพิ่มเข้า list** (เพื่อให้มีค่ามาเช็ค) หรือเตือนผู้ใช้
- แนะนำ: rule set ผูกกับ extraction template หนึ่ง ๆ (หรือเป็น optional add-on ของ template)

---

## 8. Safeguard — คุณภาพขึ้นกับ OCR

ผลกฎดีเท่าที่ OCR สกัดถูก → ใช้ **confidence ที่มีอยู่แล้ว**:
- field ที่กฎอ้างถึงมี confidence ต่ำกว่า threshold → แสดงป้าย "ต้อง review ก่อนเชื่อผล"
- แสดงผลกฎควบคู่กับ confidence ของ field นั้น
- ผูกกับ review workflow + notification เดิม (`createNotification`, `reviewed_at`)

---

## 9. Data model (DB)

migration ใหม่ `db/migrations/rulebase.sql`:
```sql
-- ชุดกฎ (รียูสแพทเทิร์น templates)
CREATE TABLE IF NOT EXISTS rule_sets (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT,
  rules_json TEXT,                 -- array ของ Rule (§3)
  linked_template_id TEXT,         -- (optional) ผูกกับ extraction template
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ผลการตรวจต่อเอกสาร
ALTER TABLE documents ADD COLUMN validation_json TEXT;     -- RuleResult[] (§5)
ALTER TABLE documents ADD COLUMN validation_status TEXT;   -- 'pass'|'fail'|'warning'|null
```
> seed กฎสำเร็จรูปได้ภายหลังด้วยไฟล์คล้าย `db/migrations/default_templates.sql`

---

## 10. จุดแก้ในโค้ด

| ส่วน | ไฟล์ | งาน |
|---|---|---|
| Engine | `src/lib/rule-engine.ts` *(ใหม่)* | operator set + `runRules()` + safe expression evaluator |
| OCR pipeline | `src/app/api/upload/route.ts` | หลังสกัด JSON (หลัง `extracted`) → โหลด rule set ของ doc → `runRules()` → เขียน `validation_json`/`validation_status` |
| Rule CRUD API | `src/app/api/rules/route.ts` *(ใหม่)* | GET/POST/DELETE rule sets (เลียนแบบ `api/templates/route.ts`) |
| NL compiler API | `src/app/api/rules/compile/route.ts` *(ใหม่)* | รับ NL → เรียก `generateWithAI` → คืน `rules_json` ที่ review ได้ |
| Status/Documents | `src/app/api/status/route.ts`, `api/documents/route.ts` | คืน `validation_status`/`validation_json` |
| UI — เมนู | `src/components/NavRail.tsx` | เพิ่มเมนู "Rules" |
| UI — Rule Builder | `src/components/RulesWorkspace.tsx` *(ใหม่)* | สร้าง/แก้กฎ (form + ช่อง NL) + แสดงตัวที่ AI แปลให้ยืนยัน |
| UI — แสดงผลตรวจ | `src/components/DocumentsView.tsx`, `OCRWorkspace.tsx` | badge ผ่าน/ไม่ผ่าน + รายละเอียดกฎที่ fail |
| i18n | `src/lib/i18n/locales/{th,en}.ts` | ข้อความใหม่ |

> ⚠️ **ความปลอดภัย:** `runRules` ทำงานบนข้อมูล user → ถ้า `expression` evaluate ฝั่ง server
> ต้องใช้ parser ปลอดภัย (ไม่ `eval`/`Function`) เพื่อกัน code injection

---

## 11. Capability tiers (โรดแมปความสามารถ)

| Tier | ความสามารถ | ต้นทุนรัน |
|---|---|---|
| 1 | Deterministic (operator §4) | 🟢 ฟรี |
| 2 | AI rules (กฎดุลพินิจ) | 🟡 token/แผ่น |
| 3 | **Hybrid** — deterministic ก่อน, AI เคสกำกวม | 🟢/🟡 |
| 4 | Cross-document (กันซ้ำ/เทียบ master data/ประวัติ) | กลาง |
| 5 | Rule templates ราย industry (invoice/contract/KYC) | — |

---

## 12. Cost model

- Tier 1/text-level/expression = **post-process JSON ที่มีอยู่ → ไม่เพิ่ม token**
- NL compiler = 1 Gemini call **ต่อการสร้าง/แก้กฎ** (ไม่ใช่ต่อเอกสาร) → cost น้อยมาก
- AI-runtime rules (Tier 2) = token เพิ่มต่อเอกสาร → ต้องแจ้ง cost + แนะนำใช้เท่าที่จำเป็น

---

## 13. Roadmap (เฟส)

| เฟส | งาน | หมายเหตุ |
|---|---|---|
| **0** | **แก้ช่องโหว่ security ก่อน** (`docs/SECURITY_AUDIT.md`) | ฟีเจอร์ "ตรวจสอบเอกสาร" ต้องมีฐานความน่าเชื่อถือก่อน |
| 1 | `rule-engine.ts` (Tier 1) + Rule CRUD API + Rule Builder UI (form) | คุ้มสุด ไม่เพิ่มต้นทุน AI |
| 2 | ผูกผลตรวจเข้า upload pipeline + แสดงใน Documents/OCR + review/notification | รียูสของเดิม |
| 3 | NL compiler (AI สร้างกฎ) + ขั้นยืนยัน | UX ก้าวกระโดด |
| 4 | Tier 2 AI-runtime rules (เคสดุลพินิจ) | แจ้ง cost |
| 5 | Audit trail + API/webhook (ส่งผลเข้า ERP) + rule templates | เปิดตลาด enterprise/AP automation |

---

## 14. คำถาม/ดีไซน์ที่ทีมต้องตัดสิน

1. Rule set ผูกแบบ 1:1 กับ extraction template หรือเป็น add-on แยก?
2. severity `error` ควร **บล็อก export/อนุมัติ** เลยไหม หรือแค่ flag? (มี `block_export_low_confidence` เป็น pattern อยู่แล้ว)
3. ใช้ expression evaluator library ตัวไหน (ต้องรันได้บน Cloudflare Workers — ไม่มี node native)
4. กฎ AI-runtime คิดเครดิตเพิ่มยังไง (ต่อกฎ? ต่อเอกสาร?) — ผูกกับ `pricing.ts`
5. ภาษาเขียน expression/ชื่อ field — ใช้ key ภาษาไทยได้ไหม (มีผลต่อ parser)

---

## 15. Out of scope (เฟสนี้)
- การเทรนโมเดล OCR เฉพาะทาง
- Compliance certification (เป็นเรื่อง process/audit ไม่ใช่ฟีเจอร์)
- Marketplace กฎ (Tier 5+)

---

## อ้างอิงโค้ดเดิมที่รียูสได้
- Template pattern: `src/app/api/templates/route.ts`, `fields_json`
- OCR pipeline + extracted JSON: `src/app/api/upload/route.ts`
- AI call helper: `src/lib/ai-handler.ts` (`generateWithAI`)
- Confidence + review: `documents.reviewed_at`, `createNotification`
- Export ผล: `src/lib/exportUtils.ts`
- Seed pattern: `db/migrations/default_templates.sql`
