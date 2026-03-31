import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateWithAI } from "@/lib/ai-handler";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const userId = (formData.get("userId") as string) || "guest";
        const selectedModelId = (formData.get("selectedModelId") as string) || "";
        
        const files: File[] = [];
        if (formData.has("file1")) files.push(formData.get("file1") as unknown as File);
        if (formData.has("file2")) files.push(formData.get("file2") as unknown as File);
        if (formData.has("file3")) files.push(formData.get("file3") as unknown as File);

        if (files.length < 2) {
            return NextResponse.json({ error: "ต้องใช้เอกสารอย่างน้อย 2 ฉบับเพื่อเปรียบเทียบ" }, { status: 400 });
        }

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return NextResponse.json({ error: "Database not configured" }, { status: 500 });
        }

        // 1. Check & Decrement Credits if not guest
        if (userId !== "guest") {
            const userRes = await env.DB.prepare("SELECT credits_remaining, extra_credits, plan FROM users WHERE id = ?")
                .bind(userId)
                .first<{ credits_remaining: number; extra_credits: number; plan: string }>();

            if (!userRes) {
                return NextResponse.json({ error: "ไม่พบข้อมูลผู้ใช้" }, { status: 404 });
            }

            const totalAvailable = userRes.credits_remaining + userRes.extra_credits;
            if (totalAvailable <= 0) {
                return NextResponse.json({ error: "เครดิตหมดแล้ว กรุณาอัปเกรดแผนหรือซื้อเพิ่ม" }, { status: 403 });
            }

            if (userRes.credits_remaining > 0) {
                await env.DB.prepare("UPDATE users SET credits_remaining = credits_remaining - 1 WHERE id = ?").bind(userId).run();
            } else {
                await env.DB.prepare("UPDATE users SET extra_credits = extra_credits - 1 WHERE id = ?").bind(userId).run();
            }
        }

        // 2. Retrieve AI Configuration
        let finalConfigs: any[] = [];
        const configResult = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'AI_POWER_CONFIG'").first<{ value: string }>();
        if (configResult) finalConfigs = JSON.parse(configResult.value);

        if (finalConfigs.length === 0) {
            const envKey = (env as any).GEMINI_API_KEY || (env as any).GEMINI_API_KEYS || "";
            if (envKey) finalConfigs.push({ id: 'fallback', provider: 'gemini', model: 'gemini-1.5-pro', apiKey: envKey });
        }

        // Try to force a pro model if available for comparison because flash might struggle with bboxes and 2/3 images
        let target = finalConfigs.find(c => c.id === selectedModelId);
        if (!target) target = finalConfigs.find(c => c.model.includes('pro')) || finalConfigs[0];

        if (!target) {
            return NextResponse.json({ error: "No AI Configuration available" }, { status: 500 });
        }

        const matchingKeys = finalConfigs
            .filter(c => c.provider === target.provider && c.model === target.model)
            .map(c => c.apiKey);

        // 3. Build Prompt and Execute
        // We instruct the model to look at the images sequentially
        const prompt = `เปรียบเทียบรูปภาพเอกสารทั้ง ${files.length} ฉบับนี้และหาจุดที่แตกต่างกันทั้งหมด (ข้อความ ตัวเลข หรือรายละเอียดอื่นๆ)
รูปแบบการตอบกลับต้องเป็น JSON เท่านั้น ดังนี้:
{
    "differences": [
        {
            "description": "คำอธิบายสิ่งที่แตกต่าง",
            "bbox1": [ymin, xmin, ymax, xmax] ของจุดที่ต่างในรูปภาพแรก (ถ้าไม่พบให้เป็น null),
            "bbox2": [ymin, xmin, ymax, xmax] ของจุดที่ต่างในรูปภาพที่ 2 (ถ้าไม่พบให้เป็น null)
            ${files.length > 2 ? ',\n            "bbox3": [ymin, xmin, ymax, xmax] ของจุดที่ต่างในรูปภาพที่ 3 (ถ้าไม่พบให้เป็น null)' : ''}
        }
    ]
}
* หมายเหตุ: ค่าพิกัด bbox (bounding box) ต้องเป็นตัวเลขระหว่าง 0 ถึง 1000 เพื่อระบุตำแหน่งของข้อความบนเอกสารนั้น กรุณาตอบกลับแค่ JSON เพียวๆ
หากไม่มีความแตกต่างเลยให้ array ว่าง`;

        const imagesData = await Promise.all(files.map(async f => {
            const arrayBuffer = await f.arrayBuffer();
            const base64Data = Buffer.from(arrayBuffer).toString("base64");
            return {
                data: base64Data,
                mimeType: f.type || "image/jpeg"
            };
        }));

        const startTime = Date.now();
        const text = await generateWithAI({
            provider: target.provider,
            model: target.model,
            prompt,
            images: imagesData,
            apiKeys: matchingKeys
        });

        const processingTimeMs = Date.now() - startTime;

        let extracted: any = { differences: [] };
        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) extracted = JSON.parse(match[0]);
        } catch (e) {
            return NextResponse.json({ error: "AI returned invalid format", raw: text }, { status: 502 });
        }

        return NextResponse.json({
            success: true,
            processing_time_ms: processingTimeMs,
            extracted_data: extracted
        });

    } catch (error: any) {
        console.error("[Compare POST] error:", error);
        return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
    }
}
