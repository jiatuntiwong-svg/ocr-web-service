# Compare Highlight Pipeline — Cascading Fallback Plan

> สถานะ: **DESIGN ONLY — ยังไม่ implement**
> วันที่บันทึก: 2026-06-18
> ขอบเขต: ปรับปรุงความแม่นยำของ highlight ในหน้า Compare เพื่อให้ user "กวาดตาเห็นผิดได้ทันที"
> Principle: **ของเดิมทำงานปกติ pipeline ใหม่เป็น layer เสริม + rollback ได้ผ่าน feature flag**

---

## 0. โจทย์ (Problem Statement)

User feedback:
- **A.** บางครั้ง highlight ไปครอบจุดที่ไม่เกี่ยวข้อง → user สับสน
- **B.** Table cells ที่ต่างกัน บ่อยครั้งไม่มี highlight
- **C.** Highlight เยอะเกินไป (รก) → ตาตามไม่ทัน

**Key user goal:** scan-and-spot (กวาดตามอง) — ไม่ใช่ focus-and-search (อ่านทีละบรรทัด)
- ถ้าไม่มี highlight = "ปลอดภัย"
- ถ้ามี highlight = "นี่แหละจุดที่ต่าง" — focus เฉพาะตรงนั้น

**ที่ไม่ใช่ปัญหา (per user 2026-06-18):**
- ขนาดของกรอบ — ปัจจุบันใช้งานได้
- การ render (สี, dash, opacity ของ box vs underline) — มีอยู่แล้ว

---

## 1. Architecture Principle — Rollback-Safe Design

> **กฎ:** ของเดิมต้องทำงานปกติได้ตลอด pipeline ใหม่เป็น optional layer

### 1.1 Feature flag hierarchy
```ts
// src/lib/featureFlags.ts
ENABLE_HIGHLIGHT_PIPELINE_V2          // master flag — ปิดหมด = ของเดิม 100%
  ├─ ENABLE_TEXT_LAYER_EXTRACTION     // Step 0 (foundation)
  ├─ ENABLE_BBOX_VALIDATION           // Step 1
  ├─ ENABLE_TEXT_LAYER_SEARCH         // Step 2
  ├─ ENABLE_TABLE_INFERENCE           // Step 3
  └─ ENABLE_HIGHLIGHT_POSTPROCESS     // De-dupe + group
```
- ปิด master flag → fall back to existing render path completely
- เปิดทีละ sub-flag → debug isolate ได้

### 1.2 ไม่แตะของเดิม (Append-only)
- **NEW module:** `src/lib/highlight-pipeline.ts` — pure functions
- ของเดิมยัง compute `highlights` array แบบเดิม → **pipeline เป็น decorator** ที่รับ input เดิม → ออก output ที่ enrich แล้ว
- ถ้า pipeline error → log + fall back to original highlights

### 1.3 Telemetry built-in
- Log decision ต่อ field: ผ่าน step ไหน, confidence, fallback chain
- ส่ง log เข้า system_events (มีอยู่แล้ว) → admin dashboard
- ใช้สำหรับ tune threshold + identify edge cases หลัง deploy

### 1.4 Side-by-side debug mode
- Hidden URL param `?compareDebug=1` → render bbox เก่า + ใหม่ ทับกัน คนละสี
- ใช้สำหรับ verify หลัง deploy
- ปิดเมื่อพร้อม → log ใน admin tier control toggle

---

## 2. 8 Decisions — Pros, Cons, Recommendation

### D1. รัน pipeline ที่ไหน — Client vs Server

| Option | ข้อดี | ข้อเสีย |
|--|--|--|
| **Client (browser)** ⭐ แนะนำ | • Backend zero-change → rollback ง่ายมาก<br>• pdf.js text extract API มี (react-pdf ใช้อยู่)<br>• Latency เห็นทันที (debug ง่าย)<br>• ไม่กิน Workers compute time<br>• ไม่ต้องคิด server-side caching | • เครื่องเก่า/มือถือช้า<br>• text layer ใหญ่อาจ block UI (ต้อง web worker)<br>• Bundle size เพิ่ม (~50KB pdfjs already loaded) |
| Server (Workers) | • Multi-user share cache<br>• Client lightweight | • กระทบ backend → rollback ยากกว่า<br>• Workers 30s limit<br>• pdfjs on Workers = WebAssembly setup ยุ่ง<br>• Cost: extra compute time |

