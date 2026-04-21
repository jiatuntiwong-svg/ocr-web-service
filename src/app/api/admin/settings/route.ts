import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";


export interface AIConfig {
    id: string;
    provider: string; // 'gemini' | 'openai' | 'openrouter'
    model: string;
    apiKey: string;
    label: string;
    isEnv?: boolean;
    isActive?: boolean;
}

export async function GET(req: NextRequest) {
    const token = req.cookies.get("session")?.value;
    let caller: { id?: string; role?: string } | null = null;
    if (token) {
        try {
            const json = decodeURIComponent(escape(atob(token)));
            caller = JSON.parse(json) as { id?: string; role?: string };
        } catch {
            caller = null;
        }
    }

    if (caller?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

        // Mask keys for frontend
        const masked = all.map(c => ({
            ...c,
            apiKey: c.apiKey.length > 8 ? c.apiKey.substring(0, 6) + "...." + c.apiKey.substring(c.apiKey.length - 4) : "****"
        }));

        return NextResponse.json({ configs: masked });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const token = req.cookies.get("session")?.value;
    let caller: { id?: string; role?: string } | null = null;
    if (token) {
        try {
            const json = decodeURIComponent(escape(atob(token)));
            caller = JSON.parse(json) as { id?: string; role?: string };
        } catch {
            caller = null;
        }
    }

    if (caller?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
