# OCR Testing Log — Session 2026-07-02

บันทึกการทดสอบ OCR + Compare ที่ user ทดสอบและปัญหาที่พบระหว่าง iteration ของ session นี้
เอกสารทดสอบหลัก: ใบวัสดุจากการเบิกเพื่อโอนย้าย (สภากาชาดไทย) — เอกสาร Thai form ผสม text พิมพ์ + text ที่มีตัวอักษรพิเศษ + layout 2 คอลัมน์

---

## 1. ปัญหาที่ user แจ้งเป็นหลัก

### 1.1 AI แก้/ตัดคำเองเมื่อเจอคำภาษาพูด/คำแปลก
- **อาการ**: ตัวอย่าง `Plastelet` → AI เขียนเป็น `Platelet` (drop ตัว `s`), `เจาะ ช็อคบอล 9319` → `ช็อคบอล 9319` (drop `เจาะ`)
- **สาเหตุ**: Gemini semantic prior แข็ง — auto-correct คำที่ดูใกล้ศัพท์ที่รู้จัก
- **สถานะ**: 🟡 Mitigated (ไม่หายขาด)
  - เพิ่ม prompt rule "อ่านทีละตัวอักษรตามที่เห็น"
  - เพิ่ม `corrections[]` array ใน response schema → UI แสดง badge `✎ แก้คำ N` + diff เก่า→ใหม่
  - เพิ่ม field type `raw_text` — บังคับให้ AI คัดลอกเป๊ะ (user เลือกใช้ต่อ field)

### 1.2 ค่านอกกรอบเส้นบรรทัด — AI ไม่ดึงมาด้วย
- **อาการ**: Template มีเส้นสำหรับกรอกค่า แต่ผู้เขียนจริงข้ามลงบรรทัดใต้เส้น → AI ดึงแค่ที่อยู่บนเส้น drop ที่เหลือ
- **สาเหตุ**: Gemini attention diluted บน dense page ทำให้ label boundary ทับซ้อน (crop test พิสูจน์ว่าไม่ใช่ layout parsing bug — model แค่ "มองข้าม")
- **สถานะ**: ✅ **RESOLVED 2026-07-06 via OCR-6** — Crop-based extraction (deploy `5ab63cac`) แก้ครบ, operator confirmed 2 lines correct
- **แนวทางที่ใช้**: ส่ง cropped image ต่อ hinted field เป็น multi-image ใน 1 AI call เพิ่ม → merge policy: crop wins on hinted fields, fallback whole-image เมื่อ crop null (+`crop_miss:true` observability). Path เดียวกันทั้ง single + batch

### 1.3 หน้าเยอะ + หน้าไม่เกี่ยวข้อง → OCR ช้ามาก
- **อาการ**: PDF 10+ หน้า ใช้เวลานาน (multi-minute per file)
- **สาเหตุ**: 
  - Client-side PDF → 3600px PNG stacked เป็น tall image → AI ต้องประมวลผลทุก tile
  - ไม่มีการกรองหน้าที่ไม่มีข้อมูล
- **สถานะ**: ✅ **RESOLVED 2026-07-09** — API-1 + UI-1 ส่งครบ, user-verified. Users เลือกได้เฉพาะหน้าที่ต้องการก่อนรัน OCR (cap 5 หน้า/ครั้ง)
- **สิ่งที่ shipped**:
  - ✅ **API-1** (`pm/reports/API-1.md`) — `/api/upload` + `/api/v1/extract` accept `pages` + `total_pages`, enforce `PAGE_SELECTION_MAX=5` cap ผ่าน `TOO_MANY_PAGES` code, Path A (hints keyed to original page numbers)
  - ✅ **UI-1** (`pm/reports/UI-1.md`, deployed `f9a8effd` + hotfix `8dc025fa` collapse toggle) — thumbnail page-picker, `pdfFileToImageDetailed({ pages })` renders subset, single-file + batch ใช้ selection ร่วมกัน, `errorCodes.TOO_MANY_PAGES` map (th/en)

