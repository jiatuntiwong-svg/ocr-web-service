// Per-tier STARTING credit configuration.
//
// Model: a user's `credits_total` is STAMPED from this config at the moment
// of registration (and on a Stripe plan change). It is never moved
// retroactively — the dashboard `limit` reads each user's own
// `credits_total`, so editing this config later affects only NEW users.
//
// Stored in system_settings under key TIER_CREDITS; defaults to the historical
// PLAN_LIMITS values so behaviour is unchanged until an admin edits them.
import { PLAN_LIMITS } from "./devUsers";

export const TIERS = ["free", "starter", "pro", "enterprise"] as const;
export type Tier = typeof TIERS[number];

export type TierCredits = Record<string, number>;

export const DEFAULT_TIER_CREDITS: TierCredits = {
    free: PLAN_LIMITS.free,             // 50
    starter: PLAN_LIMITS.starter,       // 500
    pro: PLAN_LIMITS.pro,               // 1000
    enterprise: PLAN_LIMITS.enterprise, // 999999
};

const UNLIMITED = 999999;

function sanitize(obj: any): TierCredits {
    const out: TierCredits = {};
    if (obj && typeof obj === "object") {
        for (const t of TIERS) {
            const n = Number(obj[t]);
            if (Number.isFinite(n) && n >= 0) out[t] = Math.round(n);
        }
    }
    return out;
}

/** Sanitize an incoming credit map for saving (keeps finite, non-negative). */
export function sanitizeTierCredits(obj: any): TierCredits {
    return { ...DEFAULT_TIER_CREDITS, ...sanitize(obj) };
}

/** Load the per-tier credit map (defaults merged in). Never throws. */
export async function loadTierCredits(env: any): Promise<TierCredits> {
    try {
        if (!env?.DB) return { ...DEFAULT_TIER_CREDITS };
        await env.DB.prepare(
            `CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
        ).run();
        const row: any = await env.DB.prepare(
            "SELECT value FROM system_settings WHERE key = 'TIER_CREDITS'"
        ).first();
        const stored = row ? JSON.parse(row.value) : {};
        return { ...DEFAULT_TIER_CREDITS, ...sanitize(stored) };
    } catch {
        return { ...DEFAULT_TIER_CREDITS };
    }
}

/**
 * Starting credit for a plan (case-insensitive). admin / system plans — and
 * any unknown plan — fall back to the unlimited sentinel so they keep
 * "Unlimited" status.
 */
export function creditForPlan(credits: TierCredits, plan?: string): number {
    const key = (plan || "free").toLowerCase();
    if (key === "system" || key === "admin") return UNLIMITED;
    return credits[key] ?? credits.free ?? DEFAULT_TIER_CREDITS.free;
}

// ─── Feature flags ─────────────────────────────────────────────────────────
// Per-tier on/off switches for the three main functions. Stored in
// system_settings under FEATURE_FLAGS as { tier: { feature: boolean } }.
// An UNSET flag defaults to ON, so enabling this system never silently
// disables anything — an admin opts INTO restricting.

export const FEATURES = [
    { key: "ocr", label: "OCR" },
    { key: "compare", label: "Compare" },
    { key: "public_api", label: "Public API" },
] as const;

export type FeatureKey = "ocr" | "compare" | "public_api";

export type FeatureFlags = Record<string, Record<string, boolean>>;
export type ResolvedFeatures = Record<FeatureKey, boolean>;

const ALL_ON: ResolvedFeatures = { ocr: true, compare: true, public_api: true };

/** Load the per-tier feature-flag matrix. Never throws. */
export async function loadFeatureFlags(env: any): Promise<FeatureFlags> {
    try {
        if (!env?.DB) return {};
        await env.DB.prepare(
            `CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
        ).run();
        const row: any = await env.DB.prepare(
            "SELECT value FROM system_settings WHERE key = 'FEATURE_FLAGS'"
        ).first();
        return row ? (JSON.parse(row.value) as FeatureFlags) : {};
    } catch {
        return {};
    }
}

/**
 * Resolve the effective on/off of every feature for a plan. admin / system
 * bypass all flags. An unset flag is ON.
 */
export function resolveFeatures(flags: FeatureFlags, plan?: string): ResolvedFeatures {
    const key = (plan || "free").toLowerCase();
    if (key === "system" || key === "admin") return { ...ALL_ON };
    const t = flags[key] || {};
    return {
        ocr: t.ocr !== false,
        compare: t.compare !== false,
        public_api: t.public_api !== false,
    };
}

export function isFeatureEnabled(flags: FeatureFlags, plan: string | undefined, feature: FeatureKey): boolean {
    return resolveFeatures(flags, plan)[feature];
}

/** Keep only known tiers/features with boolean values (POST sanitizer). */
export function sanitizeFeatureFlags(obj: any): FeatureFlags {
    const out: FeatureFlags = {};
    if (obj && typeof obj === "object") {
        for (const t of TIERS) {
            const row = obj[t];
            if (row && typeof row === "object") {
                out[t] = {};
                for (const f of FEATURES) {
                    out[t][f.key] = row[f.key] !== false;
                }
            }
        }
    }
    return out;
}
