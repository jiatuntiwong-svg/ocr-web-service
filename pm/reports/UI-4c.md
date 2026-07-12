# UI-4c — Flag-ON readiness punch list

Date: 2026-07-10.  Status: 👀 review.
Scope: `ENABLE_OCR_WORKSPACE_V2` = ON in prod (46022a42).  All fixes contained
inside `src/components/OCRWorkspaceV2.tsx` + i18n locales — v1 file untouched.

## Files changed

| File | Nature | Lines (approx) |
| --- | --- | --- |
| `src/components/OCRWorkspaceV2.tsx` | edits + BboxHintLayer/ModeSwitch appended | +260 / -40 |
| `src/lib/i18n/locales/en.ts` | `ocr.v2.*` key additions | +18 |
| `src/lib/i18n/locales/th.ts` | `ocr.v2.*` key additions | +18 |

Untouched: `src/components/OCRWorkspace.tsx` (v1), `src/app/(app)/ocr/page.tsx`,
`src/lib/hooks/usePanZoom.ts`, `src/app/globals.css`, all backend routes,
crop pipeline, BILL-1, OCR-3 handler, prompts.

---

## Chunk 1 — Hint drawing inside v2 fields stage ✅

Ported v1's per-field 📍 pin + drag-rect flow. Reuse of v1's coordinate math is
literal (BboxHintLayer + commitHintDraw are drop-in copies).

* Added `hintEditingFieldId` + `hintDraw` state + Escape-cancel effect (parity
  with v1 lines 226–283).
* Added `commitHintDraw(fid, r)` — same 2%-min gate, page-space normalisation,
  and best-effort template POST as v1.
* Field chip now renders a 📍 button between name and ✕. Click toggles
  `hintEditingFieldId`; Shift-click on a field with a stored hint clears it.
  The pin turns solid red once a hint is stored (mirrors v1 `bbox_hint ? c : ...`).
  Rename gate (`currentStage === "fields"`) still applies — hint editing is
  before-run only.
* Added a `<BboxHintLayer>` component (module-scope, below the default export)
  that renders inside the same coordinate wrapper as the image + result overlay
  layers. Same absolute+percent geometry, same "Escape to cancel" banner,
  same "dashed while editing" hint outline.
* Persistence: `commitHintDraw` POSTs the whole `fields` array to `/api/templates`
  when a template is active — identical contract to v1.  Follow-up flagged:
  when NO template is active, hints live only in component state and disappear
  on refresh (same limitation as v1 — not a regression).

## Chunk 2 — Batch access under flag ON ✅

Added `uiMode: "single" | "batch"` state at the top of `OCRWorkspaceV2`. The
topbar renders a `<ModeSwitch>` segmented control (`[ไฟล์เดียว] [หลายไฟล์]`) —
the switch persists across stages so flipping back to single keeps the v2
stage state (verified in my walkthrough: v2 `currentStage`/`maxReachedStage`
survive because the switch never touches them).

When `uiMode === "batch"`, the component short-circuits BEFORE rendering the
v2 body and returns:

```
<topbar with ModeSwitch>
<OCRWorkspaceV1 user balance onDocumentProcessed onNavigateToBilling />
```

Simplest possible wiring — v1's own dropzone-detects-multi + batch runner
already handle everything. Page router (`src/app/(app)/ocr/page.tsx`)
untouched.

i18n:  `ocr.v2.modeSingle` / `ocr.v2.modeBatch` (th + en).

## Chunk 3 — UAT round 1 parity fixes

### 3a Scan-line ✅
Added `{ENABLE_OCR_SCAN_LINE && loading && <div className="docroom-scan-line" />}`
inside the pan/zoom container.  The overlay is absolute → doesn't shift the
image or the hint layer.  Global CSS (`globals.css` line 151) already
handles the animation + `prefers-reduced-motion`.  Runs on every stage where
`loading === true`.

### 3b Dropzone parity ✅
Replaced v2's minimal dropzone (large-font 📄 emoji + heavy dashed background)
with v1's exact markup: cloud-with-arrow SVG in a rounded tile with hover
scale+rotate animation, dashed border, headline + subtext, plus the
`.ocr-dropzone` hover CSS from v1 injected inline. Copy still comes from the
existing i18n keys (`ocr.uploadHeadline`, `ocr.uploadSubtext`, and the same
docx-converting fallback).

