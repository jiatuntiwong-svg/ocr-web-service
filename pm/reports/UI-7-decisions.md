# UI-7 — Batch flow ในสไตล์ v2 — Decision log (locked defaults for implementation)

**Date locked:** 2026-07-14
**Status:** 📋 spec locked → frontend-ui agent implementation ต่อ (👀 review เมื่อ landed)
**Reason:** UI-4b decision 2026-07-08 อนุมัติให้ v1 batch เป็น stopgap; UI-7 = full v2 batch redesign
**Locked baseline:** `pm/reports/OCR-2-runs/_baseline.json` (100% synthetic post `fb169356`) — UI-7 ต้องไม่ทำ regression

---

## 8 locked decisions (recommend + adopt)

### 🏛 Architecture

**D1. Stepper: shared**
- 6-step stepper ใช้กับทั้ง batch — upload N files → pick pages ทีเดียว → template ทีเดียว → run all → results → export
- **Why:** operator setup ครั้งเดียวยิงพร้อมกัน; per-file mini-stepper indicators = complexity ที่ไม่จำเป็น
- **Alt considered:** per-file mini-stepper indicator + shared master flow → over-engineered, ยกไป UI-7b

**D2. Template + fields config: shared สำหรับ v1 UI-7**
- ทุกไฟล์ใช้ template + field list เดียวกัน
- **Why:** v1 batch pattern ก็แบบนี้ (ไม่มี complaint); per-file override เก็บไว้ UI-7b
- **Alt considered:** per-file template override → ไม่เห็น use case จริงจากการใช้ v1 batch

### 📋 Behavior

**D3. Page selection: per-file, default = ทั้งหมด, warn ถ้าเกิน cap**
- แต่ละไฟล์ pick pages ของตัวเอง (default = auto-select up to `PAGE_SELECTION_MAX`)
- ถ้ามีไฟล์ที่หน้า > cap → warn per file (ตาม UI-1 pattern), block ไปต่อจนกว่า user จะเลือก
- **Why:** ไฟล์ในตะกร้าเดียวกันมักมีจำนวนหน้าไม่เท่ากัน; apply-to-all ไม่ตรงกับ real-world use
- **Alt considered:** shared "first N pages" — ไม่ตรงกับความเป็นจริง

**D4. Concurrency: sequential + `--delay-ms`-style pacing**
- ยิง 1 file ทีละไฟล์ (v1 pattern), เพิ่ม small delay ระหว่างไฟล์กัน CF/AI rate limit
- **Why:** เพิ่งเจอ CF/provider rate limit บน benchmark (case 4-5 abort) — batch = worst case
- **Alt considered:** parallel — ยกไปหลัง S2-4 (Per-page parallel pipeline) landed + มี proper backpressure

**D5. Full-doc mode + batch: allowed + explicit credit warning**
- ให้เปิด batch × fulldoc ได้
- CreditConfirmDialog ต้องโชว์ **breakdown ต่อไฟล์** (N files × M pages)
- **Why:** N × M ต่ำสุดพอสมควร — user ต้องเห็นก่อนกด; ห้าม silent charge เยอะ

### 🎨 UX

**D6. Results view: spreadsheet (rows = files, cols = fields)**
- Data-heavy grid — file per row, field per column
- คลิก cell → drawer/inspector ด้านขวาแสดง raw value + confidence + corrections + bbox
- **Why:** matches v1 export use case (Excel export คือ shape นี้); operator mental model ตรง
- **Alt considered:**
  - File list sidebar + card in main → ต้องคลิกเยอะเพื่อเทียบ
  - Tabs per file → พังเมื่อไฟล์เยอะ

**D7. Retry granularity: per file only**
- Retry ทั้ง file เท่านั้น (reuse OCR-3 retry temp 0.6)
- Retry ระดับ field เก็บไปทำใน UI-7b
- **Why:** field-level retry ใน v2 workspace ใช้ overflow menu ที่ single-file mode; batch = simple ก่อน

### 🔀 Backward compat

**D8. Kill v1 batch stopgap เมื่อ UI-7 landed**
- ลบ `?mode=batch` → v1 legacy redirect
- v2 handles batch เต็มรูปแบบ; ถ้าต้อง rollback ก็ flip `ENABLE_OCR_WORKSPACE_V2` OFF → v1 workspace ทั้งชุด (single + batch) กลับมา byte-identical
- **Why:** ไม่ maintain 2 batch UIs; rollback path มีอยู่แล้ว (flag)
- **Rollback plan:** flip flag → v1 กลับมา ทั้ง single-file (OCRWorkspace) และ batch (route redirect หาย = fall through ไป v1 default)

---

## Guardrails สำหรับ implementation

- v1 `OCRWorkspace.tsx` FROZEN — don't touch
- Sequential ยิง = credit charge per file (reuse existing `chargeCreditsAtomic`); ถ้าไฟล์ที่ 5 fail แต่ 1-4 pass = user เสียเครดิตของ 1-4 (accept — matches v1); refund เฉพาะ AI-side fail (API-4b pattern)
- CreditConfirmDialog T1-T4 ต้อง fire บน batch เหมือน single-file (ห้าม bypass)
- All strings via i18n th/en
- baseline benchmark ต้องผ่านหลังเสร็จ (regression gate)

## Open questions (สำหรับ PM ยืนยันก่อน merge)

- **Q1.** Excel export ของ v1 batch มี field แถวสรุปด้านล่าง (avg confidence, total credits) หรือแค่ raw data? — UI-7 export ต้อง match แบบไหน
- **Q2.** Retry all failed ในหน้า results — เก็บไว้ UI-7 หรือดันไป UI-7b?
- **Q3.** ถ้า batch มี file ที่ template hint ไม่ match layout ของบางไฟล์ → warning inline หรือแค่ผลลัพธ์ต่ำ?

---

## References

- Baseline: `pm/reports/OCR-2-runs/_baseline.json`
- v1 batch code (frozen reference): `src/components/OCRWorkspace.tsx` (runBatchItem, batch state)
- v2 workspace: `src/components/OCRWorkspaceV2.tsx`
- Flag: `src/lib/featureFlags.ts` — `ENABLE_OCR_WORKSPACE_V2 = true`
- Related PM decisions: BOARD line 27 (UI-7 backlog), UI-4b decision 2026-07-08 (batch stopgap)
