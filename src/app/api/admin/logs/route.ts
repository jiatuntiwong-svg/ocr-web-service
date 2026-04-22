import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";



function getSessionUser(req: NextRequest): { id?: string; role?: string } | null {
    const token = req.cookies.get("session")?.value;
    if (!token) return null;

    try {
        const json = decodeURIComponent(escape(atob(token)));
        return JSON.parse(json) as { id?: string; role?: string };
    } catch {
        return null;
    }
}

async function getCFEnv() {
    try {
        const { env } = await getCloudflareContext();
        return env?.DB ? env : null;
    } catch {
        return null;
    }
}

export async function GET(req: NextRequest) {
    const caller = getSessionUser(req);
    if (caller?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
        const env = await getCFEnv();
        if (!env) {
            return NextResponse.json({ success: true, logs: [], warning: "Cloudflare DB context unavailable" });
        }

        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                action TEXT,
                details TEXT,
                level TEXT DEFAULT 'info',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `).run();

        const { results } = await env.DB.prepare(`
            SELECT l.*, u.email AS user_email, u.name AS user_name
            FROM system_logs l
            LEFT JOIN users u ON l.user_id = u.id
            ORDER BY l.created_at DESC
            LIMIT 100
        `).all();

        return NextResponse.json({ success: true, logs: results || [] });
    } catch (error: any) {
        console.error("[Admin Logs GET]", error);
        return NextResponse.json({ success: false, error: error.message || "Failed to fetch logs" }, { status: 500 });
    }
}
