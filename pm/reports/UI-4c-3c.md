# UI-4c §3c — UAT round 3 fixes

Follow-up delta to `UI-4c.md` (round 1 + round 2 landed there). This pass ships three surgical polish items from operator's 2026-07-10 screenshot review.

## Files changed

- `src/components/OCRWorkspaceV2.tsx` (single file — no i18n changes needed; existing keys sufficed)
  - Preview overlay wrapper — hint layer gated by unified `overlayEnabled` (approx. lines 748-777 after edit)
  - Batch-mode topbar — collapsed to right-aligned mode-switch strip (approx. lines 1506-1518)
  - Single-mode topbar — collapsed to right-aligned mode-switch strip (approx. lines 1543-1553)

No touch: `OCRWorkspace.tsx` (v1) — verified via `git status`, still shows only the pre-session modification unrelated to §3c. Flag-OFF path stays byte-identical.

## §3c-1 — Credit chip removal

**Before** (both single and batch topbars had the same chip):
```tsx
<span style={{
    padding: "4px 10px", borderRadius: 999,
    background: "var(--color-bg-elevated)", color: "var(--color-text-2)",
    border: "1px solid var(--color-border)",
}}>⚡ {balance} credits</span>
```

**After:** deleted from both topbars. Its wrapper `<div style={{ display:"flex", gap:8, ... }}>` became a single-child container so I flattened it — the `ModeSwitch` now sits directly in the topbar row.

**Dual-purpose check:** the chip rendered `⚡ {balance} credits` — pure balance display sourced from the `balance` prop (same value the app TopBar `เครดิต` display uses). It was NOT wired to `estimate.credits` or any pre-run estimate. Deletion is safe; the stage-4 "รัน" credit-estimate card (`renderRunPanel` → "costHead" tile at `estimate.credits`) is a separate render and stays untouched.

The `balance` prop itself is still used elsewhere (`CreditConfirmDialog`, `evaluateConfirm` inside `requestRetry`), so no prop cleanup needed.

## §3c-2 — Title dedup

**Before:**
```tsx
<div style={{ justifyContent: "space-between", padding: "14px 20px", ... }}>
    <div style={{ fontWeight: 700, fontSize: 15 }}>{t("ocr.title")}</div>
    <div style={{ display: "flex", gap: 8, ... }}>
        <ModeSwitch ... />
        <span>⚡ {balance} credits</span>
    </div>
</div>
```

**After:**
```tsx
<div style={{ justifyContent: "flex-end", padding: "10px 20px", ... }}>
    <ModeSwitch mode={uiMode} onChange={setUiMode} t={t} />
</div>
```

- Dropped the `{t("ocr.title")}` heading (app `(app)/layout.tsx` TopBar renders the "OCR Workspace" title already — no more duplicate).
- Mode switch is right-aligned in the vacated strip (justifyContent flex-end).
- Reduced vertical padding 14 → 10 px since the row is now a single compact control.
- Applied identically to both branches: the batch-mode redirect (renders V1) and the main single-mode return.
- The `ocr.title` i18n key remains in the catalog (still used by TopBar / breadcrumb / batch V1 flow); no orphan.

## §3c-3 — Unified 👁 toggle (hints + highlights)

**Root problem:** `overlayEnabled` gated only the result-highlight wrapper (`showOverlay = overlayEnabled && !!result && currentStage !== "run"`). `BboxHintLayer` was rendered raw with no visibility gate — hint boxes stayed drawn regardless of the 👁 state.

**Fix:** wrap `BboxHintLayer` in an opacity/pointer-events gate that mirrors the result-overlay gate:

```tsx
<div style={{
    position: "absolute", inset: 0,
    opacity: (overlayEnabled || hintEditingFieldId) ? 1 : 0,
    pointerEvents: (overlayEnabled || hintEditingFieldId) ? "auto" : "none",
    transition: "opacity 0.15s ease",
}}>
    <BboxHintLayer ... />
</div>
```

**OCR-6c invariant preserved:** the wrapper is a plain `position:absolute; inset:0` sibling inside the same zoomed container that holds the `<img>` and the result-overlay. `BboxHintLayer` itself is never conditionally rendered — only its wrapper's opacity flips. The layer's `ref`, event handlers, and percentage coordinate math survive across toggle flicks and stage jumps.

**Editing escape hatch:** when `hintEditingFieldId` is truthy the layer stays fully visible/interactive regardless of `overlayEnabled`. Otherwise a user who disabled the 👁 could enter draw mode and be unable to see the crosshair overlay. This is the minimum override needed.

**Scope note:** the ▢ กรอบ / ▁ เส้นใต้ style switch continues to affect only the result-highlight visual — hint pins keep their distinct red rectangle rendering as intended.

## Regression walkthrough (static)

- **Hint drawing (round-1 chunk 1):** wrapper is only around the layer; the layer's DOM shape and event wiring are unchanged. Draw + commit + template save path untouched.
- **Stage machine (round-2 fix):** `maxReachedStage` / `canJumpTo` / "use existing" upload card — none touched. The 1→…→5→1→5 unblock still holds.
- **Zoom/pan (round-1 chunk 3):** zoom container and `panZoom` wiring untouched. Overlay wrapper being inside the same zoomed div means hint boxes still track the raster on zoom.
- **JSON tab theme tokens (round-2 fix):** untouched.
- **Scan line, dropzone SVG:** untouched.
- **Batch mode fall-through to V1:** V1 component embed unchanged (only the surrounding chrome shrank).

## Backward compat

- `OCRWorkspace.tsx` untouched; flag OFF renders the v1 tree exactly as before.
- No prop signature change on `OCRWorkspaceV2` (`balance` still received, still consumed by the retry confirm dialog).
- No i18n key added or removed.

## Follow-ups flagged / cross-reference to UI-6

- **UI-6 item 3** ("remove credit chip from topbar") is now materially done inside V2 by §3c-1. UI-6 should NOT re-do this — instead treat item 3 as verified and focus UI-6 solely on the template picker overhaul (items 1-2) and the Pro-plan chip decision. Recommend updating UI-6 spec text when it's picked up.
- **UI-6 item 1** (template picker with search/fav/recent) is the next natural touch of the fields-stage panel — it will replace the existing `<select>` at `renderFieldsPanel` (`ocr.v2.fields.template` card). No coupling with §3c code, but the fields-stage panel is where UI-6 will land.

## Red flags / unverified

- Only static verification: `npx tsc --noEmit` clean, `npm run build` clean, git status confirms v1 not modified. Not run in a live preview — operator to verify visually.
- Unverified visual: whether removing the topbar heading leaves too much vertical whitespace above the stepper. The stepper still has its own `12px 20px` padding — should look tight enough — but a live check may want to tune the strip's `10px` padding.
- The `hintEditingFieldId` override on §3c-3 means if the user disables 👁 mid-workflow and then clicks a 📍 pin, the layer will pop back to full opacity for the duration of the edit and fade back after commit. Intentional but worth flagging in case operator wants "off means always off, disable pin buttons instead" semantics.
