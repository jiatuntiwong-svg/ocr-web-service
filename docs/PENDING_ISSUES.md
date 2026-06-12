# DOCRoom — Pending issues & backlog

Snapshot taken 2026-05-25 after Phase 6C-2a (.docx → image) deploy.
Items below are intentionally deferred; pick up in any order.

---

## A. Compare quality (AI + matching depth)

| # | Issue | Root cause | Fix layer | Priority |
|---|---|---|---|---|
| A1 | AI extract truncates mid-word (e.g. `…KLONGTOEY SH`) → false positive diff | AI boundary detection | Prompt | 🔴 high |
| A2 | AI doesn't grasp semantic equivalence (`10 + 5 + 3` vs `18`) | Literal text comparison | Prompt | 🔴 high |
| A3 | Date format diffs flagged (`26/09/2025` vs `26 SEP 2025`) | No per-type normalisation in compare prompt | Prompt + per-type rules | 🟡 mid |
| A4 | Currency/number format diffs flagged (`USD 51,651.11` vs `51651.11 USD`) | Same | Prompt + per-type rules | 🟡 mid |
| A5 | List order treated as diff (`A,B,C` vs `C,A,B`) | No set semantics | Prompt + table-type logic | 🟡 mid |
| A6 | Thai OCR split letters confuse matcher | Tesseract/AI character segmentation | Matcher tuning | 🟢 low |

**Path:** Prompt overhaul — combine per-type rules + few-shot examples + shipping-domain rules in one batch. Needs 5-10 sample false-positive cases from real runs to design few-shots.

---

## B. .docx preview fidelity

**Symptom:** mammoth flattens Word layout — 2-column sections, tab stops, text frames all collapse to left-aligned flow.

**Decision pending.** Options proposed:
- Option 1 — Hybrid (try docx-preview first, fallback mammoth). Free, ~2h work.
- Option 2 — CloudConvert (.docx → PDF). ~$0.005/file, 500 free/mo. Best fidelity.
- Option 3 — Self-host LibreOffice on VM. ~$10/mo, best long-term cost + privacy.

**Currently:** mammoth output works — content reliable, layout flat. Acceptable but not pretty.

---

## C. .doc legacy binary support — Phase 6C-2c

| Task | Status |
|---|---|
| POC with `word-extractor` — 1900+ chars extracted in 3-9ms | ✅ Verified |
| Worker route `/api/extract/doc` taking `Buffer` → text | ⏳ Pending |
| Compare branch: .doc → text-only mode (no preview, no highlight) | ⏳ Pending |
| UI: file badge "no preview · text only" + disable highlight overlay for that slot | ⏳ Pending |

`word-extractor` is Workers-compatible because we already enable `nodejs_compat` in `wrangler.jsonc`.

---

## D. Excel support — Phase 6C-3

POC accuracy verified: **Prompt D (CSV+coords)** → 100% cell-accuracy on 2 real shipping docs.

| Phase | Scope | Status |
|---|---|---|
| 6C-3a | Single Excel preview in OCR — SheetJS parse + Prompt D + cell highlight + sheet tabs | ⏳ Not started |
| 6C-3b | Excel in Compare (multi-doc, cell-based diff) | ⏳ Not started |
| 6C-3c | Polish: large file pagination, multi-cell pulse animation | ⏳ Not started |

Schema decided:
```ts
type ExcelHighlight = { sheet: number; row: number; col: number };
// AI response per Prompt D:
{ [field]: { value: string, cells: ExcelHighlight[], confidence: number } }
```

---

## E. i18n migration leftover

`renderCompareData` helper at `DashboardView.tsx:90-121` has hardcoded Thai ("ต่าง", "เหมือน", "ไม่มีข้อมูลเปรียบเทียบ"). It's module-level so has no `t` scope.

**Fix:** refactor into a sub-component, or pass `t` as a parameter. Low visibility — only shown when expanding a compare-type Recent Activity row.

---

## F. Nice-to-haves

| # | Feature | Priority |
|---|---|---|
| F1 | Multi-page PDF page navigator (Prev/Next buttons + page-count indicator) — currently relies on scroll | 🟢 low |
| F2 | Manual review UX — buttons to override AI ("actually same" / "actually diff") to protect against false negatives | 🟡 mid |
| F3 | Light-theme palette fine-tune — current values are placeholders, not design-QA'd | 🟢 low |
| F4 | Upload size guard — docx-to-image has no cap; very large embedded images can OOM the canvas | 🟢 low |
| F5 | Mixed file types in Compare (e.g. Doc1=PDF + Doc2=Excel) — currently assumes one type per run | 🟢 low |

