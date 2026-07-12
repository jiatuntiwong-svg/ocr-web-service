// User corrections — Phase B capture endpoint.
//
// Stores raw user feedback for a Compare field result. Phase C will read
// `status='pending'` rows and turn them into candidate rules; per D10, rows
// that fail to produce a rule get deleted at that point. Phase B only writes.
//
// GET is here for the future "Corrections inbox" UI (so we don't have to
// add another file later) — currently rendered nowhere in Phase B.

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

const ISSUE_TYPES = new Set(["wrong_value", "wrong_field", "should_ignore"]);

function gated() {
    return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
}

export async function POST(request: NextRequest) {
    if (!ENABLE_TEMPLATE_RULEBASE) return gated();
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    try {
        const body = (await request.json()) as {
            templateId: string;
            documentId?: string;
            fieldKey: string;
            paneIdx?: number;
            issueType: "wrong_value" | "wrong_field" | "should_ignore";
            wrongValue?: string;
            correctValue?: string;
            explanation?: string;
        };
        if (!body.templateId || !body.fieldKey || !body.issueType) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "correction-create" });
        }
        if (!ISSUE_TYPES.has(body.issueType)) {
            return fail(ErrorCode.BAD_REQUEST, { context: "correction-issue-type" });
        }

        const { env } = await getCloudflareContext();
        // Ownership check: only the template owner can attach corrections.
        const tpl: any = await env.DB.prepare(
            "SELECT user_id FROM templates WHERE id = ?",
        ).bind(body.templateId).first();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "templates" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        const id = crypto.randomUUID();
        await env.DB.prepare(
            `INSERT INTO user_corrections
             (id, user_id, template_id, document_id, field_key, pane_idx,
              wrong_value, correct_value, issue_type, explanation, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).bind(
            id,
            auth.id,
            body.templateId,
            body.documentId ?? null,
            body.fieldKey,
            body.paneIdx ?? null,
            body.wrongValue ?? null,
            body.correctValue ?? null,
            body.issueType,
            body.explanation ?? null,
        ).run();

        return NextResponse.json({ success: true, id });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "correction-create" });
    }
}

export async function GET(request: NextRequest) {
    if (!ENABLE_TEMPLATE_RULEBASE) return gated();
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { searchParams } = new URL(request.url);
    const templateId = searchParams.get("templateId");
    const status = searchParams.get("status"); // optional filter
    if (!templateId) return fail(ErrorCode.MISSING_FIELDS, { context: "corrections-list" });
    try {
        const { env } = await getCloudflareContext();
        const tpl: any = await env.DB.prepare(
            "SELECT user_id FROM templates WHERE id = ?",
        ).bind(templateId).first();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "templates" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        const query = status
            ? "SELECT * FROM user_corrections WHERE template_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200"
            : "SELECT * FROM user_corrections WHERE template_id = ? ORDER BY created_at DESC LIMIT 200";
        const stmt = status
            ? env.DB.prepare(query).bind(templateId, status)
            : env.DB.prepare(query).bind(templateId);
        const rows = await stmt.all();
        return NextResponse.json(rows.results || []);
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "corrections-list" });
    }
}
