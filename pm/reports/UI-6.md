# UI-6 — Template UX overhaul + ⚡ Quick mode

Status: 👀 review (v2-only, `ENABLE_OCR_WORKSPACE_V2` flag; v1 untouched)
Verify: `npx tsc --noEmit` = 0, `npm run build` = clean
Deploy: NOT deployed — operator decides.

## Files changed

| File | Lines | What |
|------|-------|------|
| `src/components/OCRWorkspaceV2.tsx` | +~440 | new state block (favorites/recent/quickMode/snapshot/dirty), `applyTemplate`/`saveAsNewTemplate`/`updateActiveTemplate`/`persistDefaultTemplate` helpers, `requestExtract` wrapper (credit-confirm reuse), quick-mode auto-run effect, replaced `<select>` with `TemplatePickerPanel`, added `QuickModeToggle` in topbar, added save-as-new + quick-picker `ModalScrim` dialogs, non-blocking unsaved toast. New sub-components: `QuickModeToggle`, `TemplatePickerPanel`, `ModalScrim` |
| `src/lib/i18n/locales/en.ts` | +33 | `ocr.v2.templatePicker.*` + `ocr.v2.quickMode.*` |
| `src/lib/i18n/locales/th.ts` | +33 | th mirrors |

Backend `/api/user-prefs/route.ts`: **not touched**. Existing PATCH shape `{userId, kind:"ocr", templateId}` reused verbatim for default template.

## Prefs shape (before / after)

Server-side (`user_preferences` row) — **unchanged**:
```json
{
  "default_ocr_template_id": "tpl_123",
  "default_compare_template_id": null,
  "confidence_threshold": 0.7,
  "block_export_low_confidence": 0
}
```

Client-side (per-device, localStorage) — **new keys added**:
```
ocr_v2_favorite_template_ids: string[]      // ⭐
ocr_v2_recent_template_ids: string[] (max 3) // 🕐 MRU
ocr_v2_quick_mode: "0" | "1"                 // ⚡
```

**Why localStorage, not a DB column**: task spec explicitly forbids a schema migration. The `user_preferences` table has no opaque JSON blob column — only typed columns — so a "JSON path" client-extension inside the existing shape is impossible without a migration. localStorage matches operator-scoped device state (like `docroom_skip_confirm_v1` in `credit-preferences.ts`) and lands zero backend risk. See non-blocking follow-up #6 for the eventual server-side move.

## Template picker panel (§A1)

Layout inside `renderFieldsPanel()`, replacing the flat `<select>`:

```
┌ Template ────────────────────── [● unsaved] [Clear] ┐
│ [ search box                                 ]      │
│ ⭐ FAVORITES                                        │
│    ★ Invoice v2         DEFAULT  ✓                  │
│    ★ Purchase order                                 │
│ 🕐 RECENT                                           │
│    ☆ Payslip                                        │
│ 📋 ALL TEMPLATES                                    │
│    ☆ Invoice v1                                     │
│    ★ Invoice v2         DEFAULT                     │
│    ...                                              │
├─────────────────────────────────────────────────────┤
│ [+ Save as new template] [↻ Update Invoice v2]      │
└─────────────────────────────────────────────────────┘
```

- Search filters ALL sections by `name.toLowerCase().includes(query)`.
- Star toggle every row (⭐/☆). Persists to `favoriteTemplateIds` via effect.
- Recent tracking algorithm: `applyTemplate(id)` does
  `setRecentTemplateIds([id, ...prev.filter(x => x !== id)].slice(0, 3))` — MRU promote, dedupe, cap 3.
- `DEFAULT` pill on the row that matches `defaultOcrTemplateId` from `/api/user-prefs`.
- Active template gets accent tint + `✓`.

## Save semantics (§A2)

**Dirty detection**:
```ts
const templateDirty = useMemo(() => {
    if (!activeTemplateId || !loadedTemplateSnapshot) return false;
    return JSON.stringify(extractFields) !== loadedTemplateSnapshot;
}, [activeTemplateId, loadedTemplateSnapshot, extractFields]);
```
`loadedTemplateSnapshot` is captured in `applyTemplate(id)` and cleared in `applyTemplate(null)` / after `updateActiveTemplate` / after `saveAsNewTemplate`.

**Button gating**:
- `+ Save as new template` — always enabled (unless mid-save).
- `↻ Update [name]` — `disabled={!activeTemplateId || savingTemplate}`. When no template loaded, label falls back to a generic "Update template" and tooltip explains why disabled.

**Dirty indicator**: `● มีการแก้ไข` pill (amber, warning tone) appears in the picker head whenever dirty.

**Run-time nag**: `requestExtract(false)` checks `templateDirty` and fires a non-blocking bottom-centered toast `"มีการแก้ไขที่ยังไม่บันทึก - ดำเนินการต่อไหม?"` for 5 s. NOT a hard modal — user is not blocked. (Toast is home-rolled — the codebase has no `Toast`/`useToast` infra; kept minimal and consistent with existing inline `unsavedToast` style.)

