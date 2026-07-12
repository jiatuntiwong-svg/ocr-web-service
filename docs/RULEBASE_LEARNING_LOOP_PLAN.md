# Rulebase + Learning Loop — Design Plan

> สถานะ: **DESIGN ONLY — ยังไม่ implement**
> วันที่บันทึก: 2026-06-27
> ขอบเขต: Long-term solution สำหรับ Compare quality, alignment, table extraction
> Replaces: Quick fixes ที่เคยเสนอ (user decline)
> Principle: **Compare grows with usage; user teaches, AI curates**

---

## 0a. Locked Decisions (2026-06-27)

ผู้ใช้ตัดสิน 11 ข้อในรอบประชุม design — บันทึกไว้ที่นี่เพื่ออ้างอิงรวดเร็ว ที่เหลือใช้ default recommended ในแต่ละ section

### Architecture & Scope
| ID | Decision | Choice |
|--|--|--|
| **D1** | Rule scope | Per-template + Template Owner |
| **D2** | Public templates ติด rules? | **ไม่** (fields-only) |
| **D9** | Mark wrong scope (MVP) | เฉพาะ Compare |

### User feedback UX
| ID | Decision | Choice |
|--|--|--|
| **Q1** | Modal timing ตอน save correction | Sync — รอใน modal 2-3 วินาที |
| **D3** | Auto-confirm rule? | **Confirm ทุก rule** (สร้าง trust) |
| **D10** | Correction ที่ AI สร้าง rule ไม่ได้/user ข้าม | **Drop** (ไม่เก็บ) |

### Rule lifecycle
| ID | Decision | Choice |
|--|--|--|
| **Q2** | Rule conflict resolution | User เลือกเสมอ |
| **Q4** | Test rule on current doc preview | มีตั้งแต่ MVP |
| **Q3** | Cross-template rule sharing | **ไม่มี** (MVP) |

### Template Design Advisor
| ID | Decision | Choice |
|--|--|--|
| **QA2** | Critical save → block? | Soft block (confirm dialog) |
| **QA4** | "Apply suggestion" auto-edits? | แสดง diff preview ก่อน → user save |
| **QA1** | AI 1-shot analysis quota | **Configurable via Tier Control** (admin set per-tier) |

### Defaults (ไม่ได้ถาม — ใช้ recommended)
- **D4** Rule format: JSON spec + NL display
- **D5** Storage: Separate D1 table
- **D6** Quota: เริ่ม unlimited, monitor abuse
- **D7** Versioning: Yes (soft delete + history)
- **D8** Export format: JSON file
- **Q5** Analytics dashboard: user-level start, admin later
- **Q6** Mobile UX: defer to Phase F
- **QA3** Cross-template Advisor suggestions: ไม่มี (สอดคล้องกับ Q3)
- **QA5** Multi-language (TH/EN): Yes

---

## 0. Why a Rulebase (motivation)

Compare ปัจจุบันใช้ AI ทั่วไป → fail ในเคสที่ต้องใช้ domain knowledge เช่น:

| ปัญหาที่เจอ | AI ทั่วไปแก้ไม่ได้ เพราะ... |
|--|--|
| Column mismatch (KGS ↔ CBM) | AI ไม่รู้ว่า business นี้แยก weight vs volume |
| Row swap (ABC↔null) | AI ไม่รู้ว่า business นี้ row ตรง = match by SKU |
| Broad table → ค่ามั่ว | AI ไม่รู้ว่า field "weight" หมายถึงคอลัมน์ไหนใน table นี้ |
| Recurring user corrections | AI ไม่จำว่าครั้งก่อน user แก้แบบไหน |

**Rulebase = "user teaches AI the business context, once per template"**

> ทุก template มีบุคลิกเฉพาะ — Bill of Lading คนละแบบกับ Invoice คนละแบบกับ Purchase Order  
> → Rule ต้อง scoped per template

---

## 1. Architectural Principles

### P1. Template-scoped (รับมาจาก user)
- Rules ผูกกับ Template — ไม่ leak ข้าม templates
- เปลี่ยน template → set rules ใหม่
- Public template → rules included (sharing knowledge)

### P2. Growth without code change
- User mark wrong → AI generates candidate rule → user approves → rule applied
- ระบบฉลาดขึ้นเรื่อยๆ โดยไม่ต้อง deploy

### P3. Transparency
- ทุก rule ดูได้ + ลบได้ + edit ได้
- ทุก extraction บอกได้ว่า "ใช้ rule อะไรไป"
- ไม่มี "AI black box" ที่ user ไม่เห็น