### 3c Zoom + pan ✅
Wired `usePanZoom({ zoom, setZoom: setZoomClamped, min: 0.5, max: 3 })` on
the outer preview container. Added toolbar buttons `−`, `%` label, `+`, `⟳`
using tokens.

**OCR-6c invariant preserved.**  Preview inner structure is:

```
<div {...panZoom.containerProps} style={{overflow:auto, display:flex, ...}}>
  {loading && <div className="docroom-scan-line" />}
  <div style={{ width: `${100 * zoom}%`, position: "relative" }}>
      <img style={{ width: "100%", height: "auto", pointerEvents: "none" }} />
      <BboxHintLayer ... />
      <div style={{ position:"absolute", inset:0, opacity: showOverlay?1:0 }}>
        {resultEntries.map(... render bbox overlays ...)}
      </div>
  </div>
</div>
```

Zoom applies to the ONE wrapper that contains image + hint layer + result
overlay as siblings — they scale together, coordinate space is stable.
`img` has `pointer-events:none` so drag events reach the pan container.
Wheel-zoom + Space-pan come free via the hook.

## Chunk 4 — UAT round 2 fixes

### 4a Stage-machine deadlock ✅

**Root cause**: `canJumpTo` gated on `idx <= indexOf(currentStage)`. Once the
user was on `upload`, every forward step was blocked AND the upload panel's
dropzone was the only affordance shown — with a file already loaded, no path
forward.

**Fix**: introduced `maxReachedStage` as a second, monotonic state.

```ts
const [currentStage, setCurrentStageRaw] = useState<Stage>("upload");
const [maxReachedStage, setMaxReachedStage] = useState<Stage>("upload");
const setCurrentStage = useCallback((s: Stage) => {
    setCurrentStageRaw(s);
    setMaxReachedStage(prev =>
        STAGE_ORDER.indexOf(s) > STAGE_ORDER.indexOf(prev) ? s : prev);
}, []);
// canJumpTo now checks the frontier, not the current stage.
const canJumpTo = (target: Stage) => {
    const idx = STAGE_ORDER.indexOf(target);
    const frontier = STAGE_ORDER.indexOf(maxReachedStage);
    if (idx > frontier) return false;
    // ...standard prerequisite checks (file? result? etc.)
};
const goToStage = (t) => { if (canJumpTo(t)) setCurrentStageRaw(t); };
// ^ backward jump uses raw setter — never lowers frontier.
```

Every auto-advance (`setCurrentStage`) updates BOTH; every manual stepper jump
via `goToStage` updates only `currentStage`. `resetAll()` resets BOTH back
to `upload` (fresh document = fresh frontier).

**Upload stage with existing file**: `renderUploadPanel()` now renders a
prominent primary-styled card at the top when `file` is set:
> **ทำงานต่อกับไฟล์เดิม** · file.name (N pages) · **[ ใช้ไฟล์เดิมต่อ → ]**

Button jumps to `maxReachedStage` if the user has progressed past upload,
otherwise falls back to `pages`/`fields` per PDF page count. The dropzone
below the card still accepts a fresh drop.

**Regression walkthrough** (mentally verified):

| Step | Action | currentStage | maxReachedStage | canJumpTo(5)? |
| --- | --- | --- | --- | --- |
| 1 | Load 3-page PDF | pages | pages | ✗ (no result) |
| 2 | Select pages, next | fields | fields | ✗ |
| 3 | Run | run → results | results | ✓ |
| 4 | Advance to export | export | export | ✓ |
| 5 | Stepper click "1 อัปโหลด" | upload | export | ✓ |
| 6 | Stepper click "5 ผลลัพธ์" | results | export | ✓ |
| 7 | Click "ใช้ไฟล์เดิมต่อ" on upload | export | export | ✓ |

Deadlock resolved: the frontier survives the backward jump.

### 4b JSON tab theming ✅

Before:
```css
background: #0a0f1c;   color: var(--color-text-1);
```
On light mode, `--color-text-1` is dark → text vanishes on dark bg. Actually
opposite: near-black bg with dark text.

After (main JSON tab pre):
```css
background: var(--color-bg-elevated);
border: 1px solid var(--color-border);
color: var(--color-text-1);
```

Also fixed the per-field expanded raw JSON block (same hardcoded palette): now
`background: var(--color-bg-panel)`, `color: var(--color-text-2)`, with a
`--color-border`.  Both blocks now respect the theme automatically — dark
mode still gets the near-black look via the elevated/panel tokens; light mode
gets a light card background with dark text.

