import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireAdmin } from "@/lib/auth/guards";


export interface AIConfig {
    id: string;
    provider: string; // 'gemini' | 'vertex_ai' | 'openai' | 'openrouter'
    model: string;
    apiKey: string;
    label: string;
    isEnv?: boolean;
    isActive?: boolean;
}

export async function GET(req: NextRequest) {
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;

    try {
        const { env } = await getCloudflareContext();
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

        // 1. Get from Env (legacy support / base config)
        const envKey = (env as any).GEMINI_API_KEY || "";
        const envKeys = (env as any).GEMINI_API_KEYS || "";
        const envConfig: AIConfig[] = [];

        if (envKey) {
            envConfig.push({ id: 'env-gemini-single', provider: 'gemini', model: 'gemini-2.5-flash', apiKey: envKey, label: 'Environment Main Key', isEnv: true });
        }
        if (envKeys) {
            envKeys.split(",").forEach((k: string, i: number) => {
                if (k.trim()) envConfig.push({ id: `env-gemini-${i}`, provider: 'gemini', model: 'gemini-2.5-flash', apiKey: k.trim(), label: `Environment Key ${i + 1}`, isEnv: true });
            });
        }

        // 2. Get from DB
        const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'AI_POWER_CONFIG'").first<{ value: string }>();
        const dbConfig: AIConfig[] = row ? JSON.parse(row.value) : [];

        // Deduplicate: if an env key state is saved in DB, use the DB version
        const dbIds = new Set(dbConfig.map(c => c.id));
        const activeEnvConfig = envConfig.filter(c => !dbIds.has(c.id));

        const all = [...activeEnvConfig, ...dbConfig].map(c => ({
            ...c,
            isActive: c.isActive !== false // Default to true if undefined
        }));

        // Mask keys for frontend (BILL-1 tightening after /security-review 2026-07-09):
        // preserve only the fixed provider prefix + last 4 chars. The previous
        // `first6 + "...." + last4` variant leaked 2 non-prefix chars from AIza
        // keys and ~3 from sk-… keys. Now: `<prefix>...<last4>` where <prefix>
        // is `AIza`, `sk-`, `sk-or-`, or `••••` fallback — never key material.
        const maskApiKey = (raw: string): string => {
            if (!raw || raw.length <= 8) return "****";
            const last4 = raw.substring(raw.length - 4);
            const prefix = raw.startsWith("sk-or-") ? "sk-or-"
                : raw.startsWith("sk-")           ? "sk-"
                : raw.startsWith("AIza")          ? "AIza"
                : "••••";
            return `${prefix}...${last4}`;
        };
        const masked = all.map(c => ({ ...c, apiKey: maskApiKey(c.apiKey) }));

        return NextResponse.json({ configs: masked });
    } catch (err: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "admin-settings" });
    }
}

export async function POST(req: NextRequest) {
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;

    try {
        const { action, config } = await req.json() as { action: 'add' | 'remove' | 'update' | 'toggle', config: AIConfig };
        const { env } = await getCloudflareContext();

        const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'AI_POWER_CONFIG'").first<{ value: string }>();
        let current: AIConfig[] = row ? JSON.parse(row.value) : [];

        if (action === 'add') {
            current.push({ ...config, id: crypto.randomUUID() });
        } else if (action === 'remove') {
            current = current.filter(c => c.id !== config.id);
        } else if (action === 'update') {
            const index = current.findIndex(c => c.id === config.id);
            if (index !== -1) {
                // Update existing DB config
                const isMasked = config.apiKey.includes("....") || config.apiKey === "****";
                current[index] = {
                    ...config,
                    apiKey: isMasked ? current[index].apiKey : config.apiKey
                };
            } else if (config.id.startsWith('env-')) {
                // Converting an ENV config to a DB override
                // We need the ACTUAL key from Env because the frontend sent a masked one
                const envKey = (env as any).GEMINI_API_KEY || (env as any).GEMINI_API_KEYS || "";
                // Note: This assumes only one ENV key for simplicity or fetches from env
                // For better security/reliability, we'll use the masked key check
                const isMasked = config.apiKey.includes("....") || config.apiKey === "****";

                // If the user modified the key, use the new key. 
                // If they didn't, we'd need to fetch the real one from env to save it to DB.
                let realApiKey = config.apiKey;
                if (isMasked) {
                    // Try to find the real key from env bindings
                    if (config.provider === 'gemini') {
                        realApiKey = (env as any).GEMINI_API_KEY || (env as any).GEMINI_API_KEYS || config.apiKey;
                    }
                }

                current.push({
                    ...config,
                    id: crypto.randomUUID(), // Give it a new real ID in DB
                    apiKey: realApiKey
                });
            }
        } else if (action === 'toggle') {
            const index = current.findIndex(c => c.id === config.id);
            if (index !== -1) {
                // Update existing
                current[index].isActive = config.isActive;
            } else if (config.id.startsWith('env-')) {
                // Overriding ENV default
                let realApiKey = config.apiKey;
                const isMasked = config.apiKey.includes("....") || config.apiKey === "****";
                if (isMasked && config.provider === 'gemini') {
                     // Best effort fallback to original ENV if masked
                     realApiKey = (env as any).GEMINI_API_KEY || (env as any).GEMINI_API_KEYS || config.apiKey;
                }
                current.push({
                    ...config,
                    apiKey: realApiKey
                });
            }
        }

        await env.DB.prepare("INSERT INTO system_settings (key, value, updated_at) VALUES ('AI_POWER_CONFIG', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
            .bind(JSON.stringify(current))
            .run();

        return NextResponse.json({ success: true });
    } catch (err: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "admin-settings" });
    }
}