### P4. Token efficiency (Q3 ของ user)
- ไม่ส่ง rules ทั้งหมดให้ AI ทุกครั้ง → smart retrieval
- AI manages rulebase **periodically** (batch curation) ไม่ใช่ per-doc
- Rule cache + embedding for fast lookup

### P5. Reversible
- Reset to default ได้ตลอด
- Versioned rules → rollback ได้
- Soft delete ของ recent rules

---

## 2. Data Model

### 2.1 New Tables

```sql
-- Rules per template
CREATE TABLE template_rules (
    id          TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,             -- who owns the rule (for sharing)
    type        TEXT NOT NULL,             -- 'extraction' | 'alignment' | 'comparison' | 'validation'
    spec_json   TEXT NOT NULL,             -- structured rule (see §3)
    natural_lang TEXT,                     -- human-readable explanation
    source      TEXT NOT NULL,             -- 'user' | 'ai_generated' | 'system'
    confidence  REAL DEFAULT 0.7,          -- 0..1
    hit_count   INTEGER DEFAULT 0,
    miss_count  INTEGER DEFAULT 0,
    enabled     INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    derived_from_correction_id TEXT REFERENCES user_corrections(id)
);
CREATE INDEX idx_template_rules_template ON template_rules(template_id, enabled);

-- User corrections (raw feedback, source for rules)
CREATE TABLE user_corrections (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    template_id TEXT NOT NULL,
    document_id TEXT,                      -- which doc was being viewed
    field_key   TEXT,                      -- which field was wrong
    wrong_value TEXT,                      -- AI's value
    correct_value TEXT,                    -- user's correction
    explanation TEXT,                      -- user's reason (optional)
    status      TEXT NOT NULL,             -- 'pending' | 'rule_generated' | 'rejected' | 'manual'
    rule_id     TEXT REFERENCES template_rules(id),  -- if converted to rule
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Rule application audit (per-extraction telemetry)
CREATE TABLE rule_applications (
    id          TEXT PRIMARY KEY,
    rule_id     TEXT NOT NULL REFERENCES template_rules(id),
    document_id TEXT,
    fired       INTEGER NOT NULL,          -- 1 = rule matched, 0 = considered but skipped
    helpful     INTEGER,                   -- NULL = not yet rated, 1 = good outcome, 0 = bad
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.2 Rule spec_json structure

```json
{
  "type": "extraction",
  "match": {
    "field_value_pattern": "(\\d+\\.?\\d*)\\s*(KGS|kg)",
    "field_value_unit_indicator": ["KGS", "kg"]
  },
  "assert": {
    "field_target": "weight_kgs",
    "field_type": "number_with_unit"
  },
  "exclude": {
    "fields_other_than_target": true
  }
}
```

```json
{
  "type": "alignment",
  "match": {
    "table_field": "products_table",
    "row_anchor_columns": ["sku", "product_code"]
  },
  "assert": {
    "match_strategy": "hungarian_by_anchor"
  }
}
```

```json
{
  "type": "comparison",
  "match": {
    "field_target": "tax_amount",
    "field_type": "currency"
  },
  "assert": {
    "tolerance_absolute": 1.0,
    "tolerance_percent": 0.5
  }
}
```

> Spec เก็บเป็น JSON เพราะ flexible + ตรวจสอบ schema ได้ด้วย JSON Schema  
> Natural language stored alongside สำหรับ UI display

---

## 3. Rule Types & Lifecycle

### 3.1 4 Rule Types

| Type | ตัวอย่าง | Triggered ที่ |
|--|--|--|
| **Extraction** | "Values with 'BAGS' → field 'package_count'" | AI extract prompt |
| **Alignment** | "Match rows by 'sku' column" | Compare row matching |
| **Comparison** | "Tax diff < $5 = equal" | Compare cell verdict |
| **Validation** | "Weight > 100000 KGS → flag suspicious" | Post-extract sanity check |

### 3.2 Rule Lifecycle

```
1. CORRECTION (user feedback)
   User clicks "wrong" on result → fills correction form
        ↓
2. CANDIDATE RULE (AI suggests)
   AI converts correction → 1-N candidate rules with spec_json + natural lang
        ↓
3. REVIEW (user gatekeeper)
   User sees candidate rules + preview → approve / edit / reject
        ↓
4. APPLY (production)
   Rule joins template → next extraction uses it
        ↓
5. TELEMETRY (continuous)
   Track hit/miss + user re-corrections → confidence score updates
        ↓
