// Dismiss a curation suggestion without changing any rule.

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    if (!ENABLE_TEMPLATE_RULEBASE) return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;
    try {
        const { env } = await getCloudflareContext();
        const sug: any = await env.DB.prepare(
            "SELECT user_id FROM rule_suggestions WHERE id = ? AND status = 'pending'",
        ).bind(id).first();
        if (!sug) return fail(ErrorCode.NOT_FOUND, { context: "suggestion" });
        const cross = ensureCanActAs(auth, sug.user_id);
        if (cross) return cross;
        await env.DB.prepare(
            "UPDATE rule_suggestions SET status = 'dismissed', resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).bind(id).run();
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "curate-dismiss" });
    }
}