### 1.4 AI ตีความคำใกล้เคียง → หยิบค่าผิดตำแหน่งมาแทน
- **อาการ**: field "ผู้รับโอน" → AI คืน "คลังกลางหน่วยจัดซื้อและพัสดุ" (จริงๆ เป็นค่าของ "คลังวัสดุ" คอลัมน์ซ้าย)
- **สาเหตุ**: 2 label ในเอกสารขึ้นต้นด้วย "คลัง..." → attention confusion + reading order bias
- **สถานะ**: 🟡 Mitigated
  - เพิ่ม prompt rule "ตัวสะกด label ต้องตรงเป๊ะ, ไม่ใช่ตัวใกล้เคียง"
  - `bbox_hint` (Phase หลักที่เพิ่ง deploy) — spatial anchor ช่วย disambiguate 2-column layout

---

## 2. ปัญหาอื่นที่พบระหว่าง iteration (เพิ่มเติมจากที่ user list)

### 2.1 Multi-line value ถูกตัดเหลือบรรทัดเดียว
- **อาการ**: field "ผู้รับโอน" มี 2 บรรทัด (`คลังภาค... จ.ชลบุรี\nวัตถุดิบและงานระหว่างทำ`) → AI คืนแค่บรรทัดแรก
- **สถานะ**: ✅ Mitigated
  - Prompt: "ถ้าค่ากินหลายบรรทัดใต้ label เดียวกัน ต้องเอาทุกบรรทัด คั่นด้วย \n"
  - UI: auto-switch `<input>` → `<textarea>` เมื่อ value มี `\n`

### 2.2 Prefix dropping (คำนำหน้าถูกตัด)
- **อาการ**: `คลังภาคบริการโลหิตแห่งชาติที่ 7 จ.อุบลราชธานี` → AI คืน `ภาคบริการโลหิตแห่งชาติที่ 7 จ.อุบลราชธานี` (drop "คลัง")
- **สาเหตุ**: AI คิดว่า "คลัง" คือ label prefix
- **สถานะ**: 🟡 Mitigated
  - Prompt: "เอาทุกคำในช่อง รวมทั้งคำหน้า/คำท้ายที่ดูไม่เกี่ยว"
  - `raw_text` type

### 2.3 AI cache / ผลเก่าค้างจอ (misdiagnosed)
- **อาการ**: เปลี่ยน field แล้ว result ยังแสดง field เก่า
- **สาเหตุจริง**: Frontend ไม่ reset result state เมื่อ `extractFields` เปลี่ยน (ไม่ใช่ AI cache)
- **สถานะ**: ✅ Fixed
  - Track `resultFieldsSig` — เมื่อ signature ต่างจากเดิม → clear result

### 2.4 Bulk vs Single-file — คุณภาพต่างกัน (repeated lines in batch)
- **อาการ**: bulk mode ใน row 1 มี `ผู้รับโอน` ซ้ำ 7 บรรทัด, single-file แถวเดียวกันไม่มีปัญหา
- **สาเหตุ**: Single-file แปลง PDF → 3600px PNG ที่ client; batch mode ส่ง PDF ตรงให้ server render (DPI ต่ำ + multi-page conflation)
- **สถานะ**: ✅ Fixed
  - เพิ่ม PDF conversion ใน `runBatchItem` ก่อนอัปโหลด — pipeline เหมือน single-file

### 2.5 Gemini run-to-run variance (แม้ temperature = 0)
- **อาการ**: OCR ไฟล์เดียวกันซ้ำ, บางครั้งได้ค่าถูก บางครั้งผิด
- **สาเหตุ**: Gemini backend routing + key rotation + floating point non-determinism
- **สถานะ**: ⚠️ Known limitation
- **แผน**: 
  - Self-consistency (run 3x + vote) — ยังไม่ทำ
  - Retry button with temperature 0.6 — handler + API ready (OCR-3, 2026-07-09); UI ยัง wait UI-4b (retry ถูก merge เข้า workspace v3 overflow menu). หมายเหตุ: retry mitigates variance ไม่ได้แก้ — same file อาจยัง flake, แค่มีวิธี "ยิงใหม่" ให้ผู้ใช้กด

### 2.6 UI: WRONG button หายหลัง fullscreen mode
- **อาการ**: Compare workspace fullscreen บัง modal
- **สถานะ**: ✅ Fixed
  - Modal เปลี่ยนเป็น right-side panel (440px), z-index 100/101 เหนือ fullscreen

### 2.7 Match fields ตัดข้อความ + ไม่มี WRONG button
- **อาการ**: fields ที่ match ใน Compare แสดง compact + truncate + ไม่มีทางแก้
- **สถานะ**: ✅ Fixed — ทุก field ใช้ full-card layout เดียวกัน + มี WRONG button ทุกช่อง

