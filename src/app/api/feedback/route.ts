// User-facing feedback submission endpoint. Anyone with a session may post;
// guests are allowed too (user_id = null) so we don't gate bug reports behind
// auth. Admin triage happens via /api/admin/feedback.

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logSystemEvent } from "@/lib/logger";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";

const ALLOWED_CATEGORIES = new Set(["bug", "feature", "other"]);
const MAX_MESSAGE = 4000;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as {
            userId?: string;
            category?: string;
            message?: string;
            pageUrl?: string;
            userAgent?: string;
        };
        const message = (body.message || "").trim();
        if (!message) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "feedback" });
        }
        if (message.length > MAX_MESSAGE) {
            return fail(ErrorCode.BAD_REQUEST, {
                detail: `message exceeds ${MAX_MESSAGE} chars`,
                context: "feedback",
            });
        }

        const category = ALLOWED_CATEGORIES.has(body.category || "")
            ? body.category!
            : "other";

        const userId = body.userId && body.userId !== "guest" ? body.userId : null;
        const pageUrl = (body.pageUrl || "").slice(0, 500) || null;
        const userAgent = (body.userAgent || req.headers.get("user-agent") || "").slice(0, 500) || null;

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "feedback" });
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
            `INSERT INTO feedback (id, user_id, category, message, status, page_url, user_agent)
             VALUES (?, ?, ?, ?, 'new', ?, ?)`,
        ).bind(id, userId, category, message, pageUrl, userAgent).run();

        await logSystemEvent(
            env,
            "FEEDBACK_SUBMITTED",
            `${category} feedback received (${message.length} chars)`,
            "info",
            userId || undefined,
        );

        return ok({ success: true, id });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "feedback" });
    }
}