**→ Recommend: Client-side**
**เหตุผล:** Compare เป็น per-session workflow, rollback safety สูงสุด, ใช้ infrastructure ที่มีอยู่แล้ว

---

### D2. Cache Text Layer

| Option | ข้อดี | ข้อเสีย |
|--|--|--|
| **In-memory (useRef Map)** ⭐ แนะนำ | • Zero state, simple<br>• Auto-cleanup เมื่อ component unmount<br>• ไม่มี persistence bugs | • Refresh = re-extract (acceptable for Compare workflow) |
| LocalStorage | • Persist across reload | • Quota 5-10MB limit<br>• Text layer ใหญ่ → quota exceeded ง่าย<br>• Synchronous = blocks |
| IndexedDB | • เก็บได้ใหญ่<br>• Persist | • Setup complex<br>• Eviction logic ต้องคิดเอง |
| WeakMap (key by File) | • Auto-GC | • Lose on any re-render of parent |

**→ Recommend: In-memory `Map<string, ParsedTextLayer[]>`** keyed by file fingerprint (size+name+lastModified)
**เหตุผล:** Compare ไม่ใช่ daily workflow, re-extract on reload OK, simple cleanup

---

### D3. Validation Threshold

| Option | ข้อดี | ข้อเสีย |
|--|--|--|
| **Normalized exact + Levenshtein fallback** ⭐ แนะนำ | • 95% case จับด้วย exact<br>• 5% noisy → fuzzy พอ<br>• Tunable threshold per case | • Two-pass ช้ากว่าเล็กน้อย<br>• ต้อง implement fuzzy lib |
| Exact only | • Zero false positive | • ทิ้งเยอะ (typo, whitespace) |
| Fuzzy 70% | • Tolerant OCR noise | • False positive รั่วเยอะ (สั้นๆ มี similarity สูง) |
| Per field type | • ฟิลด์ตัวเลขเข้ม ฟิลด์ที่อยู่หลวม | • Complexity, ต้องดูแล mapping |

**→ Recommend: Normalized exact (case-insensitive, trim, collapse-whitespace) → fallback Levenshtein distance < min(3, len*0.15)**
**เหตุผล:** Strict-first ป้องกัน false positive (โจทย์หลัก), fuzzy เป็น safety net

---

### D4. Confidence Levels

| Option | ข้อดี | ข้อเสีย |
|--|--|--|
| 2 (high/low) | • UI ง่าย | • Lose nuance |
| **3 (high/medium/low)** ⭐ แนะนำ | • พอแยกความน่าเชื่อถือ<br>• Visual ออกแบบได้ชัด | • ต้องออกแบบ 3 states |
| 5 (1-5) | • Very granular | • User ไม่เห็นต่าง, overkill |

**→ Recommend: 3 levels**
| Level | ที่มา | Visual |
|--|--|--|
| **High** | Text layer exact match | กรอบ 2.5px solid + bg 0.35 + glow |
| **Medium** | Text layer fuzzy match หรือ AI bbox + validate ผ่าน | กรอบ 2px solid + bg 0.20 |
| **Low** | Heuristic fallback / table inference | กรอบ 1.5px dashed + bg 0.10 |

---

### D5. Match Field Default

| Option | ข้อดี | ข้อเสีย |
|--|--|--|
| **ซ่อน match by default** ⭐ แนะนำ | • ตรง user goal — focus diff อย่างเดียว<br>• Less visual noise<br>• Toggle ALL/DIFF มีอยู่แล้ว (เปลี่ยน default) | • Initial reaction "highlight หายไปไหน?" |
| แสดงจาง (low opacity) | • เห็น context | • ยังรกอยู่ |
| แสดงตามปกติ | • Backward compat | • ไม่ตอบโจทย์ |

