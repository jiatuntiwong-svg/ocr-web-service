// Apply a curation suggestion: execute its action.op against the template's
// rules + mark suggestion as 'applied'.

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

function safeJson(s: any): any { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } }

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    if (!ENABLE_TEMPLATE_RULEBASE) return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;
    try {
        const { env } = await getCloudflareContext();
        const sug: any = await env.DB.prepare(
            "SELECT * FROM rule_suggestions WHERE id = ? AND status = 'pending'",
        ).bind(id).first();
        if (!sug) return fail(ErrorCode.NOT_FOUND, { context: "suggestion" });
        const cross = ensureCanActAs(auth, sug.user_id);
        if (cross) return cross;

        const action = safeJson(sug.action_json) || {};
        const targetIds: string[] = safeJson(sug.target_rule_ids) || [];
        const op = action.op as string;

        if (op === "disable" || op === "delete") {
            for (const rid of targetIds) {
                await env.DB.prepare(
                    "UPDATE template_rules SET deleted_at = CURRENT_TIMESTAMP, enabled = 0 WHERE id = ? AND template_id = ?",
                ).bind(rid, sug.template_id).run();
            }
        } else if (op === "replace" || op === "merge") {
            const keepId = action.keepRuleId;
            for (const rid of targetIds) {
                if (rid === keepId) continue;
                await env.DB.prepare(
                    "UPDATE template_rules SET deleted_at = CURRENT_TIMESTAMP, enabled = 0 WHERE id = ? AND template_id = ?",
                ).bind(rid, sug.template_id).run();
            }
            if (keepId && (action.newSpec || action.newNaturalLang)) {
                const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
                const params: any[] = [];
                if (action.newSpec) { updates.push("spec_json = ?"); params.push(JSON.stringify(action.newSpec)); }
                if (action.newNaturalLang) { updates.push("natural_lang = ?"); params.push(action.newNaturalLang); }
                params.push(keepId);
                await env.DB.prepare(`UPDATE template_rules SET ${updates.join(", ")} WHERE id = ?`).bind(...params).run();
            } else if (op === "merge" && action.newSpec) {
                const newId = crypto.randomUUID();
                await env.DB.prepare(
                    `INSERT INTO template_rules (id, template_id, user_id, type, spec_json, natural_lang, source, confidence)
                     VALUES (?, ?, ?, 'extraction', ?, ?, 'ai_generated', 0.7)`,
                ).bind(newId, sug.template_id, sug.user_id, JSON.stringify(action.newSpec), action.newNaturalLang || null).run();
            }
        } else {
            return fail(ErrorCode.BAD_REQUEST, { context: "curate-op-unknown" });
        }

        await env.DB.prepare(
            "UPDATE rule_suggestions SET status = 'applied', resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).bind(id).run();
        return NextResponse.json({ success: true, op });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "curate-apply" });
    }
}