---

## G. Future improvements (Phase 7+)

Captured 2026-05-25 from product brainstorm. Each subsection has an
implementation plan + trade-offs; pick up in any order.

### G1. Pricing model rework 🔴 critical — **formula decided 2026-05-25**

**Problem:** flat "1 credit per OCR run" doesn't scale with field count
or doc count. Compare burns ~3× OCR tokens (per monitoring), and 37-field
templates blow through token budgets that 1 credit can't cover.

**Decided formula (multiplicative):**
```
ocr_factor    = 1 + max(0, fields − 10) × 0.1
ocr_credits   = max(1, ceil(ocr_factor × model_mult))
compare_creds = max(2, ceil(ocr_factor × num_docs × 1.5 × model_mult))
```

- `1.5` = Compare overhead (diff prompt + dual output) — matches monitored 3× token cost on 2-doc compare
- `model_mult` = 1.0 for everyone at launch; tune per-tier later using real cost data from AdminAIUsageView
- Min Compare credit = 2 to prevent underpricing

**Reference table:**
| Op | Fields | Docs | Credits |
|---|---|---|---|
| OCR | 5 | - | 1 |
| OCR | 10 | - | 1 |
| OCR | 20 | - | 2 |
| OCR | 37 | - | 4 |
| Compare | 10 | 2 | 3 |
| Compare | 10 | 3 | 5 |
| Compare | 10 | 4 | 6 |
| Compare | 20 | 2 | 6 |
| Compare | 37 | 2 | 12 |
| Compare | 37 | 3 | 18 |

**Migration:** hard cutoff — no real users yet, no grandfather needed.

**Table-field row factor (estimate + post-adjust):**
```
table_row_factor = 1 + max(0, avg_rows − 10) × 0.05
                   (avg_rows = sum of table rows across docs / num_docs)
final_compare_creds = max(2, ceil(ocr_factor × num_docs × 1.5
                                  × table_row_factor × model_mult))
```

Flow:
1. **Estimate (pre-run)** uses `table_row_factor = 1.0` (row count unknown)
2. **Reserve** estimate credits from user balance
3. **AI runs** → returns table rows
4. **Adjust** if `actual > estimate` → charge supplement; show receipt diff
5. **`documents.credits_used`** stores the actual final number

Example post-adjust table:
| Scenario | Estimate | Actual |
|---|---|---|
| 2 doc, 10 fields, 5-row table | 3 | 3 |
| 2 doc, 10 fields, 25-row table | 3 | 5 |
| 2 doc, 10 fields, 50-row table | 3 | 9 |
| 3 doc, 37 fields, 30-row table | 18 | 36 |

### G1k. Smart credit confirmation dialog (decided 2026-05-25)

Show estimate inline ALL the time; pop a confirm dialog only when
one of the following triggers fires:

| Trigger | Default threshold |
|---|---|
| T1 absolute high | estimate > 3 credits |
| T2 relative spike | estimate > user_avg × 1.5 |
| T3 variable cost | any field has type = `table` |
| T4 low balance | estimate > balance × 10% |

`shouldConfirm = T1 OR T2 OR T3 OR T4` (conservative — any trigger fires it).

User can tune thresholds in Preferences. "Don't ask again" is **per-template** —
saves a fingerprint of `(template_id, field_count, doc_count)`; same template
with the same shape skips the dialog next time.

**Sub-tasks:**
- G1k-1. Cache user avg credits per extraction (background, refresh on each run)
- G1k-2. `shouldConfirm()` predicate with 4 triggers
- G1k-3. `<CreditConfirmDialog>` reusable component (OCR + Compare)
- G1k-4. Preferences UI for 4 threshold values
- G1k-5. "Don't ask again" persistence keyed by `(template_id, field_count, doc_count)`

### G6. Compare table-field row-level diff (decided 2026-05-25)

For `type=table` fields, the result panel should show row-by-row diff with
column-level highlights, not just a single is_diff flag.

**Approach C (hybrid):** AI extracts structured rows + suggests `match_key`,
client matches rows + computes cell-level diff.

**Schema:**
```ts
interface TableField extends CompareField {
  type: "table";
  rows?: { doc1: any[]; doc2: any[]; doc3?: any[]; doc4?: any[] };
  match_key?: string;                                 // e.g. "item_code"
  row_diffs?: {
    key: string;
    status: "match" | "diff" | "missing_in_docN";
    cells: { doc1?: any; doc2?: any; diff_columns?: string[] };
  }[];
}
```