6. CURATION (AI periodic)
   AI scans rules → suggests merges/conflicts → user approves
        ↓
7. RETIRE (auto or manual)
   Low confidence + many misses → auto-disable (revivable)
   User can manually delete anytime
```

---

## 4. UX Design

### 4.1 Discovery — User รู้ได้ไง ว่าทำได้

**Cue 1: Inline indicator**
- ทุก extracted field มี hover icon เล็ก ⚐ (มุมขวา)
- Hover → tooltip "Click to verify or correct"

**Cue 2: First-time tour**
- หลัง OCR ครั้งแรกสำเร็จ → mini tooltip pulse บน field
- "Tip: คลิกที่ค่าใดๆ → AI เรียนรู้ความถูกต้องของคุณ"
- Dismissible

**Cue 3: After Compare**
- ถ้า detect ความเป็นไปได้สูงว่ามี alignment issue (e.g., unit mismatch)
- Banner: "AI อาจจัดคู่ฟิลด์ผิด — กดที่ฟิลด์เพื่อตรวจสอบ"

### 4.2 Correction Flow — ทำง่ายแค่ไหน

```
[Field card in result panel]
  Quantity: 1,200 BAGS   [✓ correct]  [⚠ wrong]
                                       ↑ click

   ↓ Modal opens (single screen, no scroll)

   ╭─────────────────────────────────╮
   │ Mark "Quantity: 1,200 BAGS"     │
   │ as wrong                        │
   │                                 │
   │ What's the issue?               │
   │ ○ Value is wrong                │
   │ ● Mapped to wrong field         │
   │ ○ Should be ignored             │
   │                                 │
   │ Should be field:                │
   │ [package_count            ▼]    │
   │ (autocomplete from template)    │
   │                                 │
   │ Why? (optional, helps AI)       │
   │ [BAGS = count, not weight   ]   │
   │                                 │
   │      [Cancel]  [Save & teach AI]│
   ╰─────────────────────────────────╯

   ↓ AI analyzes (2-3 seconds) → modal stays open

   ╭─────────────────────────────────╮
   │ AI suggests this rule:          │
   │                                 │
   │ 📋 "Values with 'BAGS' suffix   │
   │     → field 'package_count'     │
   │     (template: BL Doc v2)"      │
   │                                 │
   │ This will affect:               │
   │ • Future BL docs                │
   │ • Not other templates           │
   │                                 │
   │ [✓ Apply rule]  [Edit] [Skip]   │
   ╰─────────────────────────────────╯
