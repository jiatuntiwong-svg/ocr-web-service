# Work orders — frontend-ui agent

Sprint: OCR Stabilization. Update pm/BOARD.md status when you start/finish a task. Write findings to pm/reports/<ID>.md.

---

## UI-1 (P0) — Page selection before OCR *(blocked by API-1)*

**Context:** Issue 1.3: multi-page PDFs are slow and users can't exclude irrelevant pages. Backend adds `pages: number[]` support (API-1).

**⚠️ Read `pm/reports/API-1.md` first** — the API contract (`pages` JSON + `total_pages` multipart parts, `TOO_MANY_PAGES` error with `{limit, actual}`) and §Follow-ups list your exact client-side changes: extend `pdfFileToImageDetailed(opts.pages)`, wire `prepareUploadWithCrops`, add `errorCodes.TOO_MANY_PAGES` to locale files. Coordinate with ocr-pipeline's OCR-6b — both tasks touch `field-crops.ts`/`pdf-to-image.ts`; OCR-6b goes first.

**Do:**
1. In the OCR workspace (`src/components/OCRWorkspace.tsx` / `src/app/(app)/ocr/page.tsx`): when a PDF has > 1 page, show a page-thumbnail picker (pdfjs already renders pages client-side) with select-all/none; default = all pages up to the cap.
2. Show a warning when page count exceeds the cap ("เอกสาร N หน้า — เลือกได้สูงสุด X หน้า").
3. Pass selection through single-file AND batch (`runBatchItem`) paths.
4. All strings via i18n (Thai + English).

**Done when:** 10+ page PDF can run OCR on selected pages only, verified in `npm run preview`. Report in `pm/reports/UI-1.md`.

---

## UI-2 (P1) — Retry button on OCR results *(blocked by OCR-3)*

**Context:** Gemini variance means a bad result may fix itself on re-run. ocr-pipeline is adding a retry mode (temp 0.6).

**Do:**
1. Add "Retry" action on the OCR result panel — calls extract with the retry flag, shows credit cost before running (reuse `CreditConfirmDialog` pattern).
2. Show which result is displayed (attempt 1 / retry) and let the user keep the better one.
3. i18n all strings.

**Done when:** retry works end-to-end in preview. Report in `pm/reports/UI-2.md`.

---

## UI-3 (P1) — friendlyError in OCR flow *(blocked by API-2)*

**Context:** PENDING_ISSUES §H1: `OCRWorkspace.tsx:217` does `setError(err.message || "Upload failed")` — raw internals shown to users. Backend is switching OCR routes to error codes (API-2).