**Sub-tasks:**
- G6a. AI prompt rewrite — return structured rows + suggested match_key
- G6b. Client row matching algorithm — by match_key, fallback to position
- G6c. Cell-level diff with per-type normalisation (numeric/date/text)
- G6d. Frontend table-diff renderer — side-by-side with row + cell highlight
- G6e. Missing-row display ("—" + status badge "missing in doc N")
- G6f. Export Excel/CSV with row-diff structure
- G6g. Defer to later: row-level highlight in PDF/image preview (bbox per row)

**Tasks:**
- G1a. Compute credit estimate before upload (preview "this will use X credits")
- G1b. Schema: `documents.credits_used` INTEGER (replace hard-coded 1)
- G1c. Backend deduct uses model + field count formula
- G1d. Frontend: estimate shown when picking template / before Run button
- G1e. Admin tier control: per-tier multiplier (free=1×, pro=0.8×)
- G1f. Migrate existing usage rows to new model
- G1g. Compare credit cost against actual `documents.input_tokens / output_tokens` (already tracked in AdminAIUsageView) for tuning

### G2. Validation rules / Skill.md per template 🔴 differentiator

User-defined rules that auto-validate the extracted payload — biggest
competitive moat (no public OCR competitor has this).

**Vision:** each template owns a `rules.md` (natural-language) AND/OR
machine-checkable rules. Validator runs on extraction result, marks
violations.

```
templates/
  shipping-invoice/
    fields.json      ← field definitions
    rules.md         ← validation rules (skill-style)
    examples/        ← few-shot examples for AI
  purchase-order/
    fields.json
    rules.md
```

**Three rule engines (recommend hybrid):**
- 4a. Code-based: regex/range/format predicates — deterministic, free
- 4b. AI-driven: natural language rules → AI validates — flexible, costs tokens
- 4c. **Hybrid** ⭐ — deterministic for syntactic checks, AI for business logic

**Tasks:**
- G2a. Rules editor UI (Markdown with preview)
- G2b. JSON rule schema `{ field, type, params }` + parser
- G2c. Code-engine validator (regex, range, format, presence)
- G2d. AI validator route — prompt with `{ rules, extracted_data }`
- G2e. Result UI: violations + suggestions inline on each field
- G2f. Save rules as template attachment OR standalone rule set
- G2g. Export "validation report" alongside Excel/CSV

**Example rules.md content:**
```markdown
## Required
- shipper_name, consignee_name, bl_number, vessel

## Validation
- bl_number: matches /^[A-Z]{2,4}[A-Z0-9]{6,12}$/
- gross_weight: numeric > 0, unit ∈ {KGS, KG}
- invoice_date: within last 6 months

## Business rules
- if port_of_loading contains "THAILAND" → vessel must include voyage no
- container count must equal NET WEIGHT lines count
```

### G3. Confidence threshold + manual review 🟡 quality

**Tasks:**
- G3a. Per-user `confidence_threshold` setting (default 70) in Preferences
- G3b. Per-template override (`confidence_threshold` field in template JSON)
- G3c. Auto-flag "Needs Review" badges on low-confidence fields
- G3d. Block export with low-confidence fields (modal: review or override)
- G3e. "Mark as reviewed" workflow (per field, persisted)
- G3f. Confidence trend chart on Dashboard
- G3g. Schema: `users.confidence_threshold`, `documents.reviewed_at`,
       `documents.reviewed_fields` (JSON)

### G4. Compare 4 docs + XML support 🟢 expansion

**4-doc compare:**
- G4a. `files.length < 3` → `< 4` (trivial)
- G4b. Grid layout: 4 cols (fullscreen-friendly only)
- G4c. Schema: `CompareField.doc4` + `locations.doc4`
- G4d. AI prompt: extract 4 cols + diff (cost +~33%)
- G4e. `runComparison`: doc[0..3] loop

**XML support (new format — easiest of all):**
- G4f. Browser `DOMParser` to parse XML in client
- G4g. `<XmlPreview>` component: tree view with expand/collapse
- G4h. Highlight by tag path + occurrence index
- G4i. AI prompt: send XML as text, request tag path + value
- G4j. Compare 2+ XML: diff at tag-path level

XML extraction quality is expected to be very high — structured semantics
remove the position-guessing problem.

### G5. Data export / integration 🟢 integration

For users who want extracted data beyond just Compare:
- G5a. **Webhook on completion** — POST extracted data to user endpoint
- G5b. Public API + API key (partial exists) — extend + write docs
- G5c. **Bulk export** — select multiple docs on Documents page → combined Excel/JSON
- G5d. Post-processing pipeline — define transform rules (rename/combine/calc)
- G5e. Scheduled batch — upload folder → process all → email/webhook
- G5f. n8n / Zapier connector
- G5g. ERP integrations (SAP, Oracle NetSuite, etc.) — far future