```

**Key UX principles:**
- **1 click to start** correction (not buried in menu)
- **No multi-step wizard** — single modal
- **Preview before commit** — show rule + scope before user clicks Apply
- **Skip option** — correction saved as data point even without rule
- **Undo** — within 30s, "Undo" toast

### 4.3 Rule Browser — User ดู rules ของตัวเองได้

**Location:** Template editor → new tab "Rules" (badge: count)

```
┌─ Template: "Bill of Lading v2" ─────────────┐
│ ╭───────╮ ╭───────╮ ╭───────╮ ╭─────────╮  │
│ │Fields │ │Rules ⓘ│ │Tests  │ │Settings │  │
│ │  (8)  │ │ (12)  │ │  (5)  │ │         │  │
│ ╰───────╯ ╰━━━━━━━╯ ╰───────╯ ╰─────────╯  │
│                                              │
│ [Filter: All ▼]  [+ Manual Rule]  ⋮          │
│                                              │
│ ━━━━━ Extraction (8) ━━━━━━━━━━━━━━━━━━━━━ │
│ ┌────────────────────────────────────────┐  │
│ │ 🟢 Values with 'KGS' suffix             │  │
│ │    → field 'weight_kgs'                 │  │
│ │    used 23 times · 96% accurate         │  │
│ │    [view] [edit] [disable] [delete]     │  │
│ ├────────────────────────────────────────┤  │
│ │ 🟡 "ABCD Co." in header line            │  │
│ │    → field 'company_name'               │  │
│ │    used 8 times · 75% accurate (low)    │  │
│ │    💡 AI suggests refinement [view]     │  │
│ ├────────────────────────────────────────┤  │
│ │ 🔴 Pattern "INV-\d+" → invoice_no       │  │
│ │    used 2 times · 50% accurate          │  │
│ │    ⚠ Considered for retirement [keep]   │  │
│ └────────────────────────────────────────┘  │
│                                              │
│ ━━━━━ Alignment (3) ━━━━━━━━━━━━━━━━━━━━━ │
│ ...                                          │
│                                              │
│ ━━━━━ Danger Zone ━━━━━━━━━━━━━━━━━━━━━━━ │
│ [Reset all rules]  [Export rules]  [Import] │
└──────────────────────────────────────────────┘
```

**Filter options:**
- By type (extraction / alignment / comparison / validation)
- By status (active / disabled / retired)
- By confidence (high / med / low)
- By source (user-created / AI-generated)

**Per-rule view (drill-down):**
- Spec JSON (raw + pretty)
- Natural language explanation
- Examples it fired on (from rule_applications log)
- "Test against current doc" — preview effect
- Edit form
- History (versions)

### 4.4 Visibility During Use

**Tagged extraction:**
- Every extracted value shows tiny chip if a rule fired:
  ```
  Quantity: 1,200 BAGS  [💡 rule "BAGS→package_count"]
  ```
- Hover → tooltip with rule details
- Click chip → jump to rule in browser

**Compare result:**
- Each cell verdict shows if rule influenced:
  ```
  ✓ Equal (rule: tax tolerance $5)
  ```

→ Trust through transparency

### 4.5 Cleanup / Reset (Q4 ของ user)

**3 levels of reset:**

1. **Single rule** — delete from rule browser
2. **Bulk** — multi-select → delete / disable
3. **Template-wide reset:**
   ```
   ╭────────────────────────────────────────────╮
   │ ⚠ Reset all rules for "BL Doc v2"?         │
   │                                            │
   │ This will:                                 │
   │ ✓ Keep all 8 fields                        │
   │ ✗ Delete 12 learned rules                  │
   │ ✗ Future extractions use generic AI        │
   │                                            │
   │ ☐ Also delete correction history (47)      │
   │                                            │
   │ Type "RESET" to confirm: [________]        │
   │                                            │
   │     [Cancel]  [Reset rules]                │
   ╰────────────────────────────────────────────╯
   ```

**Soft delete window:**
- Deleted rules go to "Recently deleted" for 30 days
- Restorable from rule browser → Trash tab

### 4.6 Empty / Error States

| Situation | UX |
|--|--|
| Template ใหม่ → 0 rules | "No rules yet. AI will learn from your corrections — try OCR a few docs first" |
| Rule generation failed | "Couldn't generate rule. Your correction was saved. Try again later." |
| Conflict detected | "Rule conflicts with [other rule]. AI suggests merging: [show diff]" |
| User exceeded rule quota (plan limit?) | "Max rules for Free plan reached. Upgrade or delete unused rules" |

---

## 5. AI Integration (token efficiency — Q3)

### 5.1 Smart Rule Retrieval (not "send all rules")

**Per extraction:**
1. Extract field types being requested (e.g., weight, volume, qty)
2. Query rules: `WHERE template_id = ? AND type='extraction' AND enabled=1`
3. Score rules by relevance to current fields (keyword/embedding match)
4. Send **top 5-10** rules to AI
5. Token cost: ~200-500 tokens (negligible)

**Per compare:**
- Same but query alignment + comparison rules
- Send relevant set

### 5.2 AI Rule Manager (periodic batch)

**Trigger conditions:**
- Every N rules added (e.g., 5 new)
- Daily cron (low traffic time)
- Manual "Curate now" button

**What AI does:**
1. Read all rules in template
2. Detect:
   - Duplicates ("X→Y" exists in 3 forms)
   - Conflicts ("X→Y" vs "X→Z")
   - Overgeneralizations ("any number → quantity")
   - Refinements possible (specific cases of broader rule)
3. Output suggestions → save to `rule_suggestions` table
4. User reviews via badge in rule browser

**Cost control:**
- Batch curation = 1 AI call per template per day max
- Not on critical path → no user-facing latency

### 5.3 Rule Quality Scoring

```
confidence = base_confidence × (hit_rate × 0.7 + recency × 0.3)

hit_rate = hit_count / (hit_count + miss_count)
recency = exp(-days_since_last_use / 30)

