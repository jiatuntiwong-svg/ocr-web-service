# UI-4c §3d — Round-4 UAT punchlist (frontend-ui)

Sprint: OCR Stabilization. Flag `ENABLE_OCR_WORKSPACE_V2` ON in prod.
Target: `src/components/OCRWorkspaceV2.tsx`. v1 (`OCRWorkspace.tsx`) untouched.

## What changed

### 1. Mode switch onto the stepper row
- Deleted the standalone header strip that held `ModeSwitch` (was a separate
  row above the stepper in single-mode render).
- `renderStepper()` now uses `display:flex; align-items:center;` and appends a
  `<ModeSwitch>` inside a `marginLeft:auto` right-aligned bucket AFTER the
  6 step chips. Result: `[1→2→3→4→5→6 ................. single|batch]` in one row.
- Batch-mode header is untouched (it hosts `QuickModeToggle` + `ModeSwitch`
  and has no stepper — that's how the operator flips back to single).

### 2. Run-stage waiting panel — 🤖 removed, v1 loading story ported
- Imported `ENABLE_LOADING_STORY` from `@/lib/featureFlags`.
- Added `LOADING_STORY_STEPS` constant (byte-copy of v1 `OCRWorkspace.tsx`
  L45-51: `stepUpload@30 → stepPrepare@50 → stepReading@70 → stepExtract@92
  → stepFormat@100`).
- Rewrote `renderRunPanel()` loading branch: robot glyph deleted, keeps the
  progress bar + percent, then renders the 5-step checklist using the SAME
  className contract as v1 (`docroom-story-step` + `docroom-story-{done|active|pending}`)
  which are already styled in `src/app/globals.css` L229-268.
- Reused v1 i18n keys `ocr.stepUpload / stepPrepare / stepReading / stepExtract /
  stepFormat` (no new keys invented, per spec).

### 3. Field-type control — all 8 restored + custom dropdown
- Replaced the native `<select>` in the field composer with a new
  `FieldTypeDropdown` component (bottom of file, near `ModeSwitch`).
  - Rounded 10px trigger button showing color dot + Thai/EN label + custom
    chevron (▾ that rotates 180° on open).
  - Panel menu below with hover states and ✓ marker on the active row.
  - Click-outside + Escape to close; ARIA `listbox`/`option` roles.
  - All 8 types: text, number, currency, date, address, email, table, raw_text.
  - Color dot uses existing `TYPE_COLOR` map at top of file (already
    byte-identical to v1's L87-98) — no color drift.
- **Wire format**: v2 already sends `fields=<name> (<type>)` for `type !== "text"`
  at `runExtract` line ~587 (was OCRWorkspaceV2.tsx L539 before the loading-story
  insert). This mirrors v1 L903/980 exactly. No change needed — verified.
- **`type === "table"` → CreditConfirmDialog T3**: already wired in
  `requestExtract` via `hasTableField: extractFields.some(f => f.type === "table")`
  — the T3 branch fires as soon as any field has table type. Verified in code.
- **Template round-trip**: `applyTemplate` sets `extractFields` from
  `JSON.parse(tpl.fields_json)`; `updateActiveTemplate` and `saveAsNewTemplate`
  send `fields: extractFields` (full object incl. type). Type survives.

### 4. i18n
- Added `ocr.v2.fields.type.{text,number,currency,date,address,email,table,raw_text}`
  to both `src/lib/i18n/locales/th.ts` and `en.ts`. TH labels are common
  translations (ข้อความ / ตัวเลข / จำนวนเงิน / วันที่ / ที่อยู่ / อีเมล / ตาราง / ข้อความดิบ);
  EN capitalises `Raw text`.
- Loading-story keys reuse v1's `ocr.stepXxx` — no additions needed.

## Files touched
- `src/components/OCRWorkspaceV2.tsx`
- `src/lib/i18n/locales/th.ts`
- `src/lib/i18n/locales/en.ts`
- `pm/reports/UI-4c-3d.md` (new)
- `pm/BOARD.md` (UI-4c §3d → 👀 review)

## Verify
- `npx tsc --noEmit` → exit 0, no output.
- `npm run build` → clean, **43 routes generated** (matches spec).
- `git diff --stat src/components/OCRWorkspace.tsx` between session start and
  end: no session-authored changes (file was pre-modified from the prior
  UI-4b/4c work per the initial `git status`).
- Manual: all 8 types render in the dropdown, active row has ✓, template-load
  path preserves `type` via `JSON.parse(tpl.fields_json)` → `setExtractFields`.

## Red flags / follow-ups
- None on §3d itself. However worth noting for the next agent:
  - The batch-mode top bar still has its own header row (necessary — batch
    renders v1 verbatim which has no stepper). If someone re-visits that path
    they may want to move `QuickModeToggle` into the app TopBar for
    consistency, but that's UI-6 territory, not §3d.
  - `FieldTypeDropdown` uses inline styles + local `useState` for open/hover
    like the rest of the file. If we later extract a design-token dropdown
    primitive, this and `ModeSwitch` are the two natural first callers.
