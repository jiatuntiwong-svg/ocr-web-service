import { GoogleGenerativeAI } from "@google/generative-ai";
import { redactSecrets } from "./redactSecrets";

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
    /**
     * Optional Vertex AI Express-Mode region. Express Mode uses the global
     * endpoint (`aiplatform.googleapis.com`) by default; only set this when
     * the caller has a region-scoped Express key. Ignored by non-vertex
     * providers.
     */
    location?: string;
    /**
     * OCR-3: sampling temperature for the AI call. When omitted, providers
     * keep their pre-existing deterministic-ish default (0.0). Set to 0.6
     * by the retry path so a "stuck" deterministic answer gets a fresh
     * decode. Threaded uniformly through Gemini, Vertex, OpenAI and
     * OpenRouter — if a new provider is added, it MUST honour this or the
     * retry becomes fake.
     */
    temperature?: number;
}

// Token usage returned alongside the AI text so callers can record the real
// input/output token cost per request (for the admin AI-usage dashboard).
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface AIResult {
    text: string;
    usage: TokenUsage;
    /**
     * OCR-3: echoes the retry flag back to the caller so downstream logging
     * (ai_usage.is_retry) can tag the row without the route having to keep
     * a separate boolean around the AI call.
     */
    isRetry?: boolean;
}

export async function generateWithAI(req: AIProviderRequest): Promise<AIResult> {
    const { provider, model, prompt, image, images, apiKeys, location, temperature } = req;
    // OCR-3: default 0.0 preserves today's byte-identical behavior when the
    // caller omits `temperature`. Only the retry path sets 0.6.
    const temp = typeof temperature === "number" ? temperature : 0;
    const isRetry = temp > 0;
    let lastError: Error | null = null;
    const finalImages = images || (image ? [image] : []);

    for (const key of apiKeys) {
        try {
            let out: AIResult;
            if (provider === 'gemini') {
                out = await generateGemini(key, model, prompt, finalImages, temp);
            } else if (provider === 'vertex_ai') {
                out = await generateVertexAI(key, model, prompt, finalImages, location, temp);
            } else if (provider === 'openai') {
                out = await generateOpenAI(key, model, prompt, finalImages, temp);
            } else if (provider === 'openrouter') {
                out = await generateOpenRouter(key, model, prompt, finalImages, temp);
            } else {
                continue;
            }
            if (isRetry) out.isRetry = true;
            return out;
        } catch (error: any) {
            // AI-1 SEC-3: provider error messages may contain the key (URL echo,
            // header dump, etc.) — never let a raw error hit any log line.
            const safeMsg = redactSecrets(error?.message || error);
            console.warn(`Key failed for ${provider}/${model}: ${safeMsg}`);
            lastError = new Error(safeMsg);
            if (safeMsg.includes("429") || safeMsg.includes("quota")) continue;
            continue;
        }
    }

    throw new Error(`All keys failed for ${provider}. Last error: ${lastError?.message}`);
}

async function generateGemini(key: string, modelName: string, prompt: string, images: { data: string; mimeType: string }[], temperature: number = 0): Promise<AIResult> {
    const genAI = new GoogleGenerativeAI(key);
    // temperature:0 + top_p:1 → deterministic-ish for structured extraction.
    // Default Gemini temperature is ~1.0 which made compare results vary
    // between runs on the same input (user-reported inconsistency).
    // OCR-3: retry path lifts to 0.6 to shake a stuck deterministic answer;
    // topP left at 1 so temperature alone controls the retry variance.
    const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature, topP: 1 },
    });
    const imageParts = images.map(img => ({ inlineData: img }));
    const result = await model.generateContent([
        prompt,
        ...imageParts,
    ]);
    const response = await result.response;
    const um: any = response.usageMetadata || {};
    return {
        text: response.text(),
        usage: {
            inputTokens: um.promptTokenCount || 0,
            // thinking tokens (gemini 2.5) are billed as output
            outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
        },
    };
}

// AI-1: Vertex AI Express Mode. Same AIza-style API key as AI Studio, but a
// different endpoint host and — critically — the key is passed via the
// `x-goog-api-key` request header (SEC-1). NEVER put it in the URL query
// string: URLs get logged into request tracing, `wrangler tail`, and any
// upstream error surface. Payload shape is identical to AI Studio's
// generateContent (contents.parts[] with inline_data), so multi-image works
// unchanged — required for the OCR-6/6b/6c crop pass.
//
// Endpoint: global Express Mode (`aiplatform.googleapis.com`). A region-
// scoped endpoint (`<location>-aiplatform.googleapis.com`) is only reachable
// via OAuth / service account, which is explicitly out of scope for AI-1.
async function generateVertexAI(
    key: string,
    modelName: string,
    prompt: string,
    images: { data: string; mimeType: string }[],
    _location?: string,
    temperature: number = 0,
): Promise<AIResult> {
    const host = "aiplatform.googleapis.com";
    const url = `https://${host}/v1/publishers/google/models/${encodeURIComponent(modelName)}:generateContent`;

    const parts: any[] = [{ text: prompt }];
    for (const img of images) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
    }

    // OCR-3: Vertex AI Express Mode `generateContent` accepts the same
    // `generationConfig.temperature` field as the AI Studio Gemini SDK — see
    // Google's REST reference for GenerationConfig. topP stays at 1 so
    // temperature alone drives the retry variance.
    const body = {
        contents: [{ role: "user", parts }],
        generationConfig: { temperature, topP: 1 },
    };

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            // SEC-1: key in header, not URL.
            "x-goog-api-key": key,
        },
        body: JSON.stringify(body),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
        // Google error bodies can echo the request URL/config. Redact before
        // throwing so the message that ultimately hits `console.warn` /
        // `console.error` upstream can never carry the key.
        const rawMsg = data?.error?.message || `Vertex AI HTTP ${res.status}`;
        throw new Error(redactSecrets(rawMsg));
    }

    const candidate = data?.candidates?.[0];
    const textParts: string[] = (candidate?.content?.parts || [])
        .map((p: any) => p?.text)
        .filter((t: any) => typeof t === "string");
    const text = textParts.join("");

    const um = data?.usageMetadata || {};
    return {
        text,
        usage: {
            inputTokens: um.promptTokenCount || 0,
            // Mirror the Gemini mapping: thinking tokens (2.5-family) billed as output.
            outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
        },
    };
}

async function generateOpenAI(key: string, modelName: string, prompt: string, images: { data: string; mimeType: string }[], temperature: number = 0): Promise<AIResult> {
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
            temperature,
            response_format: { type: "json_object" }
        })
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || "OpenAI Error");
    return {
        text: data.choices[0].message.content,
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    };
}

async function generateOpenRouter(key: string, modelName: string, prompt: string, images: { data: string; mimeType: string }[], temperature: number = 0): Promise<AIResult> {
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
            ],
            temperature
        })
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || "OpenRouter Error");
    return {
        text: data.choices[0].message.content,
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    };
}