if confidence < 0.4 and used >= 10 times → auto-disable
if confidence < 0.6 → AI suggests refinement
if confidence >= 0.85 → auto-apply (skip user confirm for similar cases)
```

---

## 6. Implementation Phases

แต่ละ phase **deployable independently** + rollback safe

### Phase A: Foundation (1 สัปดาห์)
- DB schema (template_rules, user_corrections, rule_applications)
- CRUD API endpoints
- Rule browser UI (read-only first)
- Reset / delete functions
- ✗ Not yet: corrections, rule generation, application

### Phase B: Capture Corrections (1 สัปดาห์)
- "Mark wrong" UI on field results (OCR + Compare)
- Correction modal (single screen)
- Store corrections (no rule generation yet)
- Manage corrections UI

### Phase C: Rule Generation (1 สัปดาห์)
- AI prompt: correction → candidate rule
- Preview UI ("Will affect future docs of this template")
- Approve / edit / reject flow
- Rules saved + enabled

### Phase D: Rule Injection (1 สัปดาห์)
- Pre-extract: query relevant rules → inject into prompt
- Track rule_applications (fired vs not)
- Inline UI showing "rule fired" on extracted values

### Phase E: Curation (1 สัปดาห์)
- AI periodic curation job
- Suggestion review UI
- Auto-disable for low-confidence rules

### Phase F: Polish (1 สัปดาห์)
- Confidence scoring + auto-thresholds
- Telemetry dashboard (per template, per user)
- Export/import rules
- Soft delete + restore

**Total: ~6 สัปดาห์** for end-to-end MVP

---

## 7. Integration กับระบบที่มี

| ระบบเดิม | จุดที่ต้องเชื่อม |
|--|--|
| Templates | Add `rules_enabled` flag + scope rules per template |
| OCR extract prompt | Inject relevant rules before AI call |
| Compare prompt | Inject alignment + comparison rules |
| Highlight pipeline v2 | ดู rule attribution ใน telemetry stats |
| Documents lifecycle (M1) | Trigger correction prompt after ocr_count > N |
| Credit system | Rule curation = small AI cost, charge as small "training fee" หรือฟรี |
| Admin tier control | Rule quota per plan (Free=50, Pro=unlimited?) |
| User notifications | "AI curated rules" event |

---

## 8. Risks + Mitigation

| Risk | Mitigation |
|--|--|
| Bad rules degrade extraction | Auto-disable at low confidence + always show "rule fired" badge |
| User creates conflicting rules | AI conflict detection in curation; warn at creation |
| Token cost spikes from rule injection | Top-K retrieval; cap rules per prompt |
| User overwhelmed by rule UI | Hide behind template editor tab; opt-in tour |
| Privacy: rules contain customer-specific data | Per-user scope; org sharing opt-in |
| Rule rot (old rules stay forever) | Confidence decay over time; AI suggests retirement |
| AI generates obviously wrong candidate rules | User preview before apply; reject = correction stays as data |

---

## 9. Decisions to Lock (before coding)

| # | คำถาม | Default ที่แนะนำ |
|--|--|--|
| **D1** | Rules scoped per-user, per-org, หรือ per-template only? | **Per-template + owner-scoped** (template owner controls rules) |
| **D2** | Public templates รวม rules ไหม? | **Yes** (knowledge sharing) — แต่ user สามารถ "fork" + customize ได้ |
| **D3** | AI-generated rules ต้อง user confirm ไหม? | **Yes default**, แต่ high-confidence patterns สามารถ auto-apply ได้ (configurable) |
| **D4** | Rule format JSON หรือ natural language เป็นหลัก? | **JSON spec + NL display** — JSON สำหรับ engine, NL สำหรับ user |
| **D5** | Storage: D1 row หรือ JSON blob ใน templates? | **Separate D1 table** — ง่ายต่อ query + audit |
| **D6** | Quota? | TBD — เริ่ม unlimited, monitor abuse |
| **D7** | Rule versioning? | **Yes** — เก็บ history ใน soft-delete |
| **D8** | Export/import format? | **JSON file** + share via URL |
| **D9** | "Mark wrong" UI ใช้ทั้ง OCR + Compare หรือเฉพาะ Compare? | **Both** — OCR เรียนรู้ field extraction; Compare เรียนรู้ alignment |
| **D10** | Correction ที่ user ไม่ approve rule แต่ correction บันทึก → ทำไง? | **เก็บไว้ใน correction log** — AI batch curate ใช้รวมหลัง |

---

## 10. Open Questions (พูดคุยเพิ่ม)

| # | คำถาม |
|--|--|
| **Q1** | ตอนผู้ใช้ "mark wrong" — รอ AI 2-3 sec แล้วโชว์ candidate rule ใน modal เดียวกัน OK ไหม? หรืออยากให้ save แล้วบอก "rule generated, review later"? |
| **Q2** | Rule conflict resolution — ให้ user เลือก หรือ AI ตัดสินอัตโนมัติ? |
| **Q3** | Cross-template rule sharing — Org level พร้อมขายเป็น Enterprise feature? |
| **Q4** | "Test rule on current doc" — preview function — สำคัญแค่ไหน? (effort เพิ่ม) |
| **Q5** | Rule analytics dashboard — admin level หรือ user level? |
| **Q6** | Mobile UX — ใช้ correction ผ่านมือถือสะดวกแค่ไหน? |

---

## 11. Success Metrics

| Metric | Target |
|--|--|
| Time to first rule generated (from first use) | < 5 min |
| Active rules per template (mean, after 1 month) | > 5 |
| Reduction in repeat corrections same field | > 70% |
| User-reported "AI got it right" rate | > 90% (with rules) vs baseline |
| Time per correction submission | < 30 sec |
| Rule curation user approval rate | > 80% |

---

## 12. Connection with Existing Roadmap

นี่คือ **Phase 6 (Rulebase Tier 1) + Phase 7 (NL → Rule Compiler) ที่ค้างไว้**

| Existing Phase | Map to this plan |
|--|--|
| Phase 5 (EAV + search) | Foundation — rules อ้างถึง EAV field shapes |
| **Phase 6 Rulebase Tier 1** | = Phase A-D ของแผนนี้ |
| **Phase 7 NL → Rule** | = enhancement ของ Phase C (user พิมพ์ NL → AI compile เป็น JSON spec) |

→ ไม่ใช่ scope ใหม่ทั้งหมด — ปรับ roadmap เดิมให้มี UX layer ที่ครบ

---

## 12.5 Template Design Advisor (proactive suggestions to user)

> **Direction:** ปกติ rulebase สอน AI; ส่วนนี้ AI สอน user ตอนกำหนด template — **bi-directional learning loop**
>
> Trigger: ตอน user สร้าง/แก้ field ใน template

### 12.5.1 Why this is needed (Q ล่าสุดของ user)

User สังเกตได้ว่า field configuration มี "anti-patterns" ที่ทำให้ AI extract/compare พังก่อน rulebase จะมีโอกาสเรียนรู้ด้วย:

| Anti-pattern | ผลที่ตามมา |
|--|--|
| **Field type = `table`** กว้างเกินไป | AI ต้องเดา column → unit mismatch + row swap (เคสที่เจอ) |
| **Field name กำกวม** เช่น "ค่า", "จำนวน", "amount" | AI ไม่รู้ว่าหมายถึงอะไร → match ค่าที่ไม่ใช่ |
| **ลืม unit** "weight" แทน "weight_kgs" | AI ไม่รู้ว่าคาดหวัง KGS หรือ LBS |
| **Field ซ้ำซ้อน** "name" + "ชื่อ" | AI แยกไม่ออกว่าควรเก็บค่าเดียวกันหรือไม่ |
| **Type ไม่ตรง** field date type="text" | sort/filter/diff ทำงานไม่ถูก |

### 12.5.2 Detection Engine — 3 ชั้น

```
1. Hard-coded heuristics  → ตรวจ pattern ที่รู้แน่ว่าเสี่ยง
   ↓