## Chunk 5 — Verify ✅

* `npx tsc --noEmit` → exit 0.
* `npm run build` → exit 0 (all routes render, /ocr static).
* v1 file (`OCRWorkspace.tsx`) modification time unchanged in this session —
  all edits confined to `OCRWorkspaceV2.tsx` and the two i18n locales.

---

## Overlay-invariant preservation proof

`src/components/OCRWorkspaceV2.tsx` renderPreview (indentation kept):

```tsx
<div {...panZoom.containerProps} style={{ position:"relative", flex:1, overflow:"auto", ... }}>
  {ENABLE_OCR_SCAN_LINE && loading && <div className="docroom-scan-line" aria-hidden />}
  <div style={{ width: `${100 * zoom}%`, flexShrink: 0, position: "relative" }}>
    <img ... />                       {/* image */}
    <BboxHintLayer ... />             {/* hint layer */}
    <div style={{ position:"absolute", inset:0, opacity: showOverlay?1:0 }}>
      {resultEntries.map(...)}        {/* result-bbox overlay */}
    </div>
  </div>
</div>
```

Image, hint layer, and result-bbox overlay are siblings inside the
`width: 100*zoom%` wrapper.  Zoom scales all three together via the parent's
width; pan scrolls via the outer container's scrollLeft/Top. Coordinate space
never decouples.

---

## Backward-compat proof (v1 tree)

`src/app/(app)/ocr/page.tsx` still dispatches to v1 when the flag is OFF
(line 30–37). My edits are limited to V2 + i18n; when the flag is OFF, v2 is
not imported into the render tree at all — v1 behaviour is byte-identical to
before this task.

`grep -n "OCRWorkspace" src/app/(app)/ocr/page.tsx` → v1 import + fallback
render still present.

---

## i18n keys added

`ocr.v2.modeSingle`, `ocr.v2.modeBatch`
`ocr.v2.upload.existingHead`, `ocr.v2.upload.useExisting`
`ocr.v2.zoom.in`, `ocr.v2.zoom.out`, `ocr.v2.zoom.reset`
`ocr.v2.hint.pinEmpty`, `ocr.v2.hint.pinFilled`, `ocr.v2.hint.dragTo`

Both Thai and English.

---

## Follow-ups for the operator to re-verify

1. **UAT walkthrough** — 1→2→3→4→5→click 1→click 5. Deadlock should be gone;
   stepper item 5 stays enabled after the backward jump.
2. **Hint draw persistence** — draw a hint with an active template selected,
   reload the page, re-open the same template — hint should survive
   (persistence uses v1's `/api/templates` POST unchanged). Without a
   template, hints are session-only (documented, matches v1).
3. **Zoom + pan** — Ctrl-wheel zoom, spacebar-grab pan, double-click reset,
   toolbar buttons.  With overlay ON and a stored hint, verify the hint
   rectangle stays glued to the same document location at every zoom level.
4. **Batch mode** — flip topbar to "หลายไฟล์", drop 3 PDFs, run batch;
   flip back — v2 remembers its stage. `batchItems` context is shared across
   v1/v2 (v2 doesn't use it, v1 owns it — no leak).
5. **JSON tab** — flip theme to light, open the JSON tab: text must be
   readable on the light panel background.

---

## Red flags / spots I couldn't verify

* **Hint save endpoint contract** — reuses v1's POST unchanged. If backend
  API-2 or template schema changes, both v1 and v2 need the update
  simultaneously.
* **Zoom + PDF text-layer alignment**: v2 doesn't use pdfjs text-layer overlay
  (Compare-only feature), so no interaction expected. Not tested empirically.
* **Space-key steal in v2 forms**: `usePanZoom` guards space if focus is in
  `INPUT/TEXTAREA/contentEditable`. Field-name editor uses `<input>` so
  guarded. If any future stage adds a non-input focusable element the
  spacebar behaviour will need re-check.
* **`ModeSwitch` inside v1-embedded topbar**: the switch is rendered ABOVE
  the v1 workspace. v1 has its own topbar-independent chrome; the two
  topbars will visually stack. Acceptable per PM decision "no batch
  redesign".
* **Fulldoc + batch**: batch mode uses v1's chrome, which doesn't have the
  fulldoc chooser — so fulldoc + batch is not reachable from v2's ModeSwitch.
  Consistent with v1 behavior. Flag if operator asks for it.
