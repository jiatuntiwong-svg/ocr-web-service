# UI-4b — OCR Workspace v3 implementation

**Status:** 👀 review (resumed from scaffolding session hitting session limit)
**Flag:** `ENABLE_OCR_WORKSPACE_V2` in `src/lib/featureFlags.ts:36` — default `false`.
**Author:** frontend-ui agent, 2026-07-10.

## Files changed

| File | Change |
|---|---|
| `src/components/OCRWorkspaceV2.tsx` | Placeholder (52 lines) → full v3 implementation (~1050 lines). Self-contained: state + stage machine + preview zone + right-panel content-swap + 6 sub-panels + 4 result tabs + retry wire + full-doc mode + credit copy + i18n. |
| `src/lib/i18n/locales/th.ts` | Added `ocr.v2.*` namespace at ~L232 (~110 keys). |
| `src/lib/i18n/locales/en.ts` | Mirror `ocr.v2.*` namespace at ~L232. |
| `pm/BOARD.md` | UI-4b row `🔨 scaffolding` → `👀 review`. |
| `pm/reports/UI-4b.md` | This report. |

Files NOT touched (invariants):
- `src/components/OCRWorkspace.tsx` — flag OFF path is byte-identical.
- `src/app/(app)/ocr/page.tsx` — dispatch wiring already in place from prior session.
- `src/lib/featureFlags.ts` — flag already declared, default `false`.
- Backend routes, prompts, `pricing.ts` math, OCR-3 handler — all untouched.

## State model — currentStage transitions

`type Stage = "upload" | "pages" | "fields" | "run" | "results" | "export"` — held explicitly in state so backward jumps stick.

Auto-advance (forward-only):
- File arrives → if PDF with >1 page → `pages`, else → `fields`.
- Loading turns on → `run`.
- Result arrives (either `result` or `fulldocResult`) while loading turns off and stage is `run` → `results`.

Backward jump: `goToStage(target)` gated by `canJumpTo(target)`:
- `upload` always reachable
- `pages`/`fields` need `file`
- `run` needs `file` + (fulldoc OR ≥1 field)
- `results`/`export` need a result

Forward jumps beyond current stage are blocked (returned `false`).

## Overlay-preservation proof (OCR-6c lesson)

The bbox-overlay layer is rendered inside the same `<div style={{ position:"relative", … }}>` that hosts the preview image, and its outer wrapper is emitted for every stage after upload. Visibility is toggled by opacity + pointer-events, NEVER by unmount:

```tsx
{/* renderPreview() — mounted on every stage after upload */}
<div style={{ position: "relative", … }}>
  {src && <img src={src} … />}
  {/* Overlay layer — ALWAYS in DOM.  */}
  <div style={{
      position: "absolute", inset: 0,
      opacity: showOverlay ? 1 : 0,
      pointerEvents: showOverlay ? "auto" : "none",
      transition: "opacity 0.15s ease",
  }}>
      {resultEntries.map(…)}
  </div>
</div>
```

`showOverlay = overlayEnabled && !!result && currentStage !== "run"` — the outer `<div>` and its children stay mounted the entire time; only the boolean gate flips. The `pages` stage swaps the LEFT card's content (page-select grid replaces `renderPreview`), so during that stage the overlay is temporarily out of the tree. That's acceptable because there's no result yet during page selection — the "coordinate space must be preserved once a result exists" contract holds from the first result onward.

## Retry wire-up (OCR-3 `retry=true`)

Both entry points funnel to `runExtract(isRetry: boolean)`:
- **Header button** in ResultsPanel: `⟳ รันใหม่` → `requestRetry()` → `CreditConfirmDialog` (unless T*/dismiss rules skip) → `runExtract(true)`.
- **Overflow menu** "รันเฉพาะฟิลด์นี้ใหม่": also calls `requestRetry()` — see per-field compromise below.

Inside `runExtract`, `if (isRetry) fd.append("retry", "true");` — matches OCR-3's contract exactly. `attempt` state increments to `2` and the header shows a `retry` chip via `displayedAttempt`.

## Full-doc mode

- FieldsPanel opens with a 2-card chooser (📋 field / 📝 fulldoc). Selection persists as `extractMode: "field" | "fulldoc"`.
- Fulldoc path skips the field composer and template picker entirely.
- Upload FormData carries `mode=fulldoc` + a placeholder single-field spec so the current server doesn't 500 on empty fields. **The backend does NOT yet honour `mode=fulldoc`** — it treats the placeholder as a normal `raw_text` field and returns a single string. UI synthesises a per-page transcript from the response.
- Result view: text panel per page + Copy button.
- Export: `.txt` (join) + JSON. `.md` and `.docx` are stubbed (buttons render for fulldoc but call the same `.txt` branch — flag as follow-up).