2. Historical signal      → field นี้/ชนิดนี้ ในระบบเคย correction บ่อยไหม
   ↓
3. AI 1-shot analysis     → ส่งทั้ง template ให้ AI วิเคราะห์ (เฉพาะตอน save)
```

#### 12.5.2.1 Hard-coded heuristics (cheap, instant)

```ts
function detectAntiPatterns(field): Warning[] {
  const out: Warning[] = [];
  
  // (1) Table type warning
  if (field.type === "table") {
    out.push({
      severity: "info",
      icon: "💡",
      title: "Tables work best when columns are explicit",
      body: "AI may misalign rows when units or columns differ between docs.",
      suggestions: [
        "Define specific fields instead (e.g., weight_kgs, qty_bags)",
        "If you need a table, lock column headers (see Tools)",
      ],
      learnMore: "/help/table-vs-fields",
    });
  }
  
  // (2) Vague name
  const VAGUE_NAMES = /^(ค่า|จำนวน|ข้อมูล|amount|value|data|number|n|qty)$/i;
  if (VAGUE_NAMES.test(field.name.trim())) {
    out.push({
      severity: "warning",
      icon: "⚠️",
      title: `"${field.name}" is too generic`,
      body: "AI will guess between multiple possible values.",
      suggestions: [
        "Add context: 'invoice_amount', 'gross_weight_kgs'",
        "Add a synonym hint: 'amount (subtotal)'",
      ],
    });
  }
  
  // (3) Number/currency without unit
  if (
    (field.type === "number" || field.type === "currency") &&
    !/(kgs?|cbm|bags?|pcs|lbs|tons?|m³|ml|usd|thb|฿|\$)/i.test(field.name)
  ) {
    out.push({
      severity: "info",
      icon: "💡",
      title: "Consider including the unit in the name",
      body: "Helps AI match the right value across docs with different units.",
      suggestions: [
        `'${field.name}_kgs'`, `'${field.name} (KGS)'`,
      ],
    });
  }
  
  // (4) Duplicate / similar fields
  const similar = otherFields.filter(f =>
    f.id !== field.id && levenshteinNorm(f.name, field.name) < 0.3
  );
  if (similar.length) {
    out.push({
      severity: "warning",
      icon: "⚠️",
      title: `Similar field exists: "${similar[0].name}"`,
      body: "AI may confuse the two when extracting.",
      suggestions: [
        "Merge if they mean the same",
        "Differentiate names (e.g., 'gross_weight', 'net_weight')",
      ],
    });
  }
  
  // (5) Date as text
  if (
    field.type === "text" &&
    /(date|วันที่|when|created|expir|issued)/i.test(field.name)
  ) {
    out.push({
      severity: "info",
      icon: "💡",
      title: "This looks like a date field",
      body: "Setting type=date enables comparison, sort, and validation.",
      suggestions: ["Change type to 'date'"],
    });
  }
  
  return out;
}
```

#### 12.5.2.2 Historical signal (no extra AI cost)

Query past corrections + AI usage:

```ts
// "This field gets corrected by users a lot"
const correctionRate = await db.query(`
  SELECT COUNT(*) FROM user_corrections
  WHERE template_id = ? AND field_key = ?
  AND created_at > NOW() - INTERVAL '30 days'
`);
if (correctionRate > 5) {
  suggestions.push("Users correct this field often — consider refining the name or adding rules");
}