## ⚡ Quick mode (§B)

**State persistence**: `quickMode` state → `localStorage["ocr_v2_quick_mode"]`. Restored on mount.

**Topbar toggle**: new `<QuickModeToggle>` sub-component to the LEFT of the existing single/batch `<ModeSwitch>` in both the batch topbar and the single-mode topbar.

**Auto-advance policy — 4 guard branches** (all inside the effect at `useEffect([quickMode, file, pdfRaster, defaultOcrTemplateId, templates, extractMode])`):

1. **pages ≤ cap + default template** →
   - auto-select all pages up to `PAGE_SELECTION_MAX`
   - `applyTemplate(defaultOcrTemplateId)`
   - `setCurrentStage("run")`
   - `setTimeout(() => requestExtract(false), 0)` — same predicate as manual Extract → hits CreditConfirmDialog when T1-T4 fire.
2. **pages > cap** → `setCurrentStage("pages")`, do nothing else. Operator picks manually. (`pages` stage is the only unskippable step per spec.)
3. **no default template** → `setQuickPickerOpen(true)` — one-time modal lists all templates with `☑ ตั้งเป็นค่าเริ่มต้น` checkbox (default checked). On pick, `applyTemplate` + `persistDefaultTemplate` (if checked), re-arm `quickFiredRef`, effect fires the run path on next tick.
4. **fulldoc mode active** → skip templates entirely, jump straight to `run`, auto-fire — matches spec's "fulldoc mode compat".

**Guard `quickFiredRef`** prevents re-firing during the same file session. Reset in `processFile` (new file) and `resetAll` (Next document).

**Credit-confirm reuse — proof**: quick-mode auto-run calls `requestExtract(false)`, defined as:
```ts
const requestExtract = useCallback((isRetry: boolean) => {
    if (!file) return;
    ...
    const fp = makeFingerprint({ operation: "ocr", templateId: activeTemplateId, ... });
    const proceed = () => runExtract(isRetry);
    if (shouldSkipDialog(fp)) { proceed(); return; }
    const ev = evaluateConfirm({
        estimate: estimate.credits, balance,
        hasTableField: extractFields.some(f => f.type === "table"),
    });
    if (!ev.needsConfirm) { proceed(); return; }
    setConfirmDialog({ ... });
}, [...]);
```
Identical predicate chain as `requestRetry` (`shouldSkipDialog` → `evaluateConfirm` T1-T4). `requestRetry` was refactored to `useCallback(() => requestExtract(true), ...)` so both paths share the exact code path.

## Credit chip status

Confirmed removed via UI-4c §3c-1 (commit `5308bf8f`). Only lingering trace is a comment in the topbar block noting the removal — no new removal needed. Grep for `999999` / `credit chip` returned only comment lines.

## i18n keys added

| Key | th | en |
|-----|----|----|
| `ocr.v2.templatePicker.head` | Template | Template |
| `ocr.v2.templatePicker.searchPh` | ค้นหา template... | Search templates... |
| `ocr.v2.templatePicker.favSection` | รายการโปรด | Favorites |
| `ocr.v2.templatePicker.recentSection` | ใช้ล่าสุด | Recent |
| `ocr.v2.templatePicker.allSection` | Template ระบบ/ทั้งหมด | All templates |
| `ocr.v2.templatePicker.favorite` | เพิ่มในรายการโปรด | Add to favorites |
| `ocr.v2.templatePicker.unfavorite` | เอาออกจากรายการโปรด | Remove from favorites |
| `ocr.v2.templatePicker.empty` | ยังไม่มี template — กด "บันทึกเป็น template ใหม่" ด้านล่าง | No templates yet — save fields as a new template below |
| `ocr.v2.templatePicker.default` | ค่าเริ่มต้น | DEFAULT |
| `ocr.v2.templatePicker.dirty` | มีการแก้ไข | unsaved edits |
| `ocr.v2.templatePicker.clear` | ล้าง template | Clear template |
| `ocr.v2.templatePicker.saveAsNew` | บันทึกเป็น template ใหม่ | Save as new template |
| `ocr.v2.templatePicker.updateActive` | อัปเดต {name} | Update {name} |
| `ocr.v2.templatePicker.updateDisabled` | อัปเดต template | Update template |
| `ocr.v2.templatePicker.updateDisabledTip` | โหลด template ก่อน | Load a template first |
| `ocr.v2.templatePicker.saveAsNewTitle` | บันทึก field เป็น template ใหม่ | Save fields as a new template |
| `ocr.v2.templatePicker.newNamePh` | ชื่อ template... | Template name... |
| `ocr.v2.templatePicker.cancel` | ยกเลิก | Cancel |
| `ocr.v2.templatePicker.save` | บันทึก | Save |
| `ocr.v2.templatePicker.unsavedRunToast` | มีการแก้ไขที่ยังไม่บันทึก - ดำเนินการต่อไหม? | You have unsaved template edits — continuing this run |
| `ocr.v2.quickMode.label` | Quick | Quick |
| `ocr.v2.quickMode.on` | เปิด | ON |
| `ocr.v2.quickMode.off` | ปิด | OFF |
| `ocr.v2.quickMode.tooltipOn` | Quick mode เปิดอยู่ — ไฟล์จะรันอัตโนมัติด้วย template เริ่มต้น | Quick mode ON — files auto-run with your default template |
| `ocr.v2.quickMode.tooltipOff` | Quick mode ปิดอยู่ — เลือกหน้า / template / รันเอง | Quick mode OFF — pick pages / template / run manually |
| `ocr.v2.quickMode.pickerTitle` | Quick mode — เลือก template เริ่มต้น | Quick mode — pick a default template |
| `ocr.v2.quickMode.pickerBody` | Quick mode ต้องมี template เริ่มต้นเพื่อรันอัตโนมัติ เลือกจาก template ที่มี: | Quick mode needs a default template to auto-run. Pick one from your library: |
| `ocr.v2.quickMode.setAsDefault` | ตั้งเป็นค่าเริ่มต้น (auto-apply ครั้งถัดไป) | Set as default (auto-apply next time) |

