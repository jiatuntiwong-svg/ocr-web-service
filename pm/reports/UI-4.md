# UI-4 — OCR workspace decluttering (mockup)

**Status:** review · **Deliverable:** `pm/reports/UI-4-mockup.html` (self-contained HTML, dark-first with light `prefers-color-scheme` fallback).

## What the mockup shows

Three stacked states inside a simulated app frame, all using tokens copied from `src/app/globals.css` (`--color-bg-*`, `--color-accent` cyan `#06b6d4`, Noto Sans Thai). Above the app frame: a Thai-language intro section explaining the 5 design principles. Below: 6 implementation notes ("หมายเหตุการ implement") for UI-4b.

1. **Initial upload state** — dropzone dominates the left zone; right panel = "Getting started" tips (single vs batch, supported files, "what happens" checklist). Stepper shows stage 1 current.
2. **Multi-page + fields configured (Run stage)** — mock ใบจ่ายวัสดุ page with a red dashed `📍 ผู้รับโอน` hint pin overlay; page picker in expanded form BELOW preview (2/3 pages selected). Right panel = template pill + collapsed field chip row + credit estimate (10 credits) + "จะทำอะไรบ้าง" checklist + Extract CTA + collapsed "ตัวเลือกขั้นสูง" expander. **One field chip in the row is rendered in its `is-hovered` state** with a mini-toolbar revealing `📍 วาด hint`, `● raw_text`, `✎ rename`. A sub-state 2b shows the same right-panel at the "Fields" stage with the advanced expander OPEN so reviewer can see what lives inside (Batch mode toggle, Hint drawing toggle, Field type dropdown, "บันทึกทับ template").
3. **Results state** — 7 fields in the compact row layout: verbatim (98%), multi-line address (raw_text, 92%), ผู้รับโอน with an OPEN overflow menu revealing "แจ้งว่าผิด · ดูรายละเอียด · รันเฉพาะฟิลด์นี้ใหม่ · คัดลอกค่า" and a `✎ corr · Plastelet→Platelet` badge, วันที่ with a purple `💡 RULE` badge (preview of Rulebase feature), low-conf ผู้โอน (54% red chip), mid-conf count (76%), and a raw_text multi-line items field. Right-panel header has "รันใหม่ทั้งหมด" + OPEN export dropdown (Excel/CSV/snapshot).

## Biggest visual/UX shift from today

Today `OCRWorkspace.tsx` renders every panel simultaneously — template sidebar, field chip composer, hint drawing overlay, preview, page picker, batch panel, credit estimate, extract CTA, result table, and export buttons all fight for real estate. The mockup replaces this with **one right panel whose content changes by stage**, driven by a top stepper (อัปโหลด → เลือกหน้า → ฟิลด์ → รัน → ผล → export). This lets each stage show ~2-3 cards instead of ~7 panels, and turns the left zone into a dedicated preview zone that scales up.

## What moved into "advanced" / contextual reveal

Currently visible-by-default tools that are now hidden until requested:
- **Hint drawing toggle** → advanced expander in Fields stage + per-field hover on chip (`📍 วาด hint`).
- **`raw_text` field type toggle** → per-chip hover mini-toolbar + field-type dropdown in advanced expander.
- **Batch mode** → promoted to a top-level mode switch in the topbar (ไฟล์เดียว / หลายไฟล์); its options otherwise live in advanced expander.
- **Corrections / rules / source detail views + retry-single-field + report-wrong** → per-row overflow menu `⋯`. Confidence chip and 1-2 badges stay inline; the rest are one click away.
- **Rename / delete field** → per-chip hover toolbar (rename) + existing `×` for delete.

## Red flags for the implementer (UI-4b)

1. **Hint overlay coordinate math is fragile** — OCR-6c just fixed landscape drift. Do not remount the overlay when switching stages; keep it in DOM and just toggle `pointer-events`/opacity, otherwise pins will de-align.
2. **Batch is a mode not a stage** — flipping the topbar switch must re-layout both zones + relabel stepper (เลือกหน้า → เลือกไฟล์). Decide whether to share right-panel cards or fork.
3. **Error state through the stepper** — mockup does not draw it. Recommendation embedded in the file: upload-fail = stage 1 red + friendlyError, run-fail = stay at stage 4 with Retry (waits on UI-2/UI-3), partial-success = advance to stage 5 with warning chip.
4. **State refactor needed** — must add `currentStage` to `OCRWorkspace.tsx` state + auto-advance rules + click-back rules on the stepper. This is the biggest hidden cost of the ticket.
5. **Migration flag required** — recommend `featureFlags.ocrWorkspaceV2`, ship OFF in prod, operator validates in preview first. Do NOT delete the old layout code in the same PR.
6. **`💡 RULE` badge is aspirational** — Rulebase (RULEBASE_LEARNING_LOOP_PLAN.md) is not implemented; UI-4b should only reserve visual space, not wire the badge to any live data.

## Deliverables produced

- `pm/reports/UI-4-mockup.html` — the mockup.
- `pm/reports/UI-4.md` — this text index.
- `pm/BOARD.md` — UI-4 → review.

No `src/`, i18n, or component files were touched.