---

## 3. Fix ที่ deploy ครบแล้วใน session นี้

| Version ID | Change | Purpose |
|-----------|--------|---------|
| `47348b18` | Modal → right-side panel | คงเห็น compare ระหว่างเปิด modal |
| `af1236e6` | Match fields full-card + WRONG button | Rule-able ทุก field |
| `157d21c1` | Prompt v1 (anti-correct + fulltext + no ghost) | ปัญหา 1.1, 1.2, 2.3 |
| `f80239fd` | `corrections[]` schema + UI badge | transparency 1.1 |
| `eb6a8101` | PDF DPI 2400→3600 + client-side convert (OCR) | ปัญหา 1.4, misread |
| `ef909235` | Prompt v2 (no filtering) | 2.2 prefix dropping |
| `f451ce45` | Field type `verbatim` | ปัญหา 1.1, 2.2 |
| `0653ad1b` | Rename `verbatim` → `raw_text` + label matching rule | UX + 1.4 |
| `91b1edcd` | Multi-line prompt + textarea render | 2.1 |
| `19699512` | PDF conversion ใน batch mode | 2.4 |
| `58ead2b3` | Inline batch results table | UX (no export needed) |
| `c71be2eb` | `bbox_hint` — auto capture + manual draw | 1.4 (structural fix) |

---

## 4. ปัญหาที่ยังคงเป็น "unsolved" (สำหรับ prioritize ต่อ)

| # | Issue | ความรุนแรง | แผนที่คุยกันแล้ว |
|---|-------|-----------|------------------|
| 1 | ~~ค่านอกกรอบเส้น (1.2)~~ | ~~High~~ | ✅ **RESOLVED 2026-07-06 via OCR-6** (crop-based extraction, deployed `5ab63cac`) — operator confirmed multi-line `ผู้รับโอน` extracted correctly. See [pm/reports/OCR-6.md](../pm/reports/OCR-6.md) |
| 2 | ~~Multi-page + irrelevant pages ช้ามาก (1.3)~~ | ~~High~~ | ✅ **RESOLVED 2026-07-09 via API-1 + UI-1** (page picker + `pages`/`total_pages`/`TOO_MANY_PAGES` contract, deployed `f9a8effd` + `8dc025fa`). See [pm/reports/API-1.md](../pm/reports/API-1.md) + [pm/reports/UI-1.md](../pm/reports/UI-1.md) |
| 3 | Gemini variance (2.5) | Medium | ✅ **Retry shipped 2026-07-11** — OCR-3 handler `temperature: 0.6` + UI-2 merged into UI-4c/UI-6 overflow menu (kbd R). Self-consistency (3-run vote) ยังไม่เปิด (รอ OCR-2 pass-rate) |
| 4 | OCR Rulebase (per template correction) | High-value | Reuse Compare rulebase infra — ~2 วัน MVP (Phase 7+, ดู `docs/RULEBASE_LEARNING_LOOP_PLAN.md`) |
| 5 | 2-column label confusion (1.4) — ถ้า bbox_hint ยังไม่พอ | Medium | Two-pass extraction (currently on hold — OCR-6 subsumed the observed failure mode) |

---

## 5. Recommendation (สรุปเหลือเฉพาะที่ยัง open)

**Shipped ในสปรินต์นี้ (ไม่ต้องทำต่อ):** OCR-6 crop (1.2), API-1 + UI-1 page picker (1.3), API-2 error codes, API-3 upload guard, UI-3 friendlyError, AI-1 Vertex provider.

**Still open:**
- **OCR-2 regression suite execution** — scaffolded + baseline signed off 2026-07-11, ยังไม่รัน headed baseline (blocked on operator Playwright install + `.env.local` creds). Reuse ใน Sprint 2 S2-1
- **OCR Rulebase** — Phase 7+ (ดู `docs/RULEBASE_LEARNING_LOOP_PLAN.md`)
- **Model tier switching** (Flash → Pro on low-conf) — Phase 7+
- **Two-pass extraction** — on hold, reopen only ถ้า OCR-6 กลับมาไม่พอ

---

_บันทึกโดย: Claude Code session 2026-07-02_
_อัปเดตล่าสุด: 2026-07-11 — sprint-close sync (see §13 below)._

---

