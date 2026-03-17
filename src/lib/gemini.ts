import { GoogleGenerativeAI } from "@google/generative-ai";

export async function generateWithRotation(
    apiKeysString: string,
    modelName: string,
    prompt: string,
    inlineData: { data: string; mimeType: string }
) {
    const apiKeys = apiKeysString.split(",").map((k) => k.trim());
    let lastError = null;

    for (const key of apiKeys) {
        try {
            console.log(`--- Attempting OCR with key: ${key.substring(0, 8)}... ---`);
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: modelName });

            const result = await model.generateContent([
                prompt,
                {
                    inlineData: inlineData,
                },
            ]);

            const response = await result.response;
            return response.text();
        } catch (error: any) {
            console.warn(`Key ${key.substring(0, 8)} failed:`, error.message);
            lastError = error;

            // ถ้าเป็น Rate Limit หรือ Error ที่ควรเปลี่ยน Key ให้วนลูปต่อ
            if (error.message?.includes("429") || error.message?.includes("Too Many Requests") || error.message?.includes("quota")) {
                continue;
            }

            // ถ้าเป็น Error ร้ายแรงอื่นๆ อาจจะอยากหยุดเลย แต่ในที่นี้เราเลือกสู้ต่อ (Fallback)
            continue;
        }
    }

    throw new Error(`All API Keys failed. Last error: ${lastError?.message}`);
}
