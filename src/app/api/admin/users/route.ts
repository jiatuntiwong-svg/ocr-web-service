import { NextRequest, NextResponse } from "next/server";
import { DEV_USERS, PLAN_LIMITS } from "@/lib/devUsers";
import { getCloudflareContext } from "@opennextjs/cloudflare";


// ── Verify caller is admin by reading their session cookie ──────────────────
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

// ── Try to get CF D1 env (returns null in next dev / if not bound) ───────────
async function getCFEnv() {
    try {
        const { env } = await getCloudflareContext();
        return env?.DB ? env : null;
    } catch {
        return null; // next dev has no CF context
    }
}

// ── Safely query custom limit (user_limits table may not exist yet) ──────────
async function safeGetCustomLimit(db: any, userId: string): Promise<number | null> {
    try {
        const row = await db
            .prepare("SELECT custom_limit FROM user_limits WHERE user_id = ?")
            .bind(userId)
            .first();
        return (row as any)?.custom_limit ?? null;
    } catch {
        // Table not yet migrated — treat as no custom limit
        return null;
    }
}

// ── Build enriched user row ──────────────────────────────────────────────────
function buildRow(u: { id: string; name: string; email: string; role: string; plan: string; credits_remaining?: number; extra_credits?: number }, totalDocs: number, customLimit: number | null) {
    const baseLimit = PLAN_LIMITS[u.plan?.toLowerCase()] ?? 50;
    const effectiveLimit = customLimit !== null ? customLimit : baseLimit;

    // Use stored credits if available, otherwise fallback to calculated docs-based limit
    const creditsRemaining = u.credits_remaining !== undefined
        ? (u.credits_remaining + (u.extra_credits || 0))
        : (effectiveLimit >= 999999 ? 999999 : Math.max(0, effectiveLimit - totalDocs));
    return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        plan: u.plan,
        totalDocs,
        customLimit,
        effectiveLimit,
        creditsRemaining,
    };
}

// ── GET /api/admin/users  ─ list all users with stats ──────────────────────
export async function GET(req: NextRequest) {
    const caller = getSessionUser(req);
    if (caller?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
        const env = await getCFEnv();

        if (!env) {
            // ── Dev-mode fallback: return DEV_USERS with zero doc counts ────
            const rows = DEV_USERS.map(u => buildRow(u, 0, null));
            return NextResponse.json(rows);
        }

        // ── Production: fetch from D1 ────────────────────────────────────────
        const usersResult = await env.DB
            .prepare("SELECT id, name, email, role, plan, credits_remaining, extra_credits FROM users ORDER BY created_at DESC")
            .all<{ id: string; name: string; email: string; role: string; plan: string; credits_remaining: number; extra_credits: number }>();

        const users = usersResult.results ?? [];

        const enriched = await Promise.all(users.map(async (u) => {
            const docsRow = await env.DB!
                .prepare("SELECT COUNT(*) as count FROM documents WHERE user_id = ?")
                .bind(u.id)
                .first<{ count: number }>();

            const totalDocs = docsRow?.count ?? 0;
            const customLimit = await safeGetCustomLimit(env.DB!, u.id);
            return buildRow(u, totalDocs, customLimit);
        }));

        return NextResponse.json(enriched);
    } catch (err: any) {
        console.error("[Admin Users GET]", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// ── PATCH /api/admin/users  ─ update credit limit, plan, or role ────────────
export async function PATCH(req: NextRequest) {
    const caller = getSessionUser(req);
    if (caller?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
        const body = await req.json() as {
            userId?: string;
            customLimit?: number | null;
            plan?: string;
            role?: string;
            password?: string;
            credits_remaining?: number;
        };
        const { userId, customLimit, plan, role, password, credits_remaining } = body;

        if (!userId) {
            return NextResponse.json({ error: "Missing userId" }, { status: 400 });
        }

        const VALID_PLANS = ["Free", "Starter", "Pro", "Enterprise", "System"];
        const VALID_ROLES = ["user", "admin"];

        if (plan && !VALID_PLANS.includes(plan)) {
            return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
        }
        if (role && !VALID_ROLES.includes(role)) {
            return NextResponse.json({ error: "Invalid role" }, { status: 400 });
        }

        const env = await getCFEnv();

        if (!env) {
            // Dev-mode: acknowledge without persisting
            return NextResponse.json({ success: true, dev: true });
        }

        try {
            if ("customLimit" in body) {
                if (customLimit === null || customLimit === undefined) {
                    await env.DB.prepare("DELETE FROM user_limits WHERE user_id = ?").bind(userId).run();
                } else {
                    await env.DB
                        .prepare(`INSERT INTO user_limits (user_id, custom_limit, updated_at)
                                  VALUES (?, ?, CURRENT_TIMESTAMP)
                                  ON CONFLICT(user_id) DO UPDATE
                                  SET custom_limit = excluded.custom_limit, updated_at = excluded.updated_at`)
                        .bind(userId, customLimit)
                        .run();
                }
            }

            if (plan) {
                await env.DB.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(plan, userId).run();
            }

            if (role) {
                await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, userId).run();
            }

            if (password) {
                await env.DB.prepare("UPDATE users SET password = ? WHERE id = ?").bind(password, userId).run();
            }

            if (credits_remaining !== undefined) {
                await env.DB.prepare("UPDATE users SET credits_remaining = ? WHERE id = ?").bind(credits_remaining, userId).run();
            }

        } catch (dbErr: any) {
            if (dbErr.message?.includes("no such table: user_limits")) {
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_limits (
                    user_id TEXT PRIMARY KEY,
                    custom_limit INTEGER,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`).run();
                if (customLimit !== null && customLimit !== undefined) {
                    await env.DB
                        .prepare(`INSERT INTO user_limits (user_id, custom_limit, updated_at)
                                  VALUES (?, ?, CURRENT_TIMESTAMP)
                                  ON CONFLICT(user_id) DO UPDATE
                                  SET custom_limit = excluded.custom_limit, updated_at = excluded.updated_at`)
                        .bind(userId, customLimit)
                        .run();
                }
            } else {
                throw dbErr;
            }
        }

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error("[Admin Users PATCH]", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