// "Field type 'table' on this template historically has alignment issues"
const tableIssueRate = await db.query(`
  SELECT AVG(misses) / AVG(hits + misses) FROM template_rules
  WHERE template_id = ? AND type='alignment'
`);
```

#### 12.5.2.3 AI 1-shot analysis (on save, optional)

```
Trigger: เมื่อ user กด "Save template"
Cost: 1 AI call per save (~500 tokens out)
Cache: skip ถ้า template ไม่เปลี่ยน in last 24h
Opt-out: user setting "Don't analyze templates"
```

Prompt skeleton:
```
You are reviewing an OCR extraction template before it's used.
Find risks that would cause AI to misextract or miscompare values across documents.

Template:
{fields_json}

Look for:
1. Ambiguous field names that could match multiple values
2. Missing unit indicators on numeric fields
3. Overly broad table fields where specific fields would be safer
4. Redundant or conflicting fields
5. Date-like fields with wrong type
6. Missing common fields for this domain (e.g., a BL without "vessel_name")

For each risk, output:
- field_id (or "template")
- severity: info | warning | critical
- short title (<60 chars)
- 1-2 sentence explanation
- 1-3 concrete suggestions
- (optional) example fix

Return JSON array.
```

### 12.5.3 UX — Where suggestions appear

#### Inline (most prominent — field row)

```
┌─ Field: "ค่า" ─────────────────────────────┐
│ Name:  [ค่า              ]  Type: [number▼]│
│                                            │
│ ⚠️ "ค่า" is too generic                    │  ← shown inline
│    AI will guess between multiple values.  │
│    Try: 'invoice_amount', 'tax_thb'        │
│    [Apply suggestion] [Dismiss]            │
└────────────────────────────────────────────┘
```

#### Template-level summary (header)

```
┌─ Template: "BL Document v2" ──── 3 suggestions 💡 ─┐
│                                                    │
│ Fields (8)   Rules (12)  Tests   Settings          │
└────────────────────────────────────────────────────┘
```

Click "3 suggestions" → drawer with all warnings + jump-to-field

#### Save-time gate (soft block on critical)

```
On "Save template" click:
  - run hard-coded + historical heuristics
  - if any 'critical' severity → confirm dialog:
      "Found 1 critical issue. Save anyway or fix first?"
  - if only 'info'/'warning' → save silently with toast: "3 suggestions available"