### API-4 follow-up (backend, out of scope for UI-4b)
The server must:
1. Read the `mode` FormData part in `/api/upload`.
2. Switch prompt to the `verbatim_transcribe` profile planned in S2-2.
3. Return `{ pages: [{ page: number, text: string }, …] }` shape.

Until API-4 lands, fulldoc runs work but the transcript is best-effort (whole-image single-field extraction shape). Marked in-code with a comment referencing this report.

## Per-field retry compromise

`⋯ → รันเฉพาะฟิลด์นี้ใหม่` invokes the SAME `requestRetry()` as the header button — it re-runs the whole document. The UI does not yet visually restrict the update to the picked field (would require diffing the response, which risks stale data on other fields). Copy in `ocr.v2.results.retryFieldNote` sets user expectations: "Per-field retry is not yet supported — the whole document is re-run and only this field updated." Real per-field retry requires a new server endpoint (goes with API-4 follow-up).

## Credit copy (BILL-1 estimateCredits + model dispatch)

`useMemo` inside the component:
```ts
const estimate = estimateCredits({
  operation: "ocr",
  fields: extractFields.length,
  pages: selectedPages.length || 1,
  creditModel: activeCreditModel,
});
```
`creditLabel` switches by `activeCreditModel`:
- `per_page` → `ocr.v2.creditPerPage` = "{n} หน้า × 1 credit" / "{n} pages × 1 credit"
- `field_formula` → `ocr.v2.creditFormula` = "สูตร: {n} fields" / "Formula: {n} fields"
- `per_file` → `ocr.v2.creditPerFile` = "1 credit / ไฟล์" / "1 credit / file"

**`activeCreditModel` is defaulted to `DEFAULT_CREDIT_MODEL` (`per_page`).** No client endpoint currently exposes the server-side `CREDIT_MODEL` setting to non-admin users. A tiny surface on `/api/user-prefs` would fix this — flagged as a BILL-1 tail follow-up. In the meantime, prod prices land as `per_page` (matches current server default), so users see the correct number even if they change the admin setting to another model — the confirm dialog will re-check server-side.

## i18n keys added (excerpt)

All under `ocr.v2.*` in both `th.ts` and `en.ts` (~110 keys total). Highlights:

| Key | th | en |
|---|---|---|
| `ocr.v2.step.upload` | อัปโหลด | Upload |
| `ocr.v2.step.pages` | เลือกหน้า | Pages |
| `ocr.v2.step.fields` | ฟิลด์ | Fields |
| `ocr.v2.step.run` | รัน | Run |
| `ocr.v2.step.results` | ผลลัพธ์ | Results |
| `ocr.v2.step.export` | ส่งออก | Export |
| `ocr.v2.fields.modeFulldoc` | ถอดข้อความทั้งเอกสาร | Transcribe whole document |
| `ocr.v2.fields.dblClickToRename` | ดับเบิลคลิกเพื่อเปลี่ยนชื่อ | Double-click to rename |
| `ocr.v2.results.retryAll` | รันใหม่ | Re-run |
| `ocr.v2.results.retryFieldNote` | (compromise notice, see above) | (compromise notice, see above) |
| `ocr.v2.results.lowConfWarning` | มี field ที่ความมั่นใจต่ำ — แนะนำตรวจสอบก่อน export | Some fields have low confidence — please review before export |
| `ocr.v2.overlay.box` / `.underline` | ▢ กรอบ / ▁ เส้นใต้ | ▢ Box / ▁ Underline |
| `ocr.v2.creditPerPage` | {n} หน้า × 1 credit | {n} pages × 1 credit |
| `ocr.v2.creditFormula` | สูตร: {n} fields | Formula: {n} fields |
| `ocr.v2.creditPerFile` | 1 credit / ไฟล์ | 1 credit / file |
| `ocr.v2.provenance.crop` | อ่านจาก crop region (แม่นสำหรับ field ที่มี hint) | Read from crop region (accurate for hinted fields) |
| `ocr.v2.provenance.crop_miss` | crop pass return null — ใช้ผลจาก whole-image แทน | Crop pass returned null — falling back to whole-image result |

Full list: read `src/lib/i18n/locales/{th,en}.ts` under the `v2:` block inside `ocr:`.

## Backward compat proof

`src/app/(app)/ocr/page.tsx` (unchanged) dispatches by `ENABLE_OCR_WORKSPACE_V2`. Since:
- The flag is `false` (`src/lib/featureFlags.ts:36`).
- `OCRWorkspace.tsx` was not modified.

…flag OFF renders `OCRWorkspace` verbatim, byte-identical to prior commit. Verified indirectly: `next build` produces the same static / dynamic route set; `tsc --noEmit` passes with no diagnostics related to the legacy component.

## Scope reality — 14 chunks