## 6. TEST-1 scaffold — 2026-07-06 (qa-tester agent)

Infrastructure สำหรับ control test (แยก multi-page issue ออกจาก bbox_hint mechanism issue) ถูก build แล้ว แต่ **ยังไม่มีการรันจริง**:

- `scripts/split-pdf.mjs` — pdf-lib splitter (ready)
- `scripts/ocr-e2e/{harness,run}.mjs` + `cases/test-1.json` — config-driven Playwright harness ที่ drive UI จริง (login → OCR page → template pick → upload → extract → scrape). ใช้ path client-side PDF→3600px PNG ตามกฎ qa-tester #1
- `pm/reports/TEST-1.md` — fill-in report + interpretation rubric

**Blocked on 3 items** (ดู pm/reports/TEST-1.md §"Needed to complete"): source PDF (ยังไม่ commit, มี PII), Playwright install (~200 MB dev dep — ต้องอนุมัติ), dev-account credentials ใน env vars. เมื่อ operator supply แล้ว จะรัน 3× ต่อเคสตามสเปค แล้วเติมค่าดิบลงตาราง

ยังไม่แก้ diagnosis ของ 2026-07-06 (`ผู้รับโอน` = `ศูนย์บริการโลหิตแห่งชาติ`) จนกว่าจะมีผล TEST-1 จริง

---

## 7. OCR-2 regression suite scaffold — 2026-07-06 (qa-tester agent)

สร้าง regression suite สำหรับ 5 known failure patterns จาก §1 + §2 (verbatim, prefix retention, multi-line join, 2-column disambiguation, corrections[] reporting) — ยังไม่รันจริง เพราะติด blocker ชุดเดียวกับ TEST-1

### Artifacts

- `test_fixtures/regression/{verbatim-plastelet,prefix-retention,multiline-join,column-disambiguation,corrections-recieve}.html` — synthetic form-like fixtures, commit-safe (ไม่มี PII, ไม่ใช่ค่าจริงของลูกค้า)
- `test_fixtures/regression/README.md` — คำอธิบายว่าแต่ละ fixture ทดสอบอะไร + วิธี generate PDF
- `scripts/ocr-regression/generate-fixtures.mjs` — Playwright HTML→PDF renderer (deterministic, ไม่ต้องเพิ่ม dep)
- `scripts/ocr-regression/cases/ocr-2.json` — 5 cases + assertion type ต่อ case
- `scripts/ocr-regression/run.mjs` — CLI runner ที่ reuse TEST-1 harness, apply typed assertions (`verbatim` / `prefix` / `multiline` / `disambiguation` / `corrections_report`), เขียนผลไป `pm/reports/OCR-2-runs/`
- `scripts/ocr-regression/README.md` — วิธีรัน + reconciliation notes
- `scripts/ocr-e2e/harness.mjs` — extend ด้วย `withCorrections` mode (คืน `{ value, corrections }`) — backward-compatible กับ TEST-1
- `pm/reports/OCR-2.md` — fill-in report scaffold + reconciliation choice + summary block "pending execution"

### Reconciliation ที่เลือก

**UI/Playwright harness** (ไม่ใช้ `/api/v1/extract` โดยตรง) เพราะ:
1. reuse harness เดียวกับ TEST-1 → apples-to-apples
2. `multiline-join` fixture เป็น PDF → ต้องผ่าน client 3600px conversion จริง (v1 ข้าม)
3. `corrections[]` badge เป็น UI-rendered artifact — scrape ตรงจาก DOM ชัวร์กว่า
4. v1/extract ไม่มี bbox_hint support (per OCR-4 decision) — path prompt เคยแตกต่างมาก่อน

### เลือกทำ disambiguation แบบ "ไม่มี bbox_hint"

case `column-disambiguation` ใช้ template ที่**ไม่มี** `bbox_hint` บน field `Receiver` — ถ้ามี anchor spatial ให้ AI ก็เดาถูก trivially = ไม่มี signal regression. ต้องการทดสอบ prompt-level disambiguation ล้วนๆ

### Blockers

เหมือน TEST-1: (1) Playwright ยังไม่ install (2) `.env.local` credentials + `OCR_E2E_REGRESSION_TEMPLATE` (3) credit budget ≥ 15 credits บน dev account (5 cases × 3 runs). Suite จะรันได้ทันทีที่ TEST-1 unblock เพราะใช้ prereq เซ็ตเดียวกัน

