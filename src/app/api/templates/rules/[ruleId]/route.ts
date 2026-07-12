// Single-rule update / soft-delete.
// PATCH: enable/disable, edit spec, edit NL.
// DELETE: soft delete (sets deleted_at). Hard delete is reserved for admin.

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

async function getRuleOwner(env: any, ruleId: string): Promise<{ user_id: string; template_id: string } | null> {
    const row: any = await env.DB.prepare(
        "SELECT user_id, template_id FROM template_rules WHERE id = ? AND deleted_at IS NULL",
    ).bind(ruleId).first();
    return row ?? null;
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ ruleId: string }> }) {
    if (!ENABLE_TEMPLATE_RULEBASE) return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { ruleId } = await ctx.params;
    try {
        const { env } = await getCloudflareContext();
        const rule = await getRuleOwner(env, ruleId);
        if (!rule) return fail(ErrorCode.NOT_FOUND, { context: "rule" });
        const cross = ensureCanActAs(auth, rule.user_id);
        if (cross) return cross;

        const body = (await request.json()) as Partial<{
            enabled: boolean;
            spec: any;
            naturalLang: string;
            confidence: number;
        }>;

        const updates: string[] = [];
        const params: any[] = [];
        if (typeof body.enabled === "boolean") { updates.push("enabled = ?"); params.push(body.enabled ? 1 : 0); }
        if (body.spec !== undefined) { updates.push("spec_json = ?"); params.push(JSON.stringify(body.spec)); }
        if (body.naturalLang !== undefined) { updates.push("natural_lang = ?"); params.push(body.naturalLang); }
        if (typeof body.confidence === "number") { updates.push("confidence = ?"); params.push(body.confidence); }
        if (!updates.length) return fail(ErrorCode.MISSING_FIELDS, { context: "rule-patch" });
        updates.push("updated_at = CURRENT_TIMESTAMP");
        params.push(ruleId);

        await env.DB.prepare(
            `UPDATE template_rules SET ${updates.join(", ")} WHERE id = ?`,
        ).bind(...params).run();
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "rule-patch" });
    }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ ruleId: string }> }) {
    if (!ENABLE_TEMPLATE_RULEBASE) return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { ruleId } = await ctx.params;
    try {
        const { env } = await getCloudflareContext();
        const rule = await getRuleOwner(env, ruleId);
        if (!rule) return fail(ErrorCode.NOT_FOUND, { context: "rule" });
        const cross = ensureCanActAs(auth, rule.user_id);
        if (cross) return cross;
        await env.DB.prepare(
            "UPDATE template_rules SET deleted_at = CURRENT_TIMESTAMP, enabled = 0 WHERE id = ?",
        ).bind(ruleId).run();
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "rule-delete" });
    }
}