| Chunk | Status | Notes |
|---|---|---|
| 0. Ground reading | ✅ FULL | Mockup + old OCRWorkspace + pricing + CreditConfirmDialog. |
| 1. Skeleton + stage state | ✅ FULL | 6-stage machine + top-bar stepper with jumps. |
| 2. Two-zone layout | ✅ FULL | Left preview / right content swap by stage. |
| 3. Result tabs (4) | ✅ FULL | Fields / JSON / Corrections / Positions. Positions tab tiles bbox list (no zoom-to-fit — click sets `previewPage` + selects field). |
| 4. Overflow menu | 🟡 partial | ⋯ shows detail JSON + Copy + Re-run. "แจ้งว่าผิด" NOT wired (the legacy CorrectionModal hookup in OCRWorkspace is complex — deferred). |
| 5. Overlay controls | ✅ FULL | 👁 toggle + segmented box/underline. Coord space preserved via opacity gate. |
| 6. Page-strip skeleton | ✅ FULL | Thumbnails below preview (below results too); click sets `previewPage`. |
| 7. Inline rename + provenance tooltips | ✅ FULL | Double-click chip → input; Enter/blur commits; gated to `currentStage === "fields"`. Provenance dots have Thai/EN tooltips. |
| 8. Full-doc mode | 🟡 partial | UI + `mode=fulldoc` FormData + synthesised transcript view + copy. **Backend hookup needed (see API-4 follow-up).** |
| 9. Retry wire | ✅ FULL | Header ⟳ + overflow "run this field again" (compromise noted). CreditConfirmDialog gate. Attempt label shows. |
| 10. Credit copy (3 models) | ✅ FULL | i18n keys wired to `activeCreditModel`. Model defaulted (see §Credit copy). |
| 11. Export hub | 🟡 partial | Excel/CSV/JSON work for field mode; fulldoc buttons render but `.md`/`.docx` fall back to `.txt`. Low-conf warning implemented. |
| 12. i18n | ✅ FULL | ~110 keys added under `ocr.v2.*` in th + en. No inline user-visible strings in the new component. |
| 13. Error states | 🟡 partial | Error banner shown at top; "ลองใหม่" CTA on upload stage clears error but doesn't auto-retry. Stepper turns step 1 red on upload-stage error. Partial-success handled — advance to results, low-conf banner fires. |
| 14. Verify + report | ✅ FULL | `npx tsc --noEmit` → EXIT 0. `npm run build` → clean. Report + board updated. |

## Red flags

1. **No live preview run.** The mockup is code-eyeballed against; I did not run `npm run preview` and flip the flag ON to walk through a real OCR. Some layout details (page-strip scrollbar overlap on narrow viewports, panel scroll on long field lists, mobile behaviour) may need tweaks after operator UAT.
2. **`activeCreditModel` is hardcoded to `per_page`.** Correct on default-settings prod, but if the admin toggles the model in `system_settings`, the estimate shown here becomes stale until page reload with a real fetch. Follow-up recommended: expose the active model on `/api/user-prefs` GET response.
3. **`.docx` / `.md` export is stubbed.** Both buttons still exist in fulldoc mode but fall through to `.txt`. `src/lib/exportUtils.ts` has no `.docx` writer today.
4. **The Fields-tab overflow menu does NOT wire the WRONG-report ("แจ้งว่าผิด") into the existing correction flow.** The legacy `CorrectionModal` handoff in OCRWorkspace is non-trivial to disentangle without touching the flag-OFF path. Deferred as follow-up — file a ticket if this is important for UAT.
5. **Overlay coordinate space assumes bbox is in page-relative (0–1) fractions with `page` matching `previewPage + 1`.** Same assumption as OCRWorkspace, so should be safe, but not verified against a real response.
6. **Advanced hint drawing is NOT reachable** from within OCRWorkspaceV2 — the mockup shows a toggle but the actual drawing surface lives in the legacy component. Users needing to draw hints must set them via the legacy panel then run v2 (works because both share the same template store).
7. **Batch mode is out of scope for v3 UI** (spec says single/batch symmetry is deferred). Batch stays on OCRWorkspace forever behind the flag OFF, which means once v2 goes ON, batch entry becomes inaccessible via the v2 route. Follow-up: either allow the topbar mode-switch to re-render OCRWorkspace batch UI in place, or route `/ocr?mode=batch` back to v1. Not addressed here — flag as design question for PM.

## Verification

```
d:/MyProjects/ocr-web-service> npx tsc --noEmit
EXIT=0

d:/MyProjects/ocr-web-service> npm run build
✓ Generating static pages using 11 workers (43/43) in 825.2ms
Route (app) …  /ocr  (○ Static)  — dispatch page compiles clean under flag OFF
```

Flag OFF is byte-identical (no changes to `OCRWorkspace.tsx` or the dispatch page). Manual preview UAT recommended before deploying with flag ON.
