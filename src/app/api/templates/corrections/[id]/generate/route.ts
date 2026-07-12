// Phase C: rule generator endpoint.
// POST /api/templates/corrections/:id/generate
// Reads the saved correction, asks AI for a candidate rule, detects conflicts
// against existing rules, returns the candidate (does NOT save the rule).
//
// The user reviews → approves/skips via separate endpoints — keeps generation
// idempotent (re-running just re-asks the AI).

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";
import { getActiveAIConfigs, generateWithAI } from "@/lib/ai-handler";
import { buildRuleGenerationPrompt, parseRuleResponse } from "@/lib/rulebase/promptBuilder";

function gated() { return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" }); }

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    if (!ENABLE_TEMPLATE_RULEBASE) return gated();
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { id: correctionId } = await ctx.params;

    try {
        const { env } = await getCloudflareContext();

        // Load correction + template
        const correction: any = await env.DB.prepare(
            "SELECT * FROM user_corrections WHERE id = ?",
        ).bind(correctionId).first();
        if (!correction) return fail(ErrorCode.NOT_FOUND, { context: "correction" });
        const tpl: any = await env.DB.prepare(
            "SELECT id, user_id, name, fields_json FROM templates WHERE id = ?",
        ).bind(correction.template_id).first();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "template" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        // Build prompt
        const fields = safeJson(tpl.fields_json) || [];
        const prompt = buildRuleGenerationPrompt({
            templateName: tpl.name,
            templateFields: Array.isArray(fields) ? fields : [],
            correction: {
                fieldKey: correction.field_key,
                issueType: correction.issue_type,
                wrongValue: correction.wrong_value,
                correctValue: correction.correct_value,
                explanation: correction.explanation,
                paneIdx: correction.pane_idx,
            },
        });

        // Call AI
        const configs = await getActiveAIConfigs(env);
        if (!configs.length) return fail(ErrorCode.AI_UNAVAILABLE, { context: "no-ai-config" });
        const target = configs[0];
        const apiKeys = configs.filter(c => c.provider === target.provider && c.model === target.model).map(c => c.apiKey);
        const ai = await generateWithAI({
            provider: target.provider,
            model: target.model,
            prompt,
            apiKeys,
        });

        const candidate = parseRuleResponse(ai.text);
        if (!candidate || !candidate.spec) {
            return NextResponse.json({
                success: false,
                reason: "no_rule_derivable",
                rawText: ai.text.slice(0, 500),
                usage: ai.usage,
            });
        }

        // Conflict detection — same field_target or same context as existing rule.
        const targetField =
            candidate.spec?.assert?.field_target ||
            candidate.spec?.match?.field_target ||
            candidate.spec?.match?.table_field ||
            null;
        let conflicts: any[] = [];
        if (targetField) {
            const rows = await env.DB.prepare(
                `SELECT id, type, spec_json, natural_lang
                 FROM template_rules
                 WHERE template_id = ? AND deleted_at IS NULL AND enabled = 1`,
            ).bind(correction.template_id).all();
            for (const r of (rows.results || []) as any[]) {
                const spec = safeJson(r.spec_json);
                const otherTarget =
                    spec?.assert?.field_target || spec?.match?.field_target || spec?.match?.table_field;
                if (otherTarget && norm(otherTarget) === norm(targetField) && r.type === candidate.type) {
                    conflicts.push({
                        ruleId: r.id,
                        naturalLang: r.natural_lang,
                        reason: `Existing ${r.type} rule targets the same field`,
                    });
                }
            }
        }

        return NextResponse.json({
            success: true,
            candidate,
            conflicts,
            usage: ai.usage,
        });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "rule-generate" });
    }
}

function safeJson(s: any): any { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } }
function norm(s: string): string { return s.trim().toLowerCase().replace(/\s+/g, " "); }
