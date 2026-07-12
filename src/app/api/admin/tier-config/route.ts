import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
    TIERS, FEATURES,
    loadTierCredits, loadFeatureFlags,
    sanitizeTierCredits, sanitizeFeatureFlags,
} from "@/lib/tier-config";
import { CREDIT_MODELS, getActiveCreditModel, sanitizeCreditModel } from "@/lib/pricing";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireAdmin } from "@/lib/auth/guards";

// Admin "Tier Control" API — manages per-tier feature toggles AND per-tier
// starting credit in one place.
//   GET  → current flags + credits + metadata
//   POST → save flags and/or credits

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
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return NextResponse.json({ success: true, warning: "DB unavailable" });
        }
        const [credits, flags, creditModel] = await Promise.all([
            loadTierCredits(env),
            loadFeatureFlags(env),
            getActiveCreditModel(env),
        ]);
        return NextResponse.json({
            success: true,
            tiers: TIERS,
            features: FEATURES,
            credits,
            flags,
            // BILL-1: expose active OCR credit model + valid options so the
            // admin UI can render a switch without needing a separate endpoint.
            credit_model: creditModel,
            credit_models: CREDIT_MODELS,
        });
    } catch (error: any) {
        console.error("[Admin Tier-Config GET]", error);
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "admin-tier" });
    }
}

export async function POST(req: NextRequest) {
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "admin-tier" });

        const body = await req.json() as { credits?: unknown; flags?: unknown; credit_model?: unknown };

        if (body.credits !== undefined) {
            await saveSetting(env, "TIER_CREDITS", sanitizeTierCredits(body.credits));
        }
        if (body.flags !== undefined) {
            await saveSetting(env, "FEATURE_FLAGS", sanitizeFeatureFlags(body.flags));
        }
        if (body.credit_model !== undefined) {
            // BILL-1: sanitize down to the known slug set so an admin can't
            // wedge a typo into the config (would silently fall back to
            // default anyway, but noise in the log is worse).
            await saveSetting(env, "CREDIT_MODEL", sanitizeCreditModel(body.credit_model));
        }

        const [credits, flags, creditModel] = await Promise.all([
            loadTierCredits(env),
            loadFeatureFlags(env),
            getActiveCreditModel(env),
        ]);
        return NextResponse.json({ success: true, credits, flags, credit_model: creditModel });
    } catch (error: any) {
        console.error("[Admin Tier-Config POST]", error);
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "admin-tier" });
    }
}
