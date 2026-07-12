// Phase C: reject candidate rule → drop the correction (D10 decision).
// POST /api/templates/corrections/:id/reject

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    if (!ENABLE_TEMPLATE_RULEBASE) return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { id: correctionId } = await ctx.params;
    try {
        const { env } = await getCloudflareContext();
        const correction: any = await env.DB.prepare(
            "SELECT user_id, template_id FROM user_corrections WHERE id = ?",
        ).bind(correctionId).first();
        if (!correction) return fail(ErrorCode.NOT_FOUND, { context: "correction" });
        const cross = ensureCanActAs(auth, correction.user_id);
        if (cross) return cross;

        // D10: drop correction when user skips/rejects rule generation.
        await env.DB.prepare(
            "DELETE FROM user_corrections WHERE id = ?",
        ).bind(correctionId).run();
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "reject" });
    }
}