**→ Recommend: เปลี่ยน default `showOnlyDiff` จาก `false` → `true`** (toggle ALL/DIFF ทำไปแล้ว ใช้ของเดิม)
**ผลข้างเคียง:** Existing user ที่เปิด Compare ครั้งแรก จะเห็นแค่ diff — ใส่ tooltip "Showing diffs only — click ALL to see matches"

---

### D6. Table Detection

| Option | ข้อดี | ข้อเสีย |
|--|--|--|
| **Heuristic (x-alignment)** ⭐ แนะนำ | • Zero AI cost<br>• Predictable<br>• Text PDF จะมี alignment ตามฟอนต์ → reliable | • ตารางที่ไม่มี clear structure ทำไม่ได้<br>• Merged cells ลำบาก |
| AI-assisted (extra call) | • Accurate | • +cost +latency, AI อาจ flaky |
| Hybrid | • Balance | • Complexity, 2 paths |

**→ Recommend: Heuristic only (MVP), AI-assist เพิ่มถ้าจำเป็น**
**Algorithm:**
1. Scan text items, group by similar y-coord (rows)
2. Detect header row: row ที่มี keywords เช่น Qty, Price, Total, etc. (config list)
3. แต่ละ header → จด x-coord
4. Subsequent rows: text items ที่ x ใกล้ header → จัด column
5. ได้ grid: `{ col_name → x_range, row_idx → y_range }`

**Fallback:** ถ้า heuristic detect ไม่ได้ → ใช้ existing row-derived scan (มีอยู่แล้ว)

---

### D7. Search Algorithm

| Option | ข้อดี | ข้อเสีย |
|--|--|--|
| Exact substring (`indexOf`) | • Fast, predictable | • Case sensitive, whitespace ต่างไม่เจอ |
| **Normalized exact + fuzzy fallback** ⭐ แนะนำ | • Robust, 2-tier strategy | • Implementation 2 paths |
| Pure fuzzy (Levenshtein) | • Tolerant | • O(m*n) slow on long page |
| Token-based | • Word-aware | • Complexity, tokenizer edge cases |

**→ Recommend: Normalized exact (1st) → Levenshtein fallback (2nd, only short fragments)**
**Context-aware enhancement:** ใช้ AI bbox เป็น "hint" — ถ้า exact match หลายตัว → เลือกตัวที่ใกล้ AI bbox สุด

---

### D8. Multi-page Handling

| Option | ข้อดี | ข้อเสีย |
|--|--|--|
| **Lazy (per-field on demand)** ⭐ แนะนำ | • Best UX, startup เร็ว<br>• Memoize ภายใน session | • Logic ซับซ้อนเล็กน้อย |
| ทุกหน้า upfront | • Search ครบ | • Slow startup, memory เยอะ |
| เฉพาะหน้าที่ AI บอก | • Fast | • AI ระบุผิด = พลาดทั้งหมด |

**→ Recommend: Lazy with expansion**
- Extract page ที่ AI บอกก่อน
- Search fail → expand ±1 page
- ยัง fail → full document scan
- Memoize ทุก page extracted

---

## 3. Pipeline Implementation Detail

### 3.1 Module structure
```
src/lib/highlight-pipeline/
  ├─ index.ts                 — entry point + orchestration
  ├─ textLayer.ts             — pdf.js text extraction + cache
  ├─ validators.ts            — bbox validation logic
  ├─ search.ts                — text search (exact + fuzzy)
  ├─ tableInference.ts        — table grid heuristic
  ├─ postprocess.ts           — dedupe, group, confidence
  ├─ types.ts                 — shared types
  └─ telemetry.ts             — pipeline decision logging
```

### 3.2 Entry point signature
```ts
// Pure function — takes input from existing code, returns enriched output
function runHighlightPipeline(
    rawHighlights: CompareHighlight[],   // current `highlights` prop
    fields: CompareField[],              // result.fields
    textLayers: PageTextLayer[],         // extracted from pdf.js
    options: PipelineOptions,
): EnrichedHighlight[] {
    // 1. Per highlight box: validate → keep / discard / fall through
    // 2. Per discarded box: try search step
    // 3. Per missing table cell: try table inference
    // 4. Post-process: dedupe + group + confidence label
    // 5. Telemetry
    // 6. Return enriched array with confidence levels
}
```

