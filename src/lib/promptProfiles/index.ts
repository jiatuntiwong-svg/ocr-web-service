// Prompt profile catalog — one place to add new prompt shapes and to look
// up the current version pin (used by ai_usage / regression reports).
//
// See docs/080726/OCR_IMPROVEMENT_TECHNIQUES_KB.md §2 for the design.
// Rollout is gated by `ENABLE_PROMPT_PROFILES` in `src/lib/featureFlags.ts`
// — flag OFF = every caller falls back to its previous inline prompt,
// byte-identical, so a regression can be reverted in one deploy.

import { EXTRACT_FIELDS_PROFILE, type ExtractFieldsCtx } from "./extractFields";
import { VERBATIM_TRANSCRIBE_PROFILE, type VerbatimTranscribeCtx } from "./verbatimTranscribe";
import { LAYOUT_SCAN_PROFILE, type LayoutScanCtx } from "./layoutScan";
import { COMPARE_PROFILE, type CompareCtx } from "./compare";
import { SHARED_RULES_VERSION } from "./sharedRules";

export type PromptProfileName =
    | "extract_fields"
    | "verbatim_transcribe"
    | "layout_scan"
    | "compare";

export const PROMPT_PROFILES = {
    extract_fields: EXTRACT_FIELDS_PROFILE,
    verbatim_transcribe: VERBATIM_TRANSCRIBE_PROFILE,
    layout_scan: LAYOUT_SCAN_PROFILE,
    compare: COMPARE_PROFILE,
} as const;

export { SHARED_RULES_VERSION };

// ─── Typed context union so callers get real type-checking ─────────────
export type PromptProfileCtx = {
    extract_fields: ExtractFieldsCtx;
    verbatim_transcribe: VerbatimTranscribeCtx;
    layout_scan: LayoutScanCtx;
    compare: CompareCtx;
};

/** Fetch a profile and build both `system` + user prompt in one call. Falls
 *  back to a { fallback: true } sentinel when the profile name is unknown
 *  so callers can honour their backward-compat inline prompt.
 *
 *  Note: this helper does NOT check the ENABLE_PROMPT_PROFILES feature flag
 *  — the caller does that so it can also skip building the ctx object when
 *  falling back (some ctx values require extra work to compute). */
export function getPromptProfile<K extends PromptProfileName>(
    name: K,
    ctx: PromptProfileCtx[K],
): { id: K; version: string; system: string; prompt: string } | { fallback: true } {
    const profile = PROMPT_PROFILES[name];
    if (!profile) return { fallback: true };
    return {
        id: name,
        version: profile.version,
        system: profile.system,
        // Each profile knows the shape of its own ctx — safe cast.
        prompt: (profile as { buildUserPrompt(c: unknown): string }).buildUserPrompt(ctx),
    };
}
