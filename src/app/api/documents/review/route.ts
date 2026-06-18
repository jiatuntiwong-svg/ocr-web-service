// Mark / unmark a document as manually reviewed.
//
// POST /api/documents/review  { docId, reviewed: true|false }
//   - reviewed=true  → stamp reviewed_at = now, reviewed_by = <session user id>
//   - reviewed=false → clear both fields (undo)
//
// Authorisation: the session user must own the document, OR be an admin.
// Any `userId` in the request body is ignored — we always attribute to the
// verified session id so admins reviewing on behalf still log themselves
// as the reviewer.

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/guards";

export async function POST(req: NextRequest) {
    try {
        const auth = await requireUser(req);
        if (auth instanceof Response) return auth;

        const body = await req.json() as { docId?: string; reviewed?: boolean };
        if (!body.docId) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "documents-review" });
        }
        const { env } = await getCloudflareContext();
        if (!env?.DB) return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "documents-review" });

        const doc = await env.DB
            .prepare("SELECT user_id FROM documents WHERE id = ?")
            .bind(body.docId)
            .first<{ user_id: string }>();

        if (!doc) return fail(ErrorCode.BAD_REQUEST, { detail: "doc not found", context: "documents-review" });
        if (doc.user_id !== auth.id && auth.role !== "admin") {
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
                .bind(auth.id, body.docId)
                .run();
        }
        return ok({ success: true });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "documents-review" });
    }
}
