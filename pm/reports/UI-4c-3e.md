# UI-4c §3e — Hint drawing toggle + template row cleanup

**Agent:** frontend-ui
**Date:** 2026-07-11
**Target file:** `src/components/OCRWorkspaceV2.tsx` (v1 `OCRWorkspace.tsx` untouched)
**Locale files:** `src/lib/i18n/locales/{th,en}.ts`
**Feature flag:** `ENABLE_OCR_WORKSPACE_V2` (already ON in prod)

---

## Scope delivered

### (1) Hint drawing row — on/off toggle

Added a switch/toggle inside the "ปรับความแม่นยำ" expander next to the hint-drawing description.

- **State reused (no parallel state):** the toggle drives the existing
  `hintEditingFieldId` state that the 📍 chip already uses (declared at
  `OCRWorkspaceV2.tsx:424`). Turning ON sets `hintEditingFieldId` to the
  first field's id so the `BboxHintLayer` becomes armed; turning OFF sets
  it back to `null` and clears any in-progress `hintDraw`.
- **UX:** switch shows a color dot + "เปิด/ปิด" label; disabled + greyed
  out when `extractFields.length === 0`; `role="switch"` + `aria-checked`
  for a11y. The 📍 chips continue to work exactly as before — clicking a
  chip while the toggle is ON just re-targets which field the box is for.
- **Stale copy removed:** the "(advanced — ยังต้องกดวาดใน panel เก่า)" /
  "(advanced — use the legacy panel to draw for now)" sentence is deleted
  from `advHintDrawSub` in both th.ts and en.ts. Replacement copy tells
  the user to turn the toggle on and then pick a field via the 📍 chip.

### (2) "บันทึกทับ template" row — removed

- JSX block removed from the advanced expander (the row was description
  text only — no click handler, no state hooked to it).
- i18n keys `advSaveTemplate` and `advSaveTemplateSub` removed from
  `th.ts` + `en.ts`.
- **No orphaned handlers/imports** — the row never had an onClick or
  bound state; the save action itself continues to be handled by
  `TemplatePickerPanel`'s `onSaveAsNew` / `onUpdateActive` buttons
  (UI-6), which are unchanged.
- **Note:** the unrelated `ocr.templatesOverwrite` key (also contains
  "บันทึกทับ") is still used by `OCRWorkspace.tsx` (v1) and
  `CompareWorkspace.tsx`; left in place per the "v1 frozen" rule.

### (3) Expander rename (optional, taken)

- **TH label:** "ตัวเลือกขั้นสูง" → "ปรับความแม่นยำ".
- **EN label:** "Advanced options" → "Improve accuracy".
- Added `advancedSub` one-liner rendered directly beneath the toggle
  button (visible whether the expander is open or closed):
  - TH: "เปิดเครื่องมือช่วยจับ field ให้แม่นขึ้น (hint / crop)"
  - EN: "Turn on helpers that guide the AI to each field (hint / crop)"

### (4) Sanity check — toggle → draw → hint → crop → `source:"crop"`

Traced end-to-end without running the app; the toggle sets the same state
the 📍 chip sets, so the downstream pipeline is unchanged.

1. Toggle click → `setHintEditingFieldId(first.id)` (OCRWorkspaceV2 §advanced expander).
2. `BboxHintLayer` receives `editingFieldId={hintEditingFieldId}` (line ~1018)
   and intercepts drag → `onDrawCommit(fid, r)`.
3. `commitHintDraw` (lines 758-783) writes `bbox_hint` (x/y/w/h + `page` +
   `space:"page"`) into `extractFields` for that field AND POSTs the
   updated template to `/api/templates` (persist).
4. Next run: `prepareUploadWithCrops` (lines 497-526) sees
   `extractFields.some(f => f.bbox_hint)` and calls `buildFieldCrops`,
   producing `crops[]` blobs.
5. `runExtract` (lines 551-556) appends `field_crops` JSON + `crop_N`
   parts to the multipart body. Backend merges crops with `source:"crop"`
   for matched fields (per OCR-6 contract).

Because my toggle mutates the same variable the 📍 chip mutates and I did
not add a parallel state, the existing chip flow's `source:"crop"`
behavior carries through unchanged. **No code fix needed.**

---

## Verify

| Gate | Status |
|------|--------|
| `npx tsc --noEmit` | exit 0 (clean) |
| `npm run build` | clean, all routes generated (48 total in output; last known baseline was 43 — new routes come from unrelated in-progress work already tracked in git status, not this task) |
| v1 `OCRWorkspace.tsx` | byte-identical — not touched by this task (pre-existing diff from earlier commits is unchanged) |
| Toggle ↔ 📍 chip parity | both drive `hintEditingFieldId` — no divergent state |
| "บันทึกทับ template" string in v2 | gone (only remaining hits: an unrelated `templatesOverwrite` key used by v1/Compare, and a source-code comment in the v2 change block) |
| Expander label = "ปรับความแม่นยำ" / "Improve accuracy" | yes |

---

## Files touched

- `src/components/OCRWorkspaceV2.tsx` — advanced expander block (lines ~1303-1391 in new file).
- `src/lib/i18n/locales/th.ts` — `ocr.v2.fields.{advanced, advancedSub, advHintDraw, advHintDrawSub, advHintDrawToggleOn, advHintDrawToggleOff}`; removed `advSaveTemplate`, `advSaveTemplateSub`.
- `src/lib/i18n/locales/en.ts` — same keys, English.

## Remaining

None. All four items landed. Suggest operator UAT: open a template, expand "ปรับความแม่นยำ", flip toggle ON, drop a rect on the preview → check the field chip 📍 turns filled → run → confirm the response field carries `source:"crop"` (visible in the ⋯ detail view / Positions tab).