---

## 8. OCR-6 crop-based extraction — 2026-07-06 (ocr-pipeline agent)

Status: ✅ **Verified in production `5ab63cac`** — operator confirmed doc1 dense-page rerun returns both lines. Issue 1.2 closed (see §1.2, §4 row 1). See `pm/reports/OCR-6.md`.

- Client: crops each hinted field from the same 3600px stacked PNG (proper per-page y translation via new `pdfFileToImageDetailed` + `src/lib/field-crops.ts`).
- Server: one additional multi-image `generateWithAI` call per upload; merges only into hinted fields (`source:"crop"` on hit, `crop_miss:true` on null). Non-hinted fields untouched.
- Metering: crop-call tokens accumulate into the single `logAiUsage` row (one row per user-perceived operation).
- Backward-compatible: uploads without `field_crops` follow the pre-OCR-6 path exactly.
- `npm run build` + `tsc --noEmit` clean.

---

## 9. OCR-6b — landscape + sibling-label follow-up (2026-07-07, ocr-pipeline agent)

Status: ✅ **Verified in production `b1478f1c`** — operator confirmed crop prompt now carries the whole-image rules and merge provenance is deterministic. See `pm/reports/OCR-6b.md`.

**Context — NEW case class:** `landscape + sibling labels` (form `ใบโอนย้ายสินทรัพย์ถาวร`). Page 1 landscape, page 2 portrait. Field `ชื่อและรหัสศูนย์รับผิดชอบ` has 3 lines and sits in a row of 3 similar label+value groups. Full-PDF run under OCR-6 returned a BLEND of the adjacent field's value with line 3 dropped AND `รับบริจาค` silently autocorrected to `บริการ` — at confidence 100. Manual whole-image run of the same cropped region → all 3 lines, correct spelling → model capability confirmed; delivery path at fault.

**Root causes (confirmed):**
- Crop mini-prompt was missing the whole-image prompt's critical rules (multi-line join, no-autocorrect + `corrections[]`, anti-borrowing / anti-filtering). The manual test succeeded under the FULL prompt.
- Merge observability gap (documented in `pm/reports/OCR-6.md` line 80): when the crop response omitted the fieldName entirely, `raw_json` recorded NO provenance marker — the whole-image (blended, autocorrected) value looked authoritative.

**Not implicated (verified by code inspection):**
- Rotation / landscape orientation. Both the preview iframe (browser PDF viewer) and pdfjs `getViewport({ scale })` honor `/Rotate` by default; they see the SAME orientation, so hints line up with rasterised pixels. Forcing `rotation: 0` would DESYNC them and silently break all hints on rotated pages — deliberately NOT changed.
- Per-page x normalization. `field-crops.ts` already multiplies by per-page `pr.width`, not the stacked canvas's `max(width)`.