```

### 12.5.4 Suggestion lifecycle

| State | UX |
|--|--|
| **New** | Highlighted yellow strip, click to expand |
| **Dismissed** | Hidden in main view; restorable via "Show dismissed (N)" |
| **Applied** | Auto-creates a candidate change → user reviews diff → save |
| **Snoozed** | "Don't show this type for 7 days" |
| **Always ignored** | Per-user setting + per-template "Disabled advisor checks" |

### 12.5.5 Don't be annoying

| Risk | Mitigation |
|--|--|
| Too many warnings overwhelm user | Cap at 5 visible; rest in "see more" |
| Same warning shown repeatedly | Track dismissed warnings per-field |
| Wrong heuristic flags valid intent | Always dismissible; "Report bad suggestion" |
| User feels nagged | After 3 dismisses on same warning type → auto-disable that check |
| Slow feedback (AI on save) | Make AI call async; show "Analyzing..." badge; results pop in |

### 12.5.6 Severity levels

| Severity | Color | When |
|--|--|--|
| 💡 **info** | blue subtle | Suggestion that would help, low confidence (e.g., "add unit") |
| ⚠️ **warning** | amber | Known issue pattern (e.g., vague name, similar field) |
| 🔴 **critical** | red | Will likely cause extraction to fail (e.g., empty name, type mismatch with regex) |

### 12.5.7 Bidirectional Learning

> Template Advisor และ Rulebase สอนสองทาง:
>
> **Rulebase** → AI เรียนรู้จาก user corrections (post-extraction)
>
> **Template Advisor** → User เรียนรู้จาก system warnings (pre-extraction)
>
> ทั้งสองใช้ data ร่วมกัน:
> - Correction บ่อยใน field X → Advisor warns ตอน user สร้าง field คล้ายๆ X
> - Rule "X→Y" fires บ่อย → Advisor แนะนำ user เพิ่ม field "Y" ใน template อื่น
> - Advisor dismissed บ่อยใน pattern Z → ปิด check Z global

### 12.5.8 Implementation phase

| Phase | สาระ | Effort |
|--|--|--|
| **G.1** | Hard-coded heuristics (5 ตัว) + inline display | 2-3 วัน |
| **G.2** | Historical signal queries | 1-2 วัน |
| **G.3** | AI 1-shot analysis on save | 2-3 วัน |
| **G.4** | Snooze + dismiss + global settings | 1 วัน |
| **G.5** | Bidirectional data flow (Advisor ↔ Rulebase) | 2-3 วัน |

**Total Phase G: ~1-1.5 สัปดาห์** — ทำหลัง Phase A-B (Foundation + Capture corrections)

### 12.5.9 Open questions specific to Advisor

| # | คำถาม | Default |
|--|--|--|
| **QA1** | AI analysis on save = free or premium? | **Free for first N/month, premium for unlimited** |
| **QA2** | Block save on critical? | **Soft block (confirm dialog), never hard block** |
| **QA3** | Suggestions across templates (shared knowledge)? | **Yes per-user, opt-in per-org** |
| **QA4** | "Apply suggestion" auto-edits field? | **Yes** but show diff preview |
| **QA5** | Multi-language hints (TH ↔ EN)? | **Yes** — heuristic dictionary supports both, AI prompt auto-detects |

---

## 13. Out of Scope

- ❌ Federated learning across orgs (privacy nightmare)
- ❌ A/B testing rules
- ❌ Rule marketplace ก่อน MVP ship
- ❌ Voice correction
- ❌ Auto-extract rules จาก example docs (future Phase H)
- ❌ Template Advisor for non-template OCR (one-off OCR ไม่ต้องเตือน)

---

## 14. Next Steps

1. **คุย + ตัดสิน D1-D10** + Q1-Q6
2. ตรวจ **dependency กับ M1 (Documents lifecycle)** — rules ผูกกับ document_key
3. ตัดสินใจ **Phase 5 EAV ทำคู่ขนานหรือก่อน**
4. **Phase A start** — DB + read-only viewer (low risk)
5. Iterate per phase + telemetry feedback

---

## 15. Related Documents

- [docs/COMPARE_HIGHLIGHT_PIPELINE_PLAN.md](COMPARE_HIGHLIGHT_PIPELINE_PLAN.md) — Phase 1-5 (ทำเสร็จไป 4)
- [docs/OCR_LIFECYCLE_AND_COMPARE_REWORK_PLAN.md](OCR_LIFECYCLE_AND_COMPARE_REWORK_PLAN.md) — M1-M3
- [docs/170626/RULEBASE_FEATURE_SPEC.md](170626/RULEBASE_FEATURE_SPEC.md) — original spec (handoff doc)
- [docs/PENDING_FEATURES_BACKLOG.md](PENDING_FEATURES_BACKLOG.md) — Phase 6/7 reference
