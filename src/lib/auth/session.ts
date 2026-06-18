// HMAC-signed session tokens. Replaces the old `btoa(JSON.stringify(...))`
// scheme that let anyone craft an admin session by editing the cookie.
//
// Token shape:        <base64url(payloadJson)>.<base64url(HMAC-SHA256(secret, base64Payload))>
// Payload:            { id, name, email, role, plan, ts }
// Verification rules: signature matches AND token age < 7 days.
//
// Anything outside that contract returns null — caller treats null as "no
// session". Tokens from before this code shipped were unsigned, so they will
// not pass verification and will be rejected; users will need to log in
// again once.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";

export interface SessionUser {
    id: string;
    name: string;
    email: string;
    role: string;
    plan: string;
}

interface TokenPayload extends SessionUser {
    /** issued-at, ms since epoch */
    ts: number;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = "session";

// ─── Secret ─────────────────────────────────────────────────────────────────
// Cloudflare bindings live on `env`. `SESSION_SECRET` is a wrangler secret in
// production and a .dev.vars entry locally. We DO NOT fall back to a default
// — running without a secret would silently accept any token, which is the
// exact failure mode we're trying to fix.
async function getSecret(): Promise<string> {
    const { env } = await getCloudflareContext();
    const secret = (env as unknown as { SESSION_SECRET?: string })?.SESSION_SECRET;
    if (!secret || secret.length < 16) {
        throw new Error(
            "SESSION_SECRET is missing or too short. Set it in .dev.vars locally and " +
            "via `npx wrangler secret put SESSION_SECRET` in production.",
        );
    }
    return secret;
}

// ─── base64url helpers (URL-safe, no padding) ──────────────────────────────
function bytesToBase64Url(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function hmac(secret: string, data: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return bytesToBase64Url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function makeSessionToken(user: SessionUser): Promise<string> {
    const payload: TokenPayload = { ...user, ts: Date.now() };
    const payloadJson = JSON.stringify(payload);
    const payloadB64 = bytesToBase64Url(new TextEncoder().encode(payloadJson));
    const secret = await getSecret();
    const sig = await hmac(secret, payloadB64);
    return `${payloadB64}.${sig}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<TokenPayload | null> {
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    let secret: string;
    try { secret = await getSecret(); } catch { return null; }

    const expectedSig = await hmac(secret, payloadB64);
    if (!timingSafeEqual(expectedSig, sig)) return null;

    let payload: TokenPayload;
    try {
        const json = new TextDecoder().decode(base64UrlToBytes(payloadB64));
        payload = JSON.parse(json) as TokenPayload;
    } catch { return null; }

    if (!payload || typeof payload.ts !== "number") return null;
    if (Date.now() - payload.ts > SESSION_TTL_MS) return null;
    if (!payload.id || !payload.email) return null;
    return payload;
}

/** Returns the verified session user, or null if there is no valid session. */
export async function getSessionUser(req: NextRequest): Promise<SessionUser | null> {
    const cookie = req.cookies.get(SESSION_COOKIE_NAME);
    const payload = await verifySessionToken(cookie?.value);
    if (!payload) return null;
    const { ts: _ts, ...user } = payload;
    return user;
}

/** True when the session user is the same as the requested userId, or an admin. */
export function canActAs(session: SessionUser, requestedUserId: string): boolean {
    return session.id === requestedUserId || session.role === "admin";
}
