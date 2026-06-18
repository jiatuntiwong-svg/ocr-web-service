import { NextRequest, NextResponse } from "next/server";
import { DEV_USERS } from "@/lib/devUsers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logSystemEvent } from "@/lib/logger";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { verifyPassword, hashPassword, isHashed } from "@/lib/passwordHash";
import { broadcastToAdmins, wasNotifiedRecently } from "@/lib/notifications";
import {
    makeSessionToken,
    verifySessionToken,
    SESSION_COOKIE_NAME,
    SESSION_TTL_MS,
} from "@/lib/auth/session";

// Returns:
//   row    — user found
//   null   — DB reachable, no such user
//   undefined — DB not reachable (caller falls back to DEV_USERS)
async function lookupUserByEmail(email: string) {
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) throw new Error("no DB binding");
        const row = await env.DB
            .prepare("SELECT id, name, email, role, plan, password FROM users WHERE email = ? LIMIT 1")
            .bind(email)
            .first<{ id: string; name: string; email: string; role: string; plan: string; password: string }>();
        return row ?? null;
    } catch {
        return undefined;
    }
}

// One-way migration: any legacy plaintext password we successfully verify gets
// rewritten as a real PBKDF2 hash. Best-effort — failures here must not block
// the login that just succeeded.
async function upgradeLegacyPassword(userId: string, plain: string) {
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) return;
        const newHash = await hashPassword(plain);
        await env.DB.prepare("UPDATE users SET password = ? WHERE id = ?").bind(newHash, userId).run();
    } catch {}
}

function setSessionCookie(response: NextResponse, token: string) {
    response.cookies.set(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        path: "/",
    });
}

// ─── POST /api/auth  → Login ─────────────────────────────────────────────────
export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as { email?: string; password?: string };
        const email = body.email?.toLowerCase().trim() ?? "";
        const password = body.password ?? "";

        if (!email || !password) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "auth-login" });
        }

        // 1. Try Cloudflare D1
        const dbRow = await lookupUserByEmail(email);

        let foundUser: { id: string; name: string; email: string; role: string; plan: string } | null = null;

        if (dbRow === undefined) {
            // DB unreachable — fall back to hardcoded dev accounts (plaintext compare is fine,
            // these are well-known dev creds not real user data).
            const match = DEV_USERS.find(u => u.email === email && u.password === password);
            foundUser = match ? { id: match.id, name: match.name, email: match.email, role: match.role, plan: match.plan } : null;
        } else if (dbRow !== null) {
            const valid = await verifyPassword(password, dbRow.password);
            if (valid) {
                foundUser = { id: dbRow.id, name: dbRow.name, email: dbRow.email, role: dbRow.role, plan: dbRow.plan };
                if (!isHashed(dbRow.password)) {
                    await upgradeLegacyPassword(dbRow.id, password);
                }
            }
        }

        if (!foundUser) {
            // Log failed login attempt + admin notification on spike (5+ failures
            // in last 10min). Dedup via wasNotifiedRecently so we don't fire
            // every subsequent failure once the threshold is crossed.
            try {
                const { env } = await getCloudflareContext();
                if (env) {
                    await logSystemEvent(env, "LOGIN_FAILED", `Failed login attempt for: ${email}`, "warning");
                    try {
                        const recent = await env.DB.prepare(
                            "SELECT COUNT(*) AS n FROM system_logs WHERE action = 'LOGIN_FAILED' AND created_at > datetime('now', '-10 minutes')",
                        ).first<{ n: number }>();
                        if ((recent?.n ?? 0) >= 5) {
                            // Use one admin row as the dedup key — any admin getting this
                            // notification recently means all admins already got it.
                            const anyAdmin = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first<{ id: string }>();
                            if (anyAdmin && !(await wasNotifiedRecently(env, anyAdmin.id, "login_fail_spike", 10))) {
                                await broadcastToAdmins(env, {
                                    kind: "login_fail_spike",
                                    severity: "warning",
                                    title: "Login failure spike",
                                    body: `${recent!.n} failed logins in the last 10 minutes`,
                                    link: "/admin_logs",
                                    metadata: { count: recent!.n, windowMinutes: 10 },
                                });
                            }
                        }
                    } catch {}
                }
            } catch {}
            return fail(ErrorCode.LOGIN_FAILED, { context: "auth-login" });
        }

        // Log successful login
        try {
            const { env } = await getCloudflareContext();
            if (env) await logSystemEvent(env, "LOGIN_SUCCESS", `User logged in: ${foundUser.email}`, "info", foundUser.id);
        } catch {}

        const token = await makeSessionToken(foundUser);
        const response = ok({ user: foundUser, success: true });
        setSessionCookie(response, token);
        return response;
    } catch (err: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "auth-login" });
    }
}

// ─── GET /api/auth  → Get current session ────────────────────────────────────
export async function GET(req: NextRequest) {
    const cookie = req.cookies.get(SESSION_COOKIE_NAME);
    if (!cookie?.value) {
        return NextResponse.json({ user: null }, { status: 401 });
    }
    const payload = await verifySessionToken(cookie.value);
    if (!payload) {
        const res = NextResponse.json({ user: null }, { status: 401 });
        res.cookies.delete(SESSION_COOKIE_NAME);
        return res;
    }

    // ── Check DB first even for dev users to allow plan updates ──────
    const dbRow = await lookupUserByEmail(payload.email); // We trust the token's email
    if (dbRow) {
        const { password: _pw, ...safe } = dbRow;
        return NextResponse.json({ user: safe });
    }

    // ── Fallback to DEV_USERS if not found in DB ──────────────────
    const devUser = DEV_USERS.find(u => u.email === payload.email);
    if (devUser) {
        return NextResponse.json({
            user: { id: devUser.id, name: devUser.name, email: devUser.email, role: devUser.role, plan: devUser.plan }
        });
    }

    // ── Production: trust the token (DB-backed users) ────────────────────────
    return NextResponse.json({
        user: { id: payload.id, name: payload.name, email: payload.email, role: payload.role, plan: payload.plan },
    });
}

// ─── DELETE /api/auth  → Logout ──────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
    // Log logout
    try {
        const cookie = req.cookies.get(SESSION_COOKIE_NAME);
        if (cookie?.value) {
            const payload = await verifySessionToken(cookie.value);
            if (payload) {
                const { env } = await getCloudflareContext();
                if (env) await logSystemEvent(env, "LOGOUT", `User logged out: ${payload.email}`, "info", payload.id);
            }
        }
    } catch {}
    const response = NextResponse.json({ success: true });
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
}
