import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";

// Lists a user's documents (newest first) for the dashboard "View All".
// Same row shape as /api/stats `recentActivity` so the UI can reuse it.
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const userId = searchParams.get("userId");
        const limitRaw = Number(searchParams.get("limit"));
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 100;
        const search = (searchParams.get("search") || "").trim();
        const type = (searchParams.get("type") || "").trim().toLowerCase(); // "ocr" | "compare" | ""

        if (!userId) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "documents" });
        }

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return NextResponse.json({ success: true, documents: [] });
        }

        // Build WHERE clause dynamically so optional filters can stack.
        const whereParts: string[] = ["user_id = ?"];
        const bindings: (string | number)[] = [userId];
        if (search) {
            whereParts.push("LOWER(file_name) LIKE ?");
            bindings.push("%" + search.toLowerCase() + "%");
        }
        if (type === "ocr") whereParts.push("(COALESCE(type,'ocr') = 'ocr')");
        else if (type === "compare") whereParts.push("(type = 'compare')");
        bindings.push(limit);

        const { results } = await env.DB.prepare(
            `SELECT id, file_name AS name, status, created_at, raw_json,
                    COALESCE(type,'ocr') AS type,
                    reviewed_at, reviewed_by
             FROM documents WHERE ${whereParts.join(" AND ")}
             ORDER BY created_at DESC LIMIT ?`
        ).bind(...bindings).all();

        const documents = (results || []).map((doc: any) => {
            let parsedJson = null;
            try {
                if (doc.raw_json) parsedJson = JSON.parse(doc.raw_json as string);
            } catch {
                /* ignore malformed json */
            }
            return {
                id: doc.id as string,
                name: doc.name as string,
                status: doc.status as string,
                time: doc.created_at as string,
                confidence: doc.status === "completed" ? 95 : 0,
                template: "Auto",
                pages: 1,
                type: (doc.type as string) || "ocr",
                data_extracted: parsedJson,
                reviewedAt: (doc.reviewed_at as string) || null,
                reviewedBy: (doc.reviewed_by as string) || null,
            };
        });

        return NextResponse.json({ success: true, documents });
    } catch (err: any) {
        console.error("[Documents GET] error:", err);
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "documents" });
    }
}
