import { NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const userId = searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const db = (process.env as any).DB;

        // Verify admin role
        const userCheck = await db.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first();
        if (!userCheck || userCheck.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Auto-create table if it doesn't exist
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                action TEXT,
                details TEXT,
                level TEXT DEFAULT 'info',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `).run();

        const { results } = await db.prepare(`
            SELECT l.*, u.email as user_email, u.name as user_name
            FROM system_logs l
            LEFT JOIN users u ON l.user_id = u.id
            ORDER BY l.created_at DESC
            LIMIT 100
        `).all();

        return NextResponse.json({ success: true, logs: results || [] });

    } catch (error: any) {
        console.error("Fetch Logs Error:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
