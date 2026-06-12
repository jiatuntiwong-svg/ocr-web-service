import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
    TIERS, FEATURES,
    loadTierCredits, loadFeatureFlags,
    sanitizeTierCredits, sanitizeFeatureFlags,
} from "@/lib/tier-config";
import { fail, ErrorCode } from "@/lib/apiResponse";

// Admin "Tier Control" API — manages per-tier feature toggles AND per-tier
// starting credit in one place.
//   GET  → current flags + credits + metadata
//   POST → save flags and/or credits

function getCaller(req: NextRequest): { id?: string; role?: string } | null {
    const token = req.cookies.get("session")?.value;
    if (!token) return null;
    try {
        return JSON.parse(decodeURIComponent(escape(atob(token)))) as { id?: string; role?: string };
    } catch {
        return null;
    }
}

async function saveSetting(env: any, key: string, value: unknown): Promise<void> {
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
    ).run();
    await env.DB.prepare(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, JSON.stringify(value)).run();
}

export async function GET(req: NextRequest) {
    if (getCaller(req)?.role !== "admin") {
        return fail(ErrorCode.UNAUTHORIZED, { context: "admin-tier" });
    }
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return NextResponse.json({ success: true, warning: "DB unavailable" });
        }
        const [credits, flags] = await Promise.all([
            loadTierCredits(env),
            loadFeatureFlags(env),
        ]);
        return NextResponse.json({
            success: true,
            tiers: TIERS,
            features: FEATURES,
            credits,
            flags,
        });
    } catch (error: any) {
        console.error("[Admin Tier-Config GET]", error);
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "admin-tier" });
    }
}

export async function POST(req: NextRequest) {
    if (getCaller(req)?.role !== "admin") {
        return fail(ErrorCode.UNAUTHORIZED, { context: "admin-tier" });
    }
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "admin-tier" });

        const body = await req.json() as { credits?: unknown; flags?: unknown };

        if (body.credits !== undefined) {
            await saveSetting(env, "TIER_CREDITS", sanitizeTierCredits(body.credits));
        }
        if (body.flags !== undefined) {
            await saveSetting(env, "FEATURE_FLAGS", sanitizeFeatureFlags(body.flags));
        }

        const [credits, flags] = await Promise.all([
            loadTierCredits(env),
            loadFeatureFlags(env),
        ]);
        return NextResponse.json({ success: true, credits, flags });
    } catch (error: any) {
        console.error("[Admin Tier-Config POST]", error);
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "admin-tier" });
    }
}
