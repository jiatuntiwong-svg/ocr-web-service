// Phase C: approve a candidate rule → persist it.
// POST /api/templates/corrections/:id/approve
// Body: { type, spec, naturalLang, conflictAction?: 'keep_both' | 'replace' | 'merge', replaceRuleId? }

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

const VALID_TYPES = new Set(["extraction", "alignment", "comparison", "validation"]);

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    if (!ENABLE_TEMPLATE_RULEBASE) return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { id: correctionId } = await ctx.params;
    try {
        const body = (await request.json()) as {
            type: string; spec: any; naturalLang?: string;
            conflictAction?: "keep_both" | "replace" | "merge";
            replaceRuleId?: string;
        };
        if (!body.type || !body.spec) return fail(ErrorCode.MISSING_FIELDS, { context: "approve" });
        if (!VALID_TYPES.has(body.type)) return fail(ErrorCode.BAD_REQUEST, { context: "approve-type" });

        const { env } = await getCloudflareContext();
        const correction: any = await env.DB.prepare(
            "SELECT * FROM user_corrections WHERE id = ?",
        ).bind(correctionId).first();
        if (!correction) return fail(ErrorCode.NOT_FOUND, { context: "correction" });
        const tpl: any = await env.DB.prepare(
            "SELECT user_id FROM templates WHERE id = ?",
        ).bind(correction.template_id).first();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "template" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        // Apply conflict action
        if (body.conflictAction === "replace" && body.replaceRuleId) {
            // Soft-delete the conflicting rule first
            await env.DB.prepare(
                "UPDATE template_rules SET deleted_at = CURRENT_TIMESTAMP, enabled = 0 WHERE id = ? AND template_id = ?",
            ).bind(body.replaceRuleId, correction.template_id).run();
        }
        // 'keep_both' = no-op. 'merge' = same as keep_both for MVP (AI merge is Phase E).

        // Create the new rule
        const ruleId = crypto.randomUUID();
        await env.DB.prepare(
            `INSERT INTO template_rules
             (id, template_id, user_id, type, spec_json, natural_lang,
              source, confidence, derived_from_correction_id)
             VALUES (?, ?, ?, ?, ?, ?, 'ai_generated', 0.7, ?)`,
        ).bind(
            ruleId,
            correction.template_id,
            tpl.user_id,
            body.type,
            JSON.stringify(body.spec),
            body.naturalLang ?? null,
            correctionId,
        ).run();

        // Link correction → rule
        await env.DB.prepare(
            "UPDATE user_corrections SET status = 'rule_generated', rule_id = ? WHERE id = ?",
        ).bind(ruleId, correctionId).run();

        return NextResponse.json({ success: true, ruleId });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "approve" });
    }
}
