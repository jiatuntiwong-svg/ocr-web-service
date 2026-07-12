// Bulk "Reset all rules" for a template (UX §4.5 — danger zone).
//
// Soft-deletes every rule for the template. Optionally also wipes the
// correction history if `deleteCorrections=true` (matches the UI's "Also
// delete correction history" checkbox).

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

export async function POST(request: NextRequest) {
    if (!ENABLE_TEMPLATE_RULEBASE) return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    try {
        const body = (await request.json()) as { templateId: string; deleteCorrections?: boolean };
        if (!body.templateId) return fail(ErrorCode.MISSING_FIELDS, { context: "rules-reset" });
        const { env } = await getCloudflareContext();
        const tpl = await env.DB.prepare(
            "SELECT user_id FROM templates WHERE id = ?",
        ).bind(body.templateId).first<{ user_id: string }>();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "templates" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        const ruleRes = await env.DB.prepare(
            "UPDATE template_rules SET deleted_at = CURRENT_TIMESTAMP, enabled = 0 WHERE template_id = ? AND deleted_at IS NULL",
        ).bind(body.templateId).run();
        let correctionsDeleted = 0;
        if (body.deleteCorrections) {
            const cRes = await env.DB.prepare(
                "DELETE FROM user_corrections WHERE template_id = ?",
            ).bind(body.templateId).run();
            correctionsDeleted = (cRes as any)?.meta?.changes ?? 0;
        }
        return NextResponse.json({
            success: true,
            rulesDisabled: (ruleRes as any)?.meta?.changes ?? 0,
            correctionsDeleted,
        });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "rules-reset" });
    }
}
