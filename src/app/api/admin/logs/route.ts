import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireAdmin } from "@/lib/auth/guards";


async function getCFEnv() {
    try {
        const { env } = await getCloudflareContext();
        return env?.DB ? env : null;
    } catch {
        return null;
    }
}

export async function GET(req: NextRequest) {
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;

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
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "admin-logs" });
    }
}