**Do:**
1. Map backend `code` → localized message via `src/lib/friendlyError.ts` + i18n catalog (add `errors.*` keys per PENDING_ISSUES §H3 step 1 — OCR-related keys only this sprint).
2. Replace raw `setError(err.message)` in the OCR flow (OCRWorkspace + login/register are P0 per H1 — include login/register since they're small).
3. Network/401/429 classification per H3 step 4.

**Done when:** no raw error strings reachable in the OCR flow; unknown codes fall back to `errors.generic`. Report in `pm/reports/UI-3.md`.

---

---

## UI-4 (P1) — OCR workspace decluttering — MOCKUP FIRST, no code

**Context:** This sprint added many tools to the OCR page (page picker, hint pins/drawing, corrections badges, retry, export, template picker, batch mode). Operator reports the screen is now crowded and hard to use.

**Deliverable for this task: a mockup ONLY** — single self-contained HTML file at `pm/reports/UI-4-mockup.html` (fake data, no app code changes). PM + operator review before any implementation task is opened.

**Design principles to apply:**
1. **Organize by workflow stage:** อัปโหลด → เลือกหน้า → ตั้งค่า field/template → รัน → ตรวจผล → export. Show only the current stage's tools prominently; previous/next stages collapse into a compact stepper or accordion.
2. **Progressive disclosure:** advanced tools (hint drawing, raw_text type toggle, batch options) live behind a "ตัวเลือกขั้นสูง" expander or contextual reveal (e.g., hint pin appears on field hover), not permanently on screen.
3. **Two stable zones:** document preview (left, maximize space) + a single right panel that CHANGES CONTENT by stage — instead of stacking every panel simultaneously.
4. **Result view declutter:** corrections badge, confidence %, source indicators group into one compact row per field with overflow menu.
5. Keep all existing functionality reachable — nothing removed, only reorganized. Thai + English labels as today.
6. Reference `docs/UX_DESIGN_BRIEF.md` for existing design language; propose within it, not a new visual identity.
7. **Primary reference: `docs/080726/UI_UX_IMPROVEMENT_IDEAS.md`** — apply pattern §1.4 (progressive disclosure: default flow = วางไฟล์ → เลือก template → Extract), §1.1 (single split-pane, right panel เป็นบ้านของทุก secondary tool), §1.3 (page strip). Patterns §1.2 click-sync overlay and keyboard review are Sprint 2 (S2-3/S2-5) — design the layout so they can slot in, but don't mock them in detail.

**Mockup must show:** (a) initial upload state, (b) multi-page + fields configured state, (c) results state — 3 sections in one HTML page is fine.

**Done when:** mockup file presented to operator; collect feedback; PM opens UI-4b (implementation) with the approved layout.

**Approved additions for UI-4b (from operator feedback on v3, 2026-07-08):**
1. **Inline field rename** — double-click chip or ✎ in hover toolbar → chip becomes input → Enter save / Esc cancel. Rename by `f.id` so `bbox_hint`, field type, and template linkage carry over (no delete+recreate). Guard: renaming is allowed only BEFORE extraction; in results stage the edit affordance is disabled with tooltip "รันใหม่หลังเปลี่ยนชื่อ field". Tooltip on the input: ชื่อ field ควรตรงกับ label ในเอกสารเพื่อให้ AI หาเจอ.
2. **Provenance badges (✂ crop / 📍 hint / 🤖 AI) get human tooltips** — e.g. crop = "อ่านจากตำแหน่งที่ระบุ (แม่นยำสูง)"; keep the technical term in the ⋯ detail view only.
3. **Full-document OCR mode (2026-07-08)** — step 3 becomes a 2-card choice: 📋 สกัดตาม Field (default, current flow) vs 📝 อ่านทั้งเอกสาร (plain transcription like generic OCR sites). Full-doc path: skip field config, options = output format (plain text / Markdown), results = per-page text view + copy, export = .txt/.md/.docx (not Excel/CSV), hide hint/overlay tooling entirely. Orthogonal to single/batch (batch transcribe works free). Backend: maps to the `verbatim_transcribe` prompt profile planned in S2-2 (docs/080726/OCR_IMPROVEMENT_TECHNIQUES_KB.md §2) — UI can ship the mode switcher in UI-4b with the profile stubbed to the current prompt + a "ทั้งหน้า" raw_text-style instruction until S2-2 lands. **Open question for PM/operator: credit pricing for full-doc mode (field-count formula doesn't apply — proposal: per selected page).**

---

---

## UI-4b (P1) — Implement OCR workspace v3 ✅ APPROVED 2026-07-09

Mockup v3 (`pm/reports/UI-4-mockup-v3.html`) is final — operator approved, no further changes. Implement EXACTLY this scope behind feature flag `ocrWorkspaceV2` (default OFF in prod):

**In scope (UI-4b):**
1. 6-step stepper + `currentStage` state (auto-advance rules + backward jump only) — per v1 implementation notes
2. Two-zone layout, right panel swaps content per stage; advanced expander (hint drawing, field type, save template)
3. Result tabs: Fields / JSON raw (from raw_json, copy + download) / แก้คำ (corrections diff + ยอมรับ / ใช้ค่าเดิม (client-side value revert) / ดูตำแหน่ง)
4. Overlay controls: 👁 toggle ทั้ง layer + segmented ▢ กรอบ / ▁ เส้นใต้ (reuse Compare highlight styles); overlay stays mounted (OCR-6c lesson — same canvas coordinate space, never remount)
5. Static page strip skeleton (thumbnails + selected state; NO per-page status — that's S2-5)
6. Inline field rename by `f.id` (before-run only) + provenance badge tooltips (per approved additions above)
7. Full-document OCR mode: step 3 two-card choice; transcription path skips fields; output text/Markdown per page + copy; export .txt/.md/.docx; prompt stubbed until S2-2 profile lands; credits = per_page (BILL-1)
7b. Credit estimate copy must read from the ACTIVE credit model (BILL-1 `estimateCredits`): "X หน้า × 1 credit" (per_page) / สูตรเดิม (field_formula) / "1 credit/ไฟล์" (per_file) — i18n th/en (BILL-1 follow-up: CreditConfirmDialog copy review)
8. Step 6 export hub + low-confidence warning before export
8b. **UI-2 merged in:** wire the retry actions in the results overflow menu ("รันเฉพาะฟิลด์นี้ใหม่") + "⟳ รันใหม่" header button to OCR-3's retry mode (temp 0.6) once ocr-pipeline lands it — show credit cost before rerun (reuse CreditConfirmDialog), label which attempt is displayed
9. All strings i18n th/en; error states per v1 notes; keep old layout code intact behind the flag

**Explicitly NOT in scope:** click-sync overlay (S2-5), per-page status in strip (S2-5), keyboard review mode (S2-3), Compare integration (dropped 2026-07-08)

**Done when:** flag ON in preview renders full v3 flow; flag OFF = old workspace byte-identical; `npm run build` clean; report in pm/reports/UI-4b.md

---

## UI-4c (P1) — Flag-ON readiness punch list (from UI-4b red flags, PM-triaged 2026-07-10)

Blockers before `ENABLE_OCR_WORKSPACE_V2` goes ON in prod:
1. **Hint drawing inside v2** — port the draw surface (📍 pin → drag rect) into OCRWorkspaceV2's fields stage. Reuse the same canvas/coordinate code as v1 (OCR-6c invariant: same raster space as upload, overlay never remounts).
2. **Batch access under flag ON** — PM decision: the topbar "หลายไฟล์" switch renders the legacy batch UI in place (v1 component embed or route `/ocr?mode=batch` → v1). No batch redesign.
3. **Operator UAT on preview** — full walk-through: single PDF with hints, multi-page + page select, retry, fulldoc, export, error path (unplug network). Fix layout issues found.

**3a. UAT findings round 1 (operator, 2026-07-10) — fix all three, parity with v1:**
- **Scan-line animation missing** during processing — v1 shows an animated scan line over the preview while OCR runs. Port it to v2's run stage (v1 source: OCRWorkspace scanning effect; mockup class `.scan-hint`).
- **Upload dropzone visual regressed** — operator prefers the OLD upload icon/dropzone look. Reuse v1's dropzone markup/asset in the v2 upload stage instead of the new glyph.
- **Document zoom controls missing** — v1 has zoom in/out/reset + pan (`usePanZoom` hook at src/lib/hooks/usePanZoom.ts). Wire the same hook into v2's preview frame (toolbar − / + / ⟳ buttons exist in the mockup but were not wired). ⚠️ Zoom/pan transforms must NOT break overlay/hint coordinate mapping — transform the container that holds BOTH image and overlay layer together (OCR-6c invariant).

**3b. UAT findings round 2 (operator, 2026-07-10):**
- **🐛 BUG — stage machine deadlock:** results (step 5) → jump back to step 1 → stuck, nothing clickable. Root cause to verify: `canJumpTo` blocks forward jumps "beyond current stage", so once currentStage resets to `upload` every forward step is locked AND the dropzone likely doesn't offer a path forward when a file already exists. Fix: track `maxReachedStage` separately — backward jumps never lower it; forward jumps allowed up to `maxReachedStage`; upload stage with an existing file shows both "ใช้ไฟล์เดิมต่อ →" and re-drop. Add a regression test for: 1→…→5→1→5.
- **JSON tab unreadable in light mode:** syntax colors/background blend together (likely hardcoded dark palette from the mockup). Use theme tokens — dark mode keeps current look; light mode gets a light code background with dark syntax colors. Verify via `useTheme` toggle both modes.

**3c. UAT findings round 3 (operator, 2026-07-10, screenshot):**
- **Remove the in-component credit chip ("999999 credits")** — duplicates the app TopBar's "เครดิต" display. (Overlaps UI-6 item 3 — do it here since UI-4c ships first.)
- **Deduplicate "OCR Workspace" title** — appears in both the app TopBar breadcrumb and the component header. Drop the component-level title row (keep only the mode switch, right-aligned).
- **👁 eye toggle must also hide FIELD HINT boxes** — currently it only governs result-highlight overlays; hint pins/boxes drawn from fields stay visible. Unify: one overlay visibility state controls both layers (hints + highlights), same as the highlight behavior.

**3e. UAT round 5 (operator, 2026-07-11 — scope clarified by operator):**
- **Hint drawing row: add the on/off toggle** per the approved mockup design (row currently shows description text only). Wire the toggle to the existing draw mode (same one the 📍 chip uses). Remove the stale "(advanced — ยังต้องกดวาดใน panel เก่า)" copy.
- **Remove the "บันทึกทับ template" row entirely** — redundant; a dedicated save button already covers it.
- Optional (approved earlier): rename expander to "ปรับความแม่นยำ" + one-line description.
- Quick sanity while in there: confirm the toggle-enabled draw → saved hint → next run shows `source:"crop"` (expected to already work via the chip flow).

**Batch in v2 style** — operator flagged that "หลายไฟล์" opens the legacy workspace. This IS the designed stopgap (UI-4b decision). Full batch redesign inside v2 stepper = separate future task (pending PM/operator priority call), NOT part of UI-4c.

**3d. UAT findings round 4 (operator, 2026-07-10):**
- **Move the mode switch (ไฟล์เดียว/หลายไฟล์) onto the same row as the stepper (steps 1-6)** — right-aligned on the stepper bar; removes the extra header row entirely (continues the title-dedup from §3c).
- **Run-stage waiting panel: remove the 🤖 robot glyph; restore v1's step-by-step progress messaging** — the legacy workspace shows sequential stage updates (เตรียมส่ง AI → อ่านตัวอักษร → จับ field ตามคำสั่ง → จัดรูปแบบผลลัพธ์) tied to actual processing phases. Port that exact mechanism/strings (reuse existing i18n keys from v1 where possible) instead of the static robot + generic progress bar.
- **Field-type control: RESTORE ALL 8 TYPES + restyle.** ⚠️ PM spec error in the v3 mockup reduced types to value/raw_text — v1 actually has 8: `text | number | currency | date | address | email | table | raw_text` (OCRWorkspace.tsx:72) and they are semantically load-bearing: (a) non-text types are sent to the AI as `ชื่อ (type)` in the fields string (v1 L903/980 — v2 must match this wire format exactly), (b) `type === "table"` feeds `hasTableField` → CreditConfirmDialog T3 trigger, (c) type colors/badges per v1 L95-104. v2 must expose all 8 with the same behavior. Control style: custom dropdown matching design tokens (rounded 10px, panel menu, hover states, custom chevron — NOT native `<select>`, NOT segmented since 8 options), showing each type with its v1 color dot + Thai/EN label. Verify template load/save round-trips the type field unchanged.

---

## UI-6 (P1, Sprint 2 — before flag ON) — Template UX overhaul (operator feedback 2026-07-10)

Operator feedback on v2: template selection is hard to scan (no visible common/favorite templates), save/edit semantics are confusing when adding a new template, and the topbar credit chip is unnecessary.

1. **Template picker panel** (replaces pill + "เปลี่ยน" button): search box + three sections — ⭐ รายการโปรด (star toggle per template, persisted in `user_preferences` JSON, NO schema migration), 🕐 ใช้ล่าสุด (last 3, client-tracked in prefs), 📋 Template ระบบ/ทั้งหมด. Star visible on every row.
2. **Explicit save semantics:** two distinct actions — "บันทึกเป็น template ใหม่" (opens name dialog) vs "อัปเดต [current name]" (only enabled when a template is loaded). Dirty indicator "● มีการแก้ไขที่ยังไม่บันทึก" whenever fields diverge from the loaded template; warn on navigate-away/run with unsaved changes (non-blocking toast, not a modal).
3. **Remove credit chip from topbar** — credits remain visible at the run-stage estimate card and Billing page. (Keep the Pro plan chip.)
4. i18n th/en; v2 only (`ENABLE_OCR_WORKSPACE_V2`).

**Sequencing:** do together with or immediately after UI-4c — both are flag-ON prerequisites per operator.

Skip stages that have defaults; target: file-drop → results in one action.

1. Topbar toggle `⚡ Quick` (persist in user prefs via `/api/user-prefs`).
2. When ON, on file arrival: auto-select all pages (≤ `PAGE_SELECTION_MAX`), load `users.default_ocr_template_id`, jump to run and auto-execute. Reuse the v2 stage machine — this is an auto-advance policy, not new stages. Stepper stays visible; backward jumps still work.
3. Confirm dialog: respect the existing smart-confirm rules (CreditConfirmDialog T1–T4 + per-template "don't ask again") — quick mode must NOT bypass credit confirmation triggers.
4. Guards: no default template → one-time picker with "ตั้งเป็นค่าเริ่มต้น" checkbox; pages > cap → stop at pages stage (only unskippable step); works combined with full-doc mode.
5. i18n th/en; only active under `ENABLE_OCR_WORKSPACE_V2`.

**Blocked by:** UI-4c (flag-ON readiness) — build on v2 only, don't backport to v1.

Non-blocking follow-ups (schedule in Sprint 2):
4. Wire "แจ้งว่าผิด" (WRONG) into the correction flow from the v2 overflow menu.
5. `.md`/`.docx` export for fulldoc (needs exportUtils writer) — until then hide the stubbed buttons instead of silently falling back to .txt.
6. Fetch active credit model from server (add to `/api/user-prefs` GET) instead of hardcoded default.

---

---

**Out of scope:** full error-catalog refactor across admin views (Phase 7.5), light-theme polish (F3), page navigator nice-to-have (F1).
