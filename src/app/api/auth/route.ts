import { NextRequest, NextResponse } from "next/server";
import { DEV_USERS } from "@/lib/devUsers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logSystemEvent } from "@/lib/logger";


type UserPayload = { id: string; name: string; email: string; role: string; plan: string; ts: number };

function makeToken(user: Omit<UserPayload, "ts">): string {
    return btoa(unescape(encodeURIComponent(JSON.stringify({ ...user, ts: Date.now() }))));
}

function parseToken(token: string): UserPayload | null {
    try {
        const json = decodeURIComponent(escape(atob(token)));
        const payload = JSON.parse(json) as UserPayload;
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        if (Date.now() - payload.ts > sevenDays) return null;
        return payload;
    } catch {
        return null;
    }
}

// ─── Try to get Cloudflare D1 (only works under wrangler dev / production) ───
async function queryUserFromDB(email: string, password?: string) {
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) throw new Error("no DB binding");

        const query = password
            ? "SELECT id, name, email, role, plan FROM users WHERE email = ? AND password = ? LIMIT 1"
            : "SELECT id, name, email, role, plan FROM users WHERE email = ? LIMIT 1";

        const stmt = env.DB.prepare(query);
        const row = await (password ? stmt.bind(email, password) : stmt.bind(email)).first<{ id: string; name: string; email: string; role: string; plan: string }>();
        return row ?? null;
    } catch {
        return undefined;
    }
}

function setSessionCookie(response: NextResponse, token: string) {
    response.cookies.set("session", token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7,
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
            return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
        }

        // 1. Try Cloudflare D1
        const dbUser = await queryUserFromDB(email, password);

        let foundUser: { id: string; name: string; email: string; role: string; plan: string } | null = null;

        if (dbUser !== undefined) {
            // CF D1 was reachable — use its result (may be null if wrong credentials)
            foundUser = dbUser;
        } else {
            // Fallback to hardcoded dev accounts
            const match = DEV_USERS.find(u => u.email === email && u.password === password);
            foundUser = match ? { id: match.id, name: match.name, email: match.email, role: match.role, plan: match.plan } : null;
        }

        if (!foundUser) {
            // Log failed login attempt
            try {
                const { env } = await getCloudflareContext();
                if (env) await logSystemEvent(env, "LOGIN_FAILED", `Failed login attempt for: ${email}`, "warning");
            } catch {}
            return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
        }

        // Log successful login
        try {
            const { env } = await getCloudflareContext();
            if (env) await logSystemEvent(env, "LOGIN_SUCCESS", `User logged in: ${foundUser.email}`, "info", foundUser.id);
        } catch {}

        const token = makeToken(foundUser);
        const response = NextResponse.json({ success: true, user: foundUser });
        setSessionCookie(response, token);
        return response;
    } catch (err: any) {
        console.error("[Auth POST] error:", err);
        return NextResponse.json({ error: err.message ?? "Login failed" }, { status: 500 });
    }
}

// ─── GET /api/auth  → Get current session ────────────────────────────────────
export async function GET(req: NextRequest) {
    const cookie = req.cookies.get("session");
    if (!cookie?.value) {
        return NextResponse.json({ user: null }, { status: 401 });
    }
    const payload = parseToken(cookie.value);
    if (!payload) {
        const res = NextResponse.json({ user: null }, { status: 401 });
        res.cookies.delete("session");
        return res;
    }

    // ── Check DB first even for dev users to allow plan updates ──────
    const dbUser = await queryUserFromDB(payload.email, ""); // We trust the token's email
    if (dbUser) {
        return NextResponse.json({ user: dbUser });
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
        const cookie = req.cookies.get("session");
        if (cookie?.value) {
            const payload = parseToken(cookie.value);
            if (payload) {
                const { env } = await getCloudflareContext();
                if (env) await logSystemEvent(env, "LOGOUT", `User logged out: ${payload.email}`, "info", payload.id);
            }
        }
    } catch {}
    const response = NextResponse.json({ success: true });
    response.cookies.delete("session");
    return response;
}
