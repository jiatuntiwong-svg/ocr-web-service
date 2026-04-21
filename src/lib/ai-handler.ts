import { GoogleGenerativeAI } from "@google/generative-ai";

export async function getActiveAIConfigs(env: any): Promise<any[]> {
    const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'AI_POWER_CONFIG'").first() as { value: string } | null;
    const dbConfig = row ? JSON.parse(row.value) : [];

    const envKey = env.GEMINI_API_KEY || "";
    const envKeys = env.GEMINI_API_KEYS || "";
    const envConfig: any[] = [];

    if (envKey) envConfig.push({ id: 'env-gemini-single', provider: 'gemini', model: 'gemini-2.5-flash', apiKey: envKey, label: 'Environment Main Key', isEnv: true });
    if (envKeys) {
        envKeys.split(",").forEach((k: string, i: number) => {
            if (k.trim()) envConfig.push({ id: `env-gemini-${i}`, provider: 'gemini', model: 'gemini-2.5-flash', apiKey: k.trim(), label: `Environment Key ${i + 1}`, isEnv: true });
        });
    }

    const dbIds = new Set(dbConfig.map((c: any) => c.id));
    const activeEnvConfig = envConfig.filter(c => !dbIds.has(c.id));

    const all = [...activeEnvConfig, ...dbConfig].map(c => ({
        ...c,
        isActive: c.isActive !== false
    }));

    return all.filter(c => c.isActive);
}

export interface AIProviderRequest {
    provider: string;
    model: string;
    prompt: string;
    image?: { data: string; mimeType: string };
    images?: { data: string; mimeType: string }[];
    apiKeys: string[];
}

export async function generateWithAI(req: AIProviderRequest): Promise<string> {
    const { provider, model, prompt, image, images, apiKeys } = req;
    let lastError = null;
    const finalImages = images || (image ? [image] : []);

    for (const key of apiKeys) {
        try {
            if (provider === 'gemini') {
                return await generateGemini(key, model, prompt, finalImages);
            } else if (provider === 'openai') {
                return await generateOpenAI(key, model, prompt, finalImages);
            } else if (provider === 'openrouter') {
                return await generateOpenRouter(key, model, prompt, finalImages);
            }
        } catch (error: any) {
            console.warn(`Key failed for ${provider}/${model}:`, error.message);
            lastError = error;
            if (error.message?.includes("429") || error.message?.includes("quota")) continue;
            continue;
        }
    }

    throw new Error(`All keys failed for ${provider}. Last error: ${lastError?.message}`);
}

async function generateGemini(key: string, modelName: string, prompt: string, images: { data: string; mimeType: string }[]) {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: modelName });
    const imageParts = images.map(img => ({ inlineData: img }));
    const result = await model.generateContent([
        prompt,
        ...imageParts,
    ]);
    const response = await result.response;
    return response.text();
}

async function generateOpenAI(key: string, modelName: string, prompt: string, images: { data: string; mimeType: string }[]) {
    const contentPayload: any[] = [{ type: "text", text: prompt }];
    images.forEach(img => {
        contentPayload.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
    });

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                {
                    role: "user",
                    content: contentPayload
                }
            ],
            response_format: { type: "json_object" }
        })
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || "OpenAI Error");
    return data.choices[0].message.content;
}

async function generateOpenRouter(key: string, modelName: string, prompt: string, images: { data: string; mimeType: string }[]) {
    const contentPayload: any[] = [{ type: "text", text: prompt }];
    images.forEach(img => {
        contentPayload.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
    });

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
            "HTTP-Referer": "https://ocr-pro.com",
            "X-Title": "OCR Pro"
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                {
                    role: "user",
                    content: contentPayload
                }
            ]
        })
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || "OpenRouter Error");
    return data.choices[0].message.content;
}
