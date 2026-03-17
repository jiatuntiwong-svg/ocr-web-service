import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
        return NextResponse.json({ error: "Missing document ID" }, { status: 400 });
    }

    try {
        const { env } = await getCloudflareContext();
        if (!env || !env.DB) {
            throw new Error("Database binding not found");
        }

        // ดึงสถานะปัจจุบันจากฐานข้อมูล
        const doc = await env.DB.prepare("SELECT status, raw_json FROM documents WHERE id = ?")
            .bind(id)
            .first<{ status: string; raw_json: string }>();

        if (!doc) {
            return NextResponse.json({ error: "Document not found" }, { status: 404 });
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

        return NextResponse.json({
            success: true,
            status: doc.status,
            data: data
        });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
