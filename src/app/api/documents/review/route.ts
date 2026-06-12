// Mark / unmark a document as manually reviewed.
//
// POST /api/documents/review  { userId, docId, reviewed: true|false }
//   - reviewed=true  → stamp reviewed_at = now, reviewed_by = userId
//   - reviewed=false → clear both fields (undo)
//
// We require userId in the body so the WHERE clause can scope the update to
// the caller — no session-only auth check is enough here because admins also
// review docs on behalf of users, and we want the action attributed.

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as { userId?: string; docId?: string; reviewed?: boolean };
        if (!body.userId || !body.docId) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "documents-review" });
        }
        const { env } = await getCloudflareContext();
        if (!env?.DB) return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "documents-review" });

        // Allow self-review (owner) OR admin review on behalf.
        const caller = await env.DB
            .prepare("SELECT role FROM users WHERE id = ?")
            .bind(body.userId)
            .first<{ role: string }>();
        const doc = await env.DB
            .prepare("SELECT user_id FROM documents WHERE id = ?")
            .bind(body.docId)
            .first<{ user_id: string }>();

        if (!doc) return fail(ErrorCode.BAD_REQUEST, { detail: "doc not found", context: "documents-review" });
        if (doc.user_id !== body.userId && caller?.role !== "admin") {
            return fail(ErrorCode.UNAUTHORIZED, { context: "documents-review" });
        }

        if (body.reviewed === false) {
            await env.DB
                .prepare("UPDATE documents SET reviewed_at = NULL, reviewed_by = NULL WHERE id = ?")
                .bind(body.docId)
                .run();
        } else {
            await env.DB
                .prepare("UPDATE documents SET reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?")
                .bind(body.userId, body.docId)
                .run();
        }
        return ok({ success: true });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "documents-review" });
    }
}