## Backward compat

- `git status --short src/components/OCRWorkspace.tsx` shows the file appears in `M` list only because it was already modified pre-session (unrelated to UI-6). **My edits made no touches to `OCRWorkspace.tsx`.**
- Feature flag `ENABLE_OCR_WORKSPACE_V2` gates V2 selection at `src/app/(app)/ocr/page.tsx` — flag OFF path renders v1 verbatim. Unchanged.
- No route / DB / prompt / migration touched.

## Non-blocking follow-ups (Sprint 2)

Not implemented here per task spec — noted for backlog:

1. **Wire "แจ้งว่าผิด" (WRONG) → v2 overflow menu correction flow.**
2. **`.md` / `.docx` fulldoc export writer** in `exportUtils` — currently `doExport("csv")` in fulldoc mode falls back silently to a `.txt` blob. Hide the stubbed `.md`/`.docx` cards until the writer lands.
3. **Server-side credit-model fetch** — `/api/user-prefs` GET returns active credit model (currently hardcoded `DEFAULT_CREDIT_MODEL`). Same GET call could also serve as the future move for favorites/recent/quickMode off localStorage.

## Regression walkthrough — UI-4c invariants

Un-touched invariants:
- **Hint drawing** — the `BboxHintLayer` and `commitHintDraw` code is not touched. `📍` pin toggle logic still lives in the field chip. The 👁 overlay-visibility gate covers both hint + result layers (UI-4c §3c-3).
- **Stage machine 1→5→1→5** — `currentStage`/`maxReachedStage` split unchanged; `canJumpTo` unchanged. Quick-mode only calls `setCurrentStage("run")` and never lowers the frontier; backward-jump path via `goToStage` intact.
- **Zoom / pan** — `usePanZoom` wiring untouched; the zoomed wrapper still contains both `<img>` and overlay layers as siblings.
- **Unified 👁 toggle** — `overlayEnabled` still governs both the hint-layer opacity/pointer-events AND result-overlay opacity/pointer-events, with a `hintEditingFieldId` escape for active drawing.
- **Batch mode fallback** — `uiMode === "batch"` path still renders `OCRWorkspaceV1` verbatim.

## Red flags

- **Toast infra rolled inline** — codebase has no shared `Toast` component (grep returned zero hits). The unsaved-edits nag uses a local fixed-position `<div>` rather than a shared toaster. Fine for now; consider promoting to a shared toast component when other v2 flows need one.
- **Server-side credit-model still hardcoded** to `DEFAULT_CREDIT_MODEL` — quick mode picks up the *client* estimate, which may drift from the server if admin flips `system_settings.credit_model` between page load and file drop. Same as UI-4b; follow-up #3.
- **Quick-mode empty-template list** — if `templates` array is empty when Quick fires, the effect opens the picker modal with a "no templates" hint. UX may want to instead auto-apply the default 5 in-memory fields and jump to run. Left as: user sees the picker with empty list and can cancel out; picker's Cancel returns them to normal flow.
- **Cannot verify without live preview** — auto-fire timing (`setTimeout 0` after `setCurrentStage("run")`) relies on React batching order. Static reasoning + build passing = green; needs preview UAT for the 4 quick-mode branches (pages > cap, no default, default present, fulldoc). Recommend operator UAT step similar to UI-4c §3a-3c.
- **Save-as-new POST assumes v1 API shape** — reused `{userId, name, fields, id?}` payload consistent with `commitHintDraw` and `OCRWorkspace.tsx` L653. If `/api/templates` returns a different shape than `{id}` at the top level, the new template still lands in-memory (we use `crypto.randomUUID()` fallback) but subsequent updates hit the wrong id until reload. Worth a live smoke.