---

## Suggested Phase 7+ roadmap

**Phase 7 (next):**
- G1 — Pricing model rework (business critical)
- G3 — Confidence threshold + review UX (quality win)

**Phase 8 (differentiation):**
- G2 — Skill.md rule system (biggest moat)

**Phase 9 (expansion):**
- G4 — 4 docs + XML
- G5a + G5c — Webhook + bulk export (high-value, low-effort integrations)

**Phase 10 (later):**
- G5b + G5f — Public API polish + n8n connector
- G5d — Post-processing pipeline
- G5e — Scheduled batch

---

## H. Error UX audit (added 2026-05-25)

User sees raw API error strings everywhere — they leak technical detail
(stack traces, "AI returned invalid format", HTTP codes, English-only).
Need a layered remediation: friendly user-facing strings, a small i18n
error catalog, and a logger for the dev-facing detail.

### H1. Frontend sites that surface raw errors

| File | Line | Pattern | Severity |
|---|---|---|---|
| OCRWorkspace.tsx | 217 | `setError(err.message \|\| "Upload failed")` | 🔴 high — user-facing flow |
| CompareWorkspace.tsx | 763 | `setError(err.message \|\| "An error occurred during comparison.")` | 🔴 high |
| CompareWorkspace.tsx | 457, 468 | `setError(t("compare.convertFailed", { msg: err.message }))` | 🟡 mid — already i18n'd but msg is raw |
| AdminLogsView.tsx | 28, 31 | `setError(data.error \|\| ...); setError(err.message)` | 🟡 mid — admin only |
| AdminAIUsageView.tsx | 108, 135 | `setError(err.message)` | 🟡 mid — admin only |
| AdminTierControlView.tsx | 53, 78 | `setError(err.message)` | 🟡 mid — admin only |
| AdminUsersView.tsx | 134, 144, 154, 162, 176 | `showToast(e.message, "error")` × 5 | 🟡 mid — admin only |
| login/page.tsx | 41 | `setError(data.error \|\| "Login failed")` | 🔴 high — public-facing |
| register/page.tsx | 59 | `setError(data.error \|\| "Registration failed")` | 🔴 high — public-facing |
| APISettingsView.tsx | 48, 52, 70, 73, 108, 126 | `alert("Error ...")` × 6 | 🔴 high — uses raw `alert()` |
| BillingView.tsx | 42, 46 | `alert(data.error \|\| ...)` | 🔴 high — billing flow |

### H2. Backend error messages that need user-friendly translation

| API | Error | Issue |
|---|---|---|
| `/api/auth` | "Invalid email or password" | OK — clear |
| `/api/auth` | `err.message ?? "Login failed"` | leaks internal |
| `/api/compare` | "AI returned invalid format" | technical, not user friendly |
| `/api/compare` | "No AI configuration available" | tech detail leak |
| `/api/compare` | `error.message \|\| "Internal server error"` | catch-all leak |
| `/api/upload` | `error.message` | leaks internal stack/db detail |
| `/api/templates` | `error.message` | leaks internal |
| `/api/status` | `error.message` | leaks internal |
| `/api/stats` | `err.message` | leaks internal |
| `/api/v1/extract` | `error.message \|\| "Internal server error"` | leak |
| `/api/v1/extract` | "AI returned invalid format" + `raw: text` | leak |
| `/api/billing/checkout` | `Unauthorized` | OK but English only |
| All routes | English error strings | not i18n'd |

### H3. Remediation plan (Phase 7.5 or later)

**Step 1 — Error catalog (i18n keys)**
Define a small set of canonical user messages in `i18n/locales/`:
```ts
errors: {
  generic:        "เกิดข้อผิดพลาด กรุณาลองอีกครั้ง",
  network:        "ไม่สามารถเชื่อมต่อระบบ — ตรวจสอบอินเทอร์เน็ต",
  unauthorized:   "กรุณาเข้าสู่ระบบใหม่",
  insufficient:   "เครดิตไม่พอ — งานนี้ใช้ {need} credits แต่คงเหลือ {have}",
  upload_failed:  "อัปโหลดไม่สำเร็จ กรุณาลองอีกครั้ง",
  ai_failed:      "AI ไม่สามารถประมวลผลเอกสารนี้ได้ — ลองอีกครั้งหรือเปลี่ยนเอกสาร",
  rate_limited:   "ใช้งานบ่อยเกินไป กรุณารอสักครู่",
  feature_off:    "ฟีเจอร์นี้ไม่ได้เปิดใช้งานสำหรับแพลนของคุณ",
  ...
}
```