### 3.3 Output extension (backward compatible)
```ts
// Existing
interface HighlightBox { x, y, width, height, confidence, page, _isDiff }

// Enriched (add fields, never remove)
interface EnrichedHighlightBox extends HighlightBox {
    confidenceLevel: "high" | "medium" | "low";
    sourceStep: "ai-validated" | "text-search" | "table-infer" | "fallback";
    debugInfo?: { matchedText: string; aiClaim: string; };
}
```
→ DocumentPreviewWithHighlights render layer ใช้ `confidenceLevel` ใหม่เลือก visual style. ถ้าไม่มี = render เหมือนเดิม.

---

## 4. Implementation Phases (Rollback-safe)

แต่ละ phase **deploy ได้อิสระ + rollback ได้ผ่าน flag**

### Phase 1 — Foundation (Low Risk)
**Goal:** Setup ไม่ทำงานจริง แค่เตรียมพร้อม

| Task | ไฟล์ | Risk |
|--|--|--|
| 1.1 สร้าง featureFlags ใหม่ทั้งหมด (default OFF) | featureFlags.ts | None |
| 1.2 สร้าง module structure (empty files) | highlight-pipeline/* | None |
| 1.3 สร้าง `extractTextLayer` ใช้ pdf.js | textLayer.ts | Low — pure function |
| 1.4 ทดสอบ extract → console.log → verify | DocumentPreviewWithHighlights (dev only) | None — gated by flag |

**Deploy:** เปิด flag `ENABLE_TEXT_LAYER_EXTRACTION=true` เฉพาะ dev → log to console → verify ทำงาน
**Rollback:** flag OFF → ไม่มี code path ใหม่รัน

---

### Phase 2 — Validation (Step 1 + 2)
**Goal:** เปิด bbox validation + text search

| Task | ไฟล์ | Risk |
|--|--|--|
| 2.1 Validator: normalize + exact + Levenshtein | validators.ts | Low |
| 2.2 Search: substring + fuzzy fallback | search.ts | Low |
| 2.3 Pipeline orchestrator | index.ts | Med |
| 2.4 Integrate ใน DocumentPreviewWithHighlights — guarded by flag | CompareWorkspace.tsx | Med |
| 2.5 Telemetry logging | telemetry.ts | None |

**Deploy:** เปิด flag กับ test user → 1 สัปดาห์ → ดู telemetry
**Verify:** Debug mode `?compareDebug=1` แสดง before/after
**Rollback:** flag OFF → ของเดิม

---

### Phase 3 — Table Inference (Step 3)
**Goal:** เติม highlight สำหรับ table cells ที่ AI ลืม

| Task | ไฟล์ | Risk |
|--|--|--|
| 3.1 Table detection heuristic | tableInference.ts | Med |
| 3.2 Grid builder | tableInference.ts | Med |
| 3.3 Cell lookup → bbox | tableInference.ts | Low |
| 3.4 Integrate ใน pipeline | index.ts | Low |

**Deploy:** flag separate `ENABLE_TABLE_INFERENCE`
**Verify:** Eval ชุดทดสอบ table-heavy documents
**Rollback:** flag OFF → table หยุดที่ existing fallback

---

### Phase 4 — Post-process + UI (Polish)
**Goal:** De-dupe + group + visual hierarchy + match-hidden default

| Task | ไฟล์ | Risk |
|--|--|--|
| 4.1 IoU-based dedupe | postprocess.ts | Low |
| 4.2 Grouping algorithm | postprocess.ts | Low |
| 4.3 Confidence visual mapping | CompareWorkspace.tsx (render layer) | Low |
| 4.4 เปลี่ยน default showOnlyDiff = true | CompareWorkspace.tsx | Low |
| 4.5 First-time tooltip "Showing diffs only..." | i18n + CompareWorkspace | None |

**Deploy:** flag separate `ENABLE_HIGHLIGHT_POSTPROCESS`
**Rollback:** flag OFF → render เหมือนเดิม

---

### Phase 5 — Testing + Tuning + Rollout
**Goal:** Production-ready

| Task | Risk |
|--|--|
| 5.1 สร้าง eval set: 10-20 PDF + ground truth | None |
| 5.2 Run pipeline กับ eval, measure precision/recall ต่อ step | None |
| 5.3 Tune thresholds (Levenshtein, IoU, etc.) | None |
| 5.4 Cross-browser test (Chrome, Safari, Firefox) | None |
| 5.5 Mobile test (text layer extraction performance) | Med — มือถือช้า |
| 5.6 Rollout: 10% → 50% → 100% via gradual flag | None |

---

## 5. Test Plan (Rollback-safe verification)

### 5.1 Eval set
สร้างไฟล์ `tests/highlight-pipeline-fixtures/`:
- `clean-table.pdf` — table ที่ AI highlight ตรง
- `table-missing-bbox.pdf` — table ที่ AI ลืม bbox cell
- `wrong-bbox.pdf` — AI bbox ผิดที่ (manual annotate)
- `scanned-doc.pdf` — scanned PDF (no text layer)
- `multi-page-spread.pdf` — field กระจายหลายหน้า
- ground-truth JSON ระบุ bbox ที่ถูก

### 5.2 Metrics ที่ track
| Metric | Target |
|--|--|
| **Precision** (no false positive) | > 95% |
| **Recall** (no miss) | > 80% |
| **Table cell coverage** | > 70% |
| **Match field noise reduction** | -90% (vs current ALL mode) |
| **Latency** (text layer extraction per page) | < 200ms |

### 5.3 A/B comparison ใน production
- `?compareDebug=1` toggle:
  - Render bbox เก่า เป็นสีฟ้า + dashed
  - Render bbox ใหม่ เป็นสีแดง/เขียว (production style)
  - Side-by-side ดู diff
- ทดสอบ N case แล้ว disable

### 5.4 Regression checklist (ก่อน deploy)
- [ ] All flags OFF → behavior identical to current main
- [ ] Master flag ON + all sub-flags OFF → fall back to current
- [ ] Pipeline error → catch, fall back to current, log
- [ ] Scanned PDF (no text layer) → use current path (text layer extract returns empty)
- [ ] Excel preview → pipeline skip (no bbox)
- [ ] Existing showOnlyDiff toggle → still works
- [ ] Existing box/underline toggle → still works
- [ ] Save PNG → captures new highlights correctly

---

## 6. Rollback Plan

### Levels of rollback (จาก เร็วสุด ถึง ช้าสุด)

**L1: Feature flag OFF (instant — 1 deploy)**
- Master flag → OFF
- ทุก code path ใหม่ skip
- Production ใช้ของเดิม 100%
- Time: 5-10 นาที deploy

**L2: Sub-flag OFF (instant — 1 deploy)**
- ปิดเฉพาะ step ที่มีปัญหา (เช่น table inference)
- เหลือ steps อื่นรันต่อ
- Time: 5-10 นาที deploy

**L3: Git revert (single commit revert)**
- Pipeline ทำ append-only changes → revert ปลอดภัย
- ไฟล์ทั้งหมดอยู่ใน highlight-pipeline/ + flag → revert clean
- Time: 5-15 นาที (test + deploy)

**L4: Branch revert (worst case)**
- ถ้าหลาย phase merge แล้ว มีปัญหา cross-phase
- Revert ทีละ phase (สามารถ Phase 4 → 3 → 2 → 1 ได้)
- Time: 30-60 นาที ต่อ phase

---

## 7. Open Decisions ที่ต้องตัดสินก่อนลุย

| # | คำถาม | คำตอบที่แนะนำ |
|--|--|--|
| **D1** | Client vs server pipeline | **Client** |
| **D2** | Cache text layer strategy | **In-memory Map** |
| **D3** | Validation threshold | **Normalized exact + Levenshtein** |
| **D4** | Confidence levels | **3 levels** |
| **D5** | Match field default | **Hidden (DIFF only)** |
| **D6** | Table detection | **Heuristic only** |
| **D7** | Search algorithm | **Normalized exact + fuzzy fallback** |
| **D8** | Multi-page handling | **Lazy on demand** |

---

## 8. Effort Estimate

| Phase | Best | Worst | Risk |
|--|--|--|--|
| 1. Foundation | 1 วัน | 2 วัน | Low |
| 2. Validation (Step 1+2) | 2 วัน | 4 วัน | Med |
| 3. Table inference | 2 วัน | 4 วัน | Med-High |
| 4. Post-process + UI | 1 วัน | 2 วัน | Low |
| 5. Test + tune + rollout | 2 วัน | 4 วัน | Low-Med |
| **Total** | **8 วัน** | **16 วัน** | |

---

## 9. ความเสี่ยงเฉพาะ — Risk Register

| Risk | Likelihood | Impact | Mitigation |
|--|--|--|--|
| pdf.js text extraction performance ช้าบน mobile | Med | Med | Web Worker offload; lazy load; skip mobile if needed |
| Text layer ไม่มีในบาง text PDF (encrypted/scanned hybrid) | High | Low | Detect → fall back to current path |
| Table heuristic fail on complex layouts | Med | Med | Fall back to row-derived scan |
| Fuzzy match สร้าง false positive ใหม่ | Med | High | Strict threshold + telemetry alert |
| Memory bloat จาก cached text layers | Med | Low | LRU eviction; clear on unmount |
| Browser compat (Safari pdf.js bugs) | Low | Med | Test ทุก browser ก่อน rollout |
| Existing AI prompt → ปรับ → กระทบ pipeline | Low | Med | Pipeline ใช้ existing fields, prompt ไม่เปลี่ยน |
| User complain default hidden → call support | Med | Low | First-time tooltip + clear ALL/DIFF toggle |

---

## 10. Out of Scope (จงใจไม่ทำใน plan นี้)

- ❌ ปรับ AI prompt (decision หลัก, scope แยก)
- ❌ Server-side caching
- ❌ Multi-doc (>3) support
- ❌ Excel highlight pipeline (Excel ใช้ cell-based match อยู่แล้ว)
- ❌ Real-time collaborative highlights
- ❌ Edit/correct AI bbox ผ่าน UI

---

## 11. Success Criteria (จะรู้ได้ยังไงว่าสำเร็จ)

| Criteria | Measurement |
|--|--|
| Precision ≥ 95% | Eval set + telemetry |
| Recall ≥ 80% | Eval set |
| Table coverage ≥ 70% | Eval set table-only subset |
| User self-report "highlight ตรงขึ้น" | Survey/feedback after 2 weeks |
| Zero regression on existing functionality | Regression checklist (§5.4) |
| Latency overhead < 500ms / Compare run | Performance log |

---

## 12. Next Steps

1. **คุย + ตัดสิน D1-D8** (ใช้ recommendation default ก็ได้ ถ้าไม่มีเหตุผลเปลี่ยน)
2. **สร้าง eval set** (§5.1) — บล็อกเดียวที่ pipeline พึ่งพา
3. **Phase 1 start** — Foundation work, ไม่ activate
4. **Phase 2 deploy** ด้วย flag OFF → enable เฉพาะ dev test user
5. **Iterate per phase** — feedback loop กับ telemetry
6. **Production rollout** หลังจาก eval pass threshold

---

## 13. เกี่ยวข้องกับเอกสารอื่น

- [docs/OCR_LIFECYCLE_AND_COMPARE_REWORK_PLAN.md](OCR_LIFECYCLE_AND_COMPARE_REWORK_PLAN.md) — Compare rework (M3) จะ refactor หลัก ของ Compare. Pipeline นี้สามารถ ship ก่อน M3 ได้ และจะ migrate เข้า M3 ภายหลังโดยไม่เปลี่ยน logic
- [docs/170626/RULEBASE_FEATURE_SPEC.md](170626/RULEBASE_FEATURE_SPEC.md) — Phase 6 rulebase อาจใช้ confidence levels จาก pipeline นี้
- [docs/PDF_EDIT_FEATURE_DISCUSSION.md](PDF_EDIT_FEATURE_DISCUSSION.md) — PDF edit จะใช้ bbox ที่แม่นจาก pipeline นี้
