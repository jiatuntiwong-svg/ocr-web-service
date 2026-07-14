// Toggleable visual experiments. Set to `false` to remove the effect
// without touching component code — the elements / classes simply won't
// render or apply, and the workspace falls back to its prior look.

/** Scan-line overlay over the document preview while OCR is running. */
export const ENABLE_OCR_SCAN_LINE = true;

/** Staggered pop-in for fields in the result table when OCR completes. */
export const ENABLE_FIELD_POP = true;

/** "Mini story" loading panel — replaces generic spinner with a 5-step
 *  checklist derived from the progress value while OCR is running. */
export const ENABLE_LOADING_STORY = true;

// ─── Compare Highlight Pipeline v2 ──────────────────────────────────────────
// Cascading fallback pipeline: PDF text layer → AI bbox validation → search →
// table inference → existing fallbacks. Each sub-flag can be flipped off
// independently; the master flag short-circuits the entire pipeline back to
// the current render path. Production rollout 2026-06-18: all flags ON to
// collect real telemetry. Roll back by flipping any flag back to false +
// 1 deploy (~5 min).
// See: docs/COMPARE_HIGHLIGHT_PIPELINE_PLAN.md
export const ENABLE_HIGHLIGHT_PIPELINE_V2 = true;
export const ENABLE_TEXT_LAYER_EXTRACTION = true;
export const ENABLE_BBOX_VALIDATION = true;
export const ENABLE_TEXT_LAYER_SEARCH = true;
export const ENABLE_TABLE_INFERENCE = true;
export const ENABLE_HIGHLIGHT_POSTPROCESS = true;

// ─── OCR Workspace v3 (UI-4b) ───────────────────────────────────────────────
// New 6-step workspace layout (mockup `pm/reports/UI-4-mockup-v3.html`).
// Behind a flag so the current `OCRWorkspace.tsx` stays byte-identical in
// prod until operator sign-off. When ON, `src/app/(app)/ocr/page.tsx` routes
// to `OCRWorkspaceV2` instead. Toggle to `true` in preview to validate.
// Default OFF — flip in a follow-up deploy after UAT.
export const ENABLE_OCR_WORKSPACE_V2 = true;

// ─── Template Rulebase (Phase A: Foundation, dark) ─────────────────────────
// Per-template rules that grow with user corrections. Phase A ships the DB
// schema + API + read-only viewer; subsequent phases land capture, generation,
// injection, and curation. Default OFF so the new "Rules" tab + endpoints
// stay invisible until ready.
// See: docs/RULEBASE_LEARNING_LOOP_PLAN.md
export const ENABLE_TEMPLATE_RULEBASE = true;

// ─── Prompt profiles (S2-2) ────────────────────────────────────────────
// Versioned prompt-profile module (`src/lib/promptProfiles/`) replaces the
// inline prompt strings previously assembled inside the OCR routes. Rules
// are shared across profiles so the crop pass can never lose them again
// (root cause of OCR-6b). Flag OFF = every caller falls back to its
// previous inline string, byte-identical → rollback is one deploy.
// Default ON — S2-2 target for the S2-1 baseline landscape-a4-widefield
// case ("รับบริจาค" drop) requires the new rule block.
// See: docs/080726/OCR_IMPROVEMENT_TECHNIQUES_KB.md §2, pm/reports/S2-2.md
export const ENABLE_PROMPT_PROFILES = true;

// ─── Dual-scale crops (OCR-8b Rung 3) ──────────────────────────────────
// Rasterize each hinted field's crop at TWO DPIs (hi = CROP_DPI_SCALE×,
// lo = standard) and send both images to the crop pass. Shared rules
// v2026-07-12-v2 tells the model to reconcile and prefer the longer/more-
// complete reading. Aimed at the `landscape-a4-widefield` deterministic
// "รับบริจาค" drop that Rung 1 (single-scale DPI 2×) did not clear.
// Cost impact: +1 image per hinted field on the crop pass (~2× crop-pass
// input tokens). Flag OFF = OCR-8 Rung 1 single-scale behaviour,
// byte-identical.
// See: pm/reports/OCR-8b.md
export const ENABLE_DUAL_SCALE_CROPS = true;
