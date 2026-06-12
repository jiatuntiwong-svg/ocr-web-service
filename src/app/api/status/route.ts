import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";

export async function GET(request: NextRequest) {
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

        const doc = await env.DB.prepare("SELECT status, raw_json FROM documents WHERE id = ?")
            .bind(id)
            .first<{ status: string; raw_json: string }>();

        if (!doc) {
            return fail(ErrorCode.NOT_FOUND, { context: "status" });
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
