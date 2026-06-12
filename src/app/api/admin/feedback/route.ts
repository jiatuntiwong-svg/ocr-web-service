// Admin feedback triage API.
//   GET   → list feedback with submitter info + counts per status
//   PATCH → update status / admin_note (records who resolved + when)

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";

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

const ALLOWED_STATUSES = new Set(["new", "in_progress", "resolved"]);

export async function GET(req: NextRequest) {
    const caller = getSessionUser(req);
    if (caller?.role !== "admin") {
        return fail(ErrorCode.UNAUTHORIZED, { context: "admin-feedback" });
    }
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "admin-feedback" });
        }

        const rows = await env.DB.prepare(
            `SELECT f.id, f.user_id, f.category, f.message, f.status,
                    f.page_url, f.user_agent, f.admin_note,
                    f.resolved_by, f.resolved_at, f.created_at,
                    u.name AS user_name, u.email AS user_email,
                    r.name AS resolver_name
             FROM feedback f
             LEFT JOIN users u ON u.id = f.user_id
             LEFT JOIN users r ON r.id = f.resolved_by
             ORDER BY
                CASE f.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                f.created_at DESC
             LIMIT 500`,
        ).all();

        const counts = await env.DB.prepare(
            `SELECT status, COUNT(*) AS n FROM feedback GROUP BY status`,
        ).all<{ status: string; n: number }>();
        const byStatus: Record<string, number> = { new: 0, in_progress: 0, resolved: 0 };
        for (const r of counts.results || []) byStatus[r.status] = r.n;

        return ok({ success: true, items: rows.results || [], counts: byStatus });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "admin-feedback" });
    }
}

export async function PATCH(req: NextRequest) {
    const caller = getSessionUser(req);
    if (caller?.role !== "admin" || !caller.id) {
        return fail(ErrorCode.UNAUTHORIZED, { context: "admin-feedback" });
    }
    try {
        const body = await req.json() as {
            id?: string;
            status?: string;
            adminNote?: string;
        };
        if (!body.id) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "admin-feedback" });
        }
        if (body.status && !ALLOWED_STATUSES.has(body.status)) {
            return fail(ErrorCode.BAD_REQUEST, { detail: "invalid status", context: "admin-feedback" });
        }

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "admin-feedback" });
        }

        // Build dynamic update — only touch the fields the caller provided.
        const sets: string[] = [];
        const binds: any[] = [];
        if (body.status) {
            sets.push("status = ?");
            binds.push(body.status);
            if (body.status === "resolved") {
                sets.push("resolved_by = ?", "resolved_at = CURRENT_TIMESTAMP");
                binds.push(caller.id);
            } else {
                // Re-opening clears the resolution stamp so the audit trail
                // doesn't lie about when the work actually closed.
                sets.push("resolved_by = NULL", "resolved_at = NULL");
            }
        }
        if (typeof body.adminNote === "string") {
            sets.push("admin_note = ?");
            binds.push(body.adminNote.slice(0, 2000));
        }
        if (sets.length === 0) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "admin-feedback" });
        }
        binds.push(body.id);

        const result = await env.DB.prepare(
            `UPDATE feedback SET ${sets.join(", ")} WHERE id = ?`,
        ).bind(...binds).run();
        const changed = (result as any)?.meta?.changes ?? 0;
        if (changed === 0) {
            return fail(ErrorCode.NOT_FOUND, { context: "admin-feedback" });
        }
        return ok({ success: true });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "admin-feedback" });
    }
}
