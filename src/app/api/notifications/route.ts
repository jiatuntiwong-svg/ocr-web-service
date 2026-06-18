// Notifications read/update API.
//   GET  /api/notifications?userId=...&limit=50  → recent notifications + unread count
//   PATCH /api/notifications                     → { userId, id?, markAll? } mark read
//
// Writes happen server-side via src/lib/notifications.ts — there is no public
// POST. Callers (OCR finish, register, payment webhook, etc.) import the
// helper and write directly so we never expose "create arbitrary notification"
// to clients.

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";

interface NotificationRow {
    id: string;
    user_id: string;
    audience: string;
    kind: string;
    severity: string;
    title: string;
    body: string | null;
    link: string | null;
    metadata_json: string | null;
    read_at: string | null;
    created_at: string;
}

export async function GET(req: NextRequest) {
    try {
        const auth = await requireUser(req);
        if (auth instanceof Response) return auth;

        const { searchParams } = new URL(req.url);
        const requested = searchParams.get("userId") ?? auth.id;
        const cross = ensureCanActAs(auth, requested);
        if (cross) return cross;
        const userId = requested;

        const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 200);

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            // Dev-mode without DB: return empty list so the bell still renders.
            return ok({ success: true, notifications: [], unreadCount: 0 });
        }

        const list = await env.DB
            .prepare(
                `SELECT id, user_id, audience, kind, severity, title, body, link, metadata_json, read_at, created_at
                 FROM notifications
                 WHERE user_id = ?
                 ORDER BY created_at DESC
                 LIMIT ?`,
            )
            .bind(userId, limit)
            .all<NotificationRow>();

        const unread = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL")
            .bind(userId)
            .first<{ n: number }>();

        return ok({
            success: true,
            notifications: list.results.map((r) => ({
                id: r.id,
                audience: r.audience,
                kind: r.kind,
                severity: r.severity,
                title: r.title,
                body: r.body,
                link: r.link,
                metadata: r.metadata_json ? safeParse(r.metadata_json) : null,
                readAt: r.read_at,
                createdAt: r.created_at,
            })),
            unreadCount: unread?.n ?? 0,
        });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "notifications" });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const auth = await requireUser(req);
        if (auth instanceof Response) return auth;

        const body = await req.json() as { userId?: string; id?: string; markAll?: boolean };
        const requested = body.userId ?? auth.id;
        const cross = ensureCanActAs(auth, requested);
        if (cross) return cross;
        if (!body.id && !body.markAll) {
            return fail(ErrorCode.BAD_REQUEST, { detail: "id or markAll required", context: "notifications" });
        }
        // Reassign so downstream queries scope to the verified user, never the body.
        body.userId = requested;

        const { env } = await getCloudflareContext();
        if (!env?.DB) return ok({ success: true });

        // user_id in WHERE prevents users from marking others' notifications.
        if (body.markAll) {
            await env.DB
                .prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL")
                .bind(body.userId)
                .run();
        } else {
            await env.DB
                .prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND read_at IS NULL")
                .bind(body.id, body.userId)
                .run();
        }

        return ok({ success: true });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "notifications" });
    }
}

function safeParse(s: string): unknown {
    try { return JSON.parse(s); } catch { return null; }
}
