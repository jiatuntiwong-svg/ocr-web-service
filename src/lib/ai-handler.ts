import { GoogleGenerativeAI } from "@google/generative-ai";

export interface AIProviderRequest {
    provider: string;
    model: string;
    prompt: string;
    image: { data: string; mimeType: string };
    apiKeys: string[];
}

export async function generateWithAI(req: AIProviderRequest): Promise<string> {
    const { provider, model, prompt, image, apiKeys } = req;
    let lastError = null;

    for (const key of apiKeys) {
        try {
            if (provider === 'gemini') {
                return await generateGemini(key, model, prompt, image);
            } else if (provider === 'openai') {
                return await generateOpenAI(key, model, prompt, image);
            } else if (provider === 'openrouter') {
                return await generateOpenRouter(key, model, prompt, image);
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

async function generateGemini(key: string, modelName: string, prompt: string, image: { data: string; mimeType: string }) {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent([
        prompt,
        { inlineData: image },
    ]);
    const response = await result.response;
    return response.text();
}

async function generateOpenAI(key: string, modelName: string, prompt: string, image: { data: string; mimeType: string }) {
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
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        })
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || "OpenAI Error");
    return data.choices[0].message.content;
}

async function generateOpenRouter(key: string, modelName: string, prompt: string, image: { data: string; mimeType: string }) {
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
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }
                    ]
                }
            ]
        })
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || "OpenRouter Error");
    return data.choices[0].message.content;
}
