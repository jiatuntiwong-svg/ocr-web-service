# UI-6 delete — TemplatePickerPanel "delete template" capability

Date: 2026-07-11
Owner: frontend-ui
Status: 👀 review — tsc + build clean

## Scope

Follow-up to UI-6. Added per-row "delete template" affordance to
`TemplatePickerPanel` inside `OCRWorkspaceV2`. Uses the existing backend
`DELETE /api/templates?id=&userId=` endpoint (no server changes).

## What landed

### `src/components/OCRWorkspaceV2.tsx`

1. New state on the parent:
   - `noticeToast: { text, tone: "success" | "error" } | null` — non-blocking
     bottom-center toast, distinct from `unsavedToast` (which is warning-tone).
2. New callback `deleteTemplate(id)` — optimistic UI + reconcile-on-error:
   - Skips system templates (`user_id === "system"` or `id` starts with
     `global-`) as belt-and-braces (the picker already hides the button).
   - Optimistically removes from `templates` list.
   - Clears `activeTemplateId` + `loadedTemplateSnapshot` if the deleted
     template was the loaded one.
   - Removes id from `favoriteTemplateIds`, `recentTemplateIds`, and
     `defaultOcrTemplateId` (localStorage keys `ocr_v2_favorite_template_ids`
     and `ocr_v2_recent_template_ids` are auto-synced via existing effects).
   - Calls `fetchJson(..., { method: "DELETE" })`.
   - On success: shows success toast (3s).
   - On failure: reverts `templates` list to previous snapshot, shows
     failure toast with `apiError()` message (4s).
3. Passed new `onDelete={deleteTemplate}` prop to `<TemplatePickerPanel />`.
4. Added notice-toast render block below the existing `unsavedToast`.

### `TemplatePickerPanel` component

1. Added `onDelete: (id: string) => void` to props.
2. Added `confirmingDeleteId` local state for the inline confirmation.
3. Added `isSystemTemplate(tpl)` helper.
4. `renderRow` now takes `user_id?: string` and emits one of three variants:
   - **System template** → 🔒 span (disabled), tooltip
     `templatePicker.delete.systemLocked`.
   - **Confirming** → inline "ลบ template นี้?" text + ✓ / ✗ buttons
     (stops row click).
   - **Idle** → ghost 🗑 icon (opacity 0.4, muted color).
5. Inline `<style>` scoped by `.ocr-v2-tpl-row` class — hover reveals the
   delete button at full contrast in the danger color. Prevents accidental
   destructive click on casual scrolls.

### `src/lib/i18n/locales/{th,en}.ts`

New keys under `ocr.v2.templatePicker.delete.*`:
- `button`, `confirm`, `yes`, `no`, `success`, `failure`, `systemLocked`.

Note on namespace: task brief specified `ocr.v2.templates.delete.*`, but the
existing UI-6 picker copy already lives under `ocr.v2.templatePicker.*`.
Keeping the sub-key there co-locates related copy and avoids introducing a
sibling namespace that only holds one nested block.

## Verify checklist

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | ✅ exit 0 |
| `npm run build` | ✅ 43 routes, clean |
| v1 `OCRWorkspace.tsx` byte-identical | ✅ md5 `4ae60c50a0fe59a57d994350c2cd44d5` before + after |
| System templates gated | ✅ Both `user_id === "system"` and `id` prefix `global-` treated as system, rendered as 🔒 span with tooltip |
| Delete clears loaded state | ✅ `activeTemplateId === id` triggers snapshot + active clear |
| localStorage keys cleaned | ✅ Both `ocr_v2_favorite_template_ids` and `ocr_v2_recent_template_ids` filter-remove, `defaultOcrTemplateId` also clears if match |
| Optimistic + reconcile on failure | ✅ Previous `templates` list snapshotted and restored on error path |
| No new deps | ✅ Reused `fetchJson`, `apiError`, existing state hooks |

## Not done / follow-ups

- The 🔒 span for system templates is a passive tooltip only; consider a
  small info toast if operator wants a nudge on click.
- No optimistic-reversion of `favoriteTemplateIds` / `recentTemplateIds` /
  `defaultOcrTemplateId` on error path — those stay removed even if the
  server rejects. Rationale: those are per-device UI-only lists, and the
  common failure mode is auth/network, in which case a stale favorite
  pointing at a still-existing template resurrects naturally on next
  fetch. If operator wants full reversion, snapshot + restore is trivial.
- Inline confirmation lives inside the row (fits within the 400px right
  panel width). Long template names may push the ✓ / ✗ buttons off-screen;
  the row's `overflow: hidden` on the name span mitigates but doesn't
  guarantee. Consider a modal escalation if operator feedback flags this.