**Step 2 — Backend error codes (not messages)**
Each API returns `{ ok: false, code: "AI_FAILED" | "INSUFFICIENT_CREDITS" | ..., detail?: string }`.
- `code` is what the frontend keys into i18n.
- `detail` is dev-facing — only logged, never shown.

```ts
// Example shape
{ ok: false, code: "AI_FAILED", detail: "Gemini quota exceeded" }
```

**Step 3 — Frontend `apiError(code, vars?)` helper**
Single helper that takes a backend code and returns the localized string.
Replace all `setError(err.message)` with `setError(apiError(json.code, json.vars))`.

**Step 4 — Catch + classify**
Network errors (fetch threw) → `errors.network`; HTTP 401 → `errors.unauthorized`;
HTTP 429 → `errors.rate_limited`; everything else falls back to `errors.generic`
PLUS logs the raw detail to console.

**Step 5 — Stop using `alert()`**
Replace all `alert("...")` calls (APISettingsView, BillingView) with a real
toast notification component. Already have one pattern in AdminUsersView's `<Toast>`.

### H4. Quick wins (before full refactor)

- Replace 11 `alert()` calls with toast in APISettingsView + BillingView
- Strip `raw: text` from `/api/compare` and `/api/v1/extract` error responses
- Wrap all `err.message` setError calls in a single `friendlyError(err)` util
  that maps common patterns (`fetch failed`, `NetworkError`, `quota`) to
  pre-canned Thai strings

### H5. Test coverage

After fix, write a small test that asserts:
- No API response body contains `err.stack`
- No frontend `setError` is called with a raw `Error` object
- All toast messages route through the i18n error catalog

---

## Decisions still open

1. **B — .docx fidelity path:** Hybrid / CloudConvert / Self-host?
2. **A — Compare prompt overhaul:** all-in-one batch vs piece-by-piece?
3. **Order of remaining phases:** C → D → A, or D → C → A, or A first?

---

## I. Compare prompt size baseline (snapshot 2026-05-28)

Reference numbers for the Compare prompt at version **v7-no-truncate**, measured
on a typical run (2 docs, 8 fields including 1 table). Use this as the baseline
when deciding whether prompt-rule additions are worth their token cost, or to
spot regressions in prompt bloat.

| Metric | Value |
|---|---|
| Lines | 74 |
| Chars | 5,697 |
| UTF-8 bytes | 6,017 |
| Thai chars | 137 |
| **Estimated input tokens** | **~1,481** |

Token shares (rough):

| Section | Lines | ~Tokens | Notes |
|---|---|---|---|
| Rule 10 (TABLE schema + JSON example) | 14 | ~310 | Example JSON is the single biggest line cluster |
| Rule 6 (no-truncate + GOOD/BAD examples) | 9 | ~280 | Added in v7 (this round) |
| Rule 9 (docN_diff symmetry rules) | 5 | ~220 | Critical for highlight quality, verbose |
| Rules 1-5, 7, 8 | 11 | ~260 | |
| Header + field list | 12 | ~150 | Scales ~10 tokens per Thai field |
| Response schema example | 14 | ~150 | |
| Rule 11 (confidence bands) | 6 | ~110 | |

Context (Gemini 2.5 Flash):
- Image input per PDF page ≈ 258-1300 tokens
- 2 docs × 1-2 pages = ~520-5200 image tokens
- Prompt ~1481 tokens = **~10-30% of total input** — not the dominant cost

### Optimisation candidates (deferred — measure first)

Available cuts if size becomes an issue, with estimated savings:

| Cut | ~Saving | Risk |
|---|---|---|
| Trim rule 10 example to 1 row pattern (drop second row) | ~80 tokens | Low — keeps shape clear |
| Drop one of rule 6's GOOD/BAD example pairs | ~120 tokens | Medium — may weaken adherence |
| Compress rule 9 bullets into single paragraph | ~80 tokens | Medium — symmetry rule is fragile |

**Decision:** hold optimisation — run real traffic first, gather token usage from
`AdminAIUsageView`, and only trim if AVG `inputTokens` per Compare exceeds budget.

Authoritative measurement: use the actual `usage.inputTokens` reported by the
provider (already logged via `logAiUsage`) rather than this rough estimator.
The estimator (`ascii/4 + thai/1.5`) is ±10-15% accurate.
