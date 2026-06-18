import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/guards";

export async function GET(request: NextRequest) {
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
        return fail(ErrorCode.MISSING_FIELDS, { context: "status" });
    }

    try {
        const { env } = await getCloudflareContext();
        if (!env || !env.DB) {
            return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "status" });
        }

        const doc = await env.DB.prepare("SELECT status, raw_json, user_id FROM documents WHERE id = ?")
            .bind(id)
            .first<{ status: string; raw_json: string; user_id: string }>();

        if (!doc) {
            return fail(ErrorCode.NOT_FOUND, { context: "status" });
        }
        // Ownership check: only the document's owner (or an admin) may poll its
        // status. Without this, anyone holding a doc UUID could read other
        // users' extracted JSON (SECURITY_AUDIT §2).
        if (doc.user_id !== auth.id && auth.role !== "admin") {
            return fail(ErrorCode.UNAUTHORIZED, { context: "status" });
        }

        let data = null;
        if (doc.status === "completed" && doc.raw_json) {
            try {
                data = JSON.parse(doc.raw_json);
            } catch (e) {
                console.error("JSON Parse Error in Status API:", e);
            }
        } else if (doc.status === "error") {
            try {
                data = JSON.parse(doc.raw_json);
            } catch (e) {
                data = { error: "Unknown processing error" };
            }
        }

        return ok({ success: true, status: doc.status, data });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "status" });
    }
}