**Issue 1.2 status: NOT re-opened.** The dense `ใบจ่ายวัสดุ` case (OCR-6's original scope) still passes. This is a NEW case class, tracked separately.

**Fixes shipped:**
- Ported multi-line / no-autocorrect / anti-borrowing rules into the crop prompt.
- Tolerant fieldName matching via new shared `normalizeFieldNameKey()` (whitespace collapse + trim + lowercase). Shared client/server.
- Observability invariant: EVERY `field_crops` manifest entry now ends up with exactly one of `source:"crop"` / `crop_miss:true` / `crop_no_match:true` (new). No more silent merge misses.
- Merged `corrections[]` from crop response when non-empty.
- Dev-only `[OCR-6b] crop merge provenance` console.debug (server side) mirrors the client's `[OCR-6] field crops`.
- API-1 follow-up: `buildFieldCrops()` accepts optional `selectedPages`, uses `remapBboxHintPage()`; dropped-page hints skipped silently.

**Regression fixture:** new class documented at `test_fixtures/regression/landscape-sibling-labels/CASE.md` + `scripts/ocr-regression/cases/ocr-6b.json`. Source PDF NOT committed (PII decision pending — operator to decide: redact & commit / R2 fixtures / local only).

**Operator verification step:** rerun the offending doc 3× (accept 2/3 pass), and rerun OCR-2 Case 6 doc1 3× to confirm no regression. Look for `source:"crop"` in `raw_json` on hinted fields as a positive signal; `crop_no_match:true` on a field that clearly should have merged is the trigger to open OCR-6c.

## 10. OCR-6c — hint coordinate space fix (2026-07-07, ocr-pipeline agent)

Status: ✅ **Verified in production `d2b06f19`** + hotfix `597e0e37` (schema-versioned hints via `space: "page"`). Operator confirmed landscape form now extracts correctly and doc1 regression is clean. See `pm/reports/OCR-6c.md`.

Root cause (operator DevTools confirmed the trail OCR-6b flagged as Red Flag #3): the PDF preview used `<iframe src=…#view=FitH>` inside a wrapper with fixed `aspectRatio: "210 / 297"`. A landscape page letterboxes inside the wrapper (black margins top/bottom), but the hint overlay measured mouse fractions against the WRAPPER rect. The saved hint was therefore wrapper-space, while `field-crops.ts` interpreted it as page-space of the pdfjs raster (which has no letterbox). Result: crop lands in an empty margin → model returns null → `crop_miss: true` → silent fallback to the whole-image (blended) value.

Fix (Option 1 — one coordinate space end-to-end):
- `pdfFileToImageDetailed` now also emits per-page PNG blobs (`pagePngs[]`) sliced from the same canvases used for the stacked upload PNG.
- `OCRWorkspace` rasterises PDFs on file select (was: pdf-lib blob split → iframe) and shows each page as an `<img>` at its true rendered aspect ratio. Preview pixels == upload pixels == crop pixels.
- The iframe branch and the fixed `210 / 297` wrapper are gone. Landscape pages render landscape; hints drawn on them are true page-space fractions.
- `prepareUploadWithCrops` reuses the cached raster so PDFs are rasterised exactly once per file (batch items still take their own path — one raster per item).

Migration policy for pre-fix hints: on PDF load we scan `pageRects[]` and any existing template hint whose page is landscape (`width > height`) is silently dropped from `extractFields` and persisted to the template. User sees `ocr.landscapeHintsInvalidated` toast asking them to redraw. Portrait-page hints are unchanged.

Observability: dev-only `[OCR-6c] hint draw` console.debug records the saved fraction plus the resolved page pixel rect (with `isLandscape`). Combined with OCR-6b's `[OCR-6] field crops` and `[OCR-6b] crop merge provenance`, a bad hint is now diagnosable in one console line.

Backward compatibility verified: portrait single-page PDFs (OCR-6 doc1 path) render through the same new `<img>` branch with true aspect ratio — no change to hint coordinates. Non-PDF preview (image, docx-flattened PNG, xlsx) is untouched.

**Operator verification step:** on `TR07246900009- กาชาด 11.pdf`, load the file (expect toast: previous landscape hint invalidated), redraw the hint on `ชื่อและรหัสศูนย์รับผิดชอบ`, rerun. Accept ≥ 2/3 runs returning all 3 lines with correct spelling and `source:"crop"` in `raw_json`. Regression: doc1 (dense ใบจ่าย) rerun 3× — expect 3/3 both lines of `ผู้รับโอน` with no re-invalidation prompt.

---

## 11. Error-UX + upload hardening bundle — 2026-07-09 (backend-api + frontend-ui)

Deployed together as `d8f0a581`.

- **API-2** — `/api/upload`, `/api/status`, `/api/v1/extract` return `{ ok:false, code, error, vars? }` for every failure; no raw `err.message` reaches the client. `fail()` keeps a BC English `error` string for callers not yet on UI-3. Raw AI text on `V1_EXTRACT_PARSE_FAIL` goes to `logSystemEvent`, never the response body. Closes PENDING_ISSUES §H2 + §H4 for OCR routes. See `pm/reports/API-2.md`.
- **API-3** — 20 MB upload cap (`MAX_UPLOAD_SIZE_MB`, env-tunable) enforced BEFORE credit deduction / R2 write / `arrayBuffer()` on both `/api/upload` and `/api/v1/extract`. New `FILE_TOO_LARGE` code (HTTP 413) + `vars: { limit, actual }`. Closes PENDING_ISSUES §F4. See `pm/reports/API-3.md`.
- **UI-3** — `friendlyError()` + `apiError()` helpers with `errors.*` + `errorCodes.*` i18n catalogs (th + en). Zero raw `err.message` in OCRWorkspace / login / register. Closes PENDING_ISSUES §H1 + §H3 for OCR-flow + auth. Compare / admin / documents / billing remain on Phase 7.5. See `pm/reports/UI-3.md`.

## 12. AI-1 — Vertex AI Express-Mode provider + secret hygiene — 2026-07-09 (ocr-pipeline)

Deployed as part of `d8f0a581`. See `pm/reports/AI-1.md`.

- New provider `vertex_ai` in `generateWithAI` dispatch (single `generateContent` endpoint, `x-goog-api-key` header — never in URL). Multi-image path preserved so OCR-6 crops flow through unchanged. Metering logs `provider: "vertex_ai"` with `thoughtsTokenCount` folded into `outputTokens` (mirrors Gemini AI Studio mapping).
- `src/lib/redactSecrets.ts` scrubs `AIza…`, `?key=…`, `x-goog-api-key: …`, `Bearer …` from every `console.error` / provider error surface. Routed through `apiResponse.fail()` and `generateWithAI` warn path.
- Admin `/api/admin/settings` GET returns masked keys (`AIzaXX....XXXX`) for every provider — behaviour was already correct; extending to Vertex was zero-cost. POST recognises the mask marker as "keep existing key". New `/api/admin/settings/test` endpoint takes only `{id}`, loads the key server-side, and returns a code-only success/failure so the browser never touches the plaintext key.
- Admin UI: "Vertex AI (Express)" provider dropdown option + per-config "Test" button.
- Security requirements SEC-1..6 verified via operator-run `/security-review` — cleared. Two follow-ups (credit race + masking UX) mapped to BILL-1.
- **No claim of OCR quality change** — Vertex is a routing option only. The whole-image + crop-pass semantics are unchanged.

---

## 13. Sprint close — OCR Stabilization (2026-07-11)

Sprint deploy pointer: **`a878584d`** (prod). Board archived in `pm/BOARD.md`.

### Issues resolved this sprint

| # | Issue | Resolution | Ref |
|---|---|---|---|
| 1.2 | ค่านอกกรอบเส้น | OCR-6/6b/6c crop pass | §1.2, §8/9/10 |
| 1.3 | Multi-page + irrelevant pages ช้ามาก | API-1 + UI-1 page picker (cap 5) | §1.3 |
| 2.5 (partial) | Gemini variance retry surface | OCR-3 handler `temperature: 0.6` + UI-4c/UI-6 retry overflow | §4 row 3 |
| — | Raw error strings in OCR/auth flow | API-2 coded errors + UI-3 friendlyError | §11 |
| — | Upload bomb (>20 MB) | API-3 `FILE_TOO_LARGE` guard | §11 |
| — | Provider = single vendor | AI-1 Vertex AI Express provider | §12 |
| — | Credit deduction race | BILL-1 `chargeCreditsAtomic()` | `pm/reports/BILL-1.md` |
| — | Workspace legibility (stepper, page picker, hint drawing, fulldoc, quick mode, template picker + delete) | UI-4/4b/4c/6 (v2 workspace flag ON in prod) | `pm/reports/UI-4c.md`, `pm/reports/UI-6.md` |

### Pass-rate note

Formal pass-rate not yet measured — OCR-2 regression suite scaffolded and baseline signed off (see `pm/reports/OCR-2.md`) but headed E2E runs are still blocked on operator Playwright install + dev-account creds. Sprint 2 (S2-1) picks this up as the safety gate before per-page parallel pipeline.

Operator-verified positive signals during sprint:
- doc1 (dense ใบจ่าย) — 3/3 both lines of `ผู้รับโอน` after OCR-6 (`5ab63cac`)
- landscape ใบโอนย้ายสินทรัพย์ถาวร — 3-line `ชื่อและรหัสศูนย์รับผิดชอบ` correct after OCR-6c (`d2b06f19`)
- 7-page bundle now completes within budget with 1-5 selected pages (UI-1 + API-1)

### Behavior deltas locked into `BEHAVIOR_REFERENCE.md`

- OCR workspace v2 flag ON (stepper, page picker, hint drawing toggle, fulldoc mode, template picker + delete, ⚡ Quick mode auto-run)
- Credit model default = `per_page` (1 page = 1 credit), admin-switchable to `field_formula` / `per_file`
- Upload cap 20 MB, page selection cap 5
- Retry: `temperature: 0.6`
- Coded errors on `/api/upload`, `/api/status`, `/api/v1/extract`
- Vertex AI provider available in Admin → API Settings


