import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateWithAI, getActiveAIConfigs } from "@/lib/ai-handler";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const email = (formData.get("email") as string)?.toLowerCase().trim();
        const password = formData.get("password") as string;
        const file = formData.get("file") as unknown as File;
        const fieldsToExtract = (formData.get("fields") as string) || "ชื่อบริษัท, เลขผู้เสียภาษี, ยอดรวม, วันที่";
        const selectedModelId = (formData.get("modelId") as string) || "";

        if (!email || !password || !file) {
            return NextResponse.json({ error: "Missing required fields: email, password, file" }, { status: 400 });
        }

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return NextResponse.json({ error: "Database not configured" }, { status: 500 });
        }

        // 1. Authenticate User and Check Admin Role
        const user = await env.DB.prepare(
            "SELECT id, role, credits_remaining, extra_credits, plan FROM users WHERE email = ? AND password = ? LIMIT 1"
        )
            .bind(email, password)
            .first<{ id: string; role: string; credits_remaining: number; extra_credits: number; plan: string }>();

        if (!user) {
            return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
        }

        if (user.role !== "admin") {
            return NextResponse.json({ error: "Access denied. Only administrators can use this API currently." }, { status: 403 });
        }

        // 2. Check Credits
        const totalAvailable = user.credits_remaining + user.extra_credits;
        if (totalAvailable <= 0) {
            return NextResponse.json({ error: "Insufficient credits" }, { status: 402 });
        }

        // 3. Deduct Credits
        if (user.credits_remaining > 0) {
            await env.DB.prepare("UPDATE users SET credits_remaining = credits_remaining - 1 WHERE id = ?").bind(user.id).run();
        } else {
            await env.DB.prepare("UPDATE users SET extra_credits = extra_credits - 1 WHERE id = ?").bind(user.id).run();
        }

        // 4. Retrieve AI Configuration
        let finalConfigs = await getActiveAIConfigs(env);

        let target = finalConfigs.find(c => c.id === selectedModelId);
        if (!target) target = finalConfigs[0];

        if (!target) {
            return NextResponse.json({ error: "No AI Configuration available on the server" }, { status: 500 });
        }

        const matchingKeys = finalConfigs
            .filter(c => c.provider === target.provider && c.model === target.model)
            .map(c => c.apiKey);

        // 5. Build Prompt and Execute OCR
        const prompt = `วิเคราะห์รูปภาพนี้และดึงข้อมูลตามหัวข้อและประเภทที่ระบุ: ${fieldsToExtract}.
ข้อกำหนดในการตอบกลับ (JSON format เท่านั้น):
1. สำหรับแต่ละหัวข้อ ให้ตอบกลับเป็น Object ที่มีโครงสร้างดังนี้:
   { "value": "ค่าที่ดึงได้ (หรือ null)", "confidence": "ระดับความมั่นใจ 0-100 (ตัวเลข)" }
2. หากเป็นประเภท (date) ให้ตอบ "value" เป็น YYYY-MM-DD
3. หากเป็นประเภท (table) ให้ตอบ "value" เป็น Array of Objects และ "confidence" เป็นค่าเฉลี่ยของตารางนั้น
4. ตอบกลับเป็น JSON ก้อนเดียวที่มี key ตามหัวข้อที่ระบุ`;

        const arrayBuffer = await file.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString("base64");
        
        const startTime = Date.now();
        const text = await generateWithAI({
            provider: target.provider,
            model: target.model,
            prompt,
            image: { data: base64Data, mimeType: file.type || "image/png" },
            apiKeys: matchingKeys
        });

        const processingTimeMs = Date.now() - startTime;

        let extracted: Record<string, any> = {};
        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) extracted = JSON.parse(match[0]);
        } catch (e) {
            return NextResponse.json({ error: "AI returned invalid format", raw: text }, { status: 502 });
        }

        // 6. Return the extracted data directly (Synchronous)
        return NextResponse.json({
            success: true,
            processing_time_ms: processingTimeMs,
            extracted_data: extracted
        });

    } catch (error: any) {
        console.error("[V1 Extract POST] error:", error);
        return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
    }
}
