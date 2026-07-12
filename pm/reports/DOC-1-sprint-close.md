# DOC-1 — Sprint-close sync (OCR Stabilization, 2026-07-11)

Sprint deploy pointer: `a878584d` (prod).

Scope of this pass: sync the 5 living docs to reflect final sprint state, verified against code. No new plan docs.

## Files changed

### 1. `docs/OCR_TESTING_LOG.md`
- §4 row 3 (Gemini variance): flipped from "todo in sprint" → ✅ shipped 2026-07-11 (OCR-3 handler `temperature: 0.6` + UI-4c/UI-6 overflow menu / kbd R).
- §5 recommendation list: dropped OCR-3 from "still open"; kept OCR-2 execution (blocked on operator Playwright + creds), Rulebase, model tier switching, two-pass.
- Footer date bumped to 2026-07-11.
- Added new §13 "Sprint close — OCR Stabilization" with:
  - Resolution table (issue 1.2 / 1.3 / 2.5-partial / raw errors / F4 / provider / credit race / workspace v2).
  - Pass-rate note: unmeasured — OCR-2 headed baseline still blocked on operator. Operator-verified positive signals cited (doc1 dense, landscape ใบโอนย้ายสินทรัพย์ถาวร, 7-page bundle).
  - Behavior deltas locked into `BEHAVIOR_REFERENCE.md`.

### 2. `docs/BEHAVIOR_REFERENCE.md`
- Snapshot date bumped to 2026-07-11, tagged with deploy `a878584d`.
- §4.2 renamed to "OCR Workspace v2" + prelude describing that `ENABLE_OCR_WORKSPACE_V2` is ON in prod, routing to `OCRWorkspaceV2.tsx` (legacy behind flag as rollback). Listed v2 shell: 6-step stepper, kbd-first, stage-machine driven.
- Added new rows in §4.2 for:
  - Landing on v2 with `<TemplatePickerPanel>` (⭐/🕐/📋 + delete, system-template gate).
  - ⚡ Quick mode topbar toggle (auto-advance; credit-confirm never bypassed).
  - "Full document" mode-switch topbar (client-side today; API-4/S2-2 remaining).
  - "Show hint boxes" toggle.
  - "Retry" (overflow menu / kbd R) at `temperature: 0.6`.
- Added new §4.2c "Credit model (BILL-1)": table of `per_page` (default) / `field_formula` / `per_file`, admin-switchable via `/api/admin/tier-config`, Compare NOT model-switchable, `chargeCreditsAtomic()` shared between `/api/upload` + `/api/v1/extract`.

### 3. `docs/PENDING_ISSUES.md`
- No in-place edits. §H header already carries the 2026-07-09 status-update note that covers this sprint's scope (H1/H2/H3/H4 closed for OCR + auth flows; Compare / admin / documents / billing still queued for Phase 7.5). F4 already ✅ in §F. Issue 1.2 / 1.3 are OCR_TESTING_LOG concerns, not PENDING_ISSUES rows.

### 4. `docs/PENDING_FEATURES_BACKLOG.md`
- Added a "Landed since last audit (2026-07-11 sprint close)" bullet list at the top: F4 upload guard, retry UI, page selection, Vertex provider, credit-model switcher, workspace v3, template picker + delete, coded errors, atomic credit charge.
- Ticked "Retry failed OCR UI" (was the last stale checkbox representing sprint work).

### 5. `docs/CREDIT_PRICING_SUMMARY.md`
- Header now carries a 2026-07-11 verify note pointing at deploy `a878584d` + confirming `src/lib/pricing.ts` matches doc (`CreditModel` union, `DEFAULT_CREDIT_MODEL = "per_page"`, `chargeCreditsAtomic()`).
- Appendix A: replaced the "atomic UPDATE in `/api/upload`" row with the shared `chargeCreditsAtomic()` helper (used by both `/api/upload` and `/api/v1/extract`) + `getActiveCreditModel(env)` lookup.

## Verification notes

Every claim marked ✅ was checked against code before writing:

| Claim | Code proof |
|--|--|
| Workspace v2 flag ON | `src/lib/featureFlags.ts:36` — `ENABLE_OCR_WORKSPACE_V2 = true` |
| Template Rulebase flag ON | same file line 44 — `ENABLE_TEMPLATE_RULEBASE = true` (surfaces v2 workspace's Rules tab foundation) |
| TemplatePickerPanel + delete | `src/components/OCRWorkspaceV2.tsx` — `deleteTemplate` at 306, panel at 1238, `onDelete` at 1253, component at 2338, delete handler at 2411 |
| ⚡ Quick mode auto-run + credit-confirm reuse | `OCRWorkspaceV2.tsx:387` (§B auto-advance) and `:683` (must-not-bypass credit confirm comment) |
| Retry temperature 0.6 | `src/lib/ai-handler.ts:45-52,74-77,112-117` — handler accepts optional `temperature`, retry path passes `0.6` |
| `chargeCreditsAtomic` helper | `src/lib/credits.ts:35` — exported function |
| 20 MB upload cap + FILE_TOO_LARGE | `src/app/api/upload/route.ts:15,137-142` — `MAX_UPLOAD_SIZE_MB` import + `ErrorCode.FILE_TOO_LARGE` with `{ limit, actual }` |
| CreditModel = "per_page" default | `src/lib/pricing.ts:29-31` — union type + `DEFAULT_CREDIT_MODEL = "per_page"` |

## Not done / carry-forward

- **BEHAVIOR_REFERENCE.md §6 acceptance matrix** — rows still reference the pre-v2 workspace (auto-fullscreen, etc.) but that matrix is Docker-migration sign-off, not sprint-close product behavior. Left alone to avoid churning the migration audit.
- **PENDING_ISSUES §H** — Compare / admin / documents / billing raw-error rows still open (Phase 7.5). Header already notes this.
- **OCR-2 execution** — cannot mark measured pass-rate until operator unblocks Playwright + creds. Noted explicitly in OCR_TESTING_LOG §13 and §5.

_docs-manager pass, 2026-07-11._
