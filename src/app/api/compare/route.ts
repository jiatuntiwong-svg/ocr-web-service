import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logSystemEvent } from "@/lib/logger";
import { generateWithAI } from "@/lib/ai-handler";

export async function POST(req: NextRequest) {
    let userId = "guest";
    try {
        const formData = await req.formData();
        userId = (formData.get("userId") as string) || "guest";
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

        const fieldsToCompare = (formData.get("fields") as string) || "ประเภทเอกสาร, เลขที่เอกสาร, วันที่, ชื่อผู้ออก, ชื่อผู้รับ, เลขผู้เสียภาษี, เงื่อนไขชำระเงิน, กำหนดส่งสินค้า, ยอดรวม, ภาษี, ยอดสุทธิ, รายการสินค้า";

        // 3. Build Prompt and Execute
        const prompt = `เปรียบเทียบเอกสาร ${files.length} ฉบับนี้และหาจุดที่แตกต่างกันอย่างละเอียด
หน้าที่ของคุณคือ "สกัดข้อมูลจากเอกสารตามอ้างอิงหัวข้อต่อไปนี้: ${fieldsToCompare}" หรือสกัดหัวข้อสำคัญทั้งหมดที่พบ จากนั้นนำมาเทียบกัน "ทีละหัวข้อ"
รูปแบบการตอบกลับต้องเป็น JSON เท่านั้น ดังนี้:
{
    "summary": [
        "สรุปสิ่งที่แตกต่างจุดที่ 1",
        "สรุปสิ่งที่แตกต่างจุดที่ 2"
    ],
    "fields": [
        {
            "key": "ชื่อหัวข้อ (เช่น วันที่, ยอดรวม, เงื่อนไขชำระเงิน)",
            "is_diff": false,
            "doc1": "ค่าของหัวข้อนี้ (จะเหมือนกันทุกฉบับ)",
            "locations": {
                "doc1": [{ "page": 1, "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.05, "text": "ค่าของข้อความ" }],
                "doc2": [{ "page": 1, "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.05 }]
                ${files.length > 2 ? ',"doc3": [{ "page": 1, "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.05 }]' : ''}
            }
        },
        {
            "key": "ชื่อหัวข้อ (เช่น เงื่อนไขชำระเงิน)",
            "is_diff": true,
            "doc1": "ข้อมูลในฉบับที่ 1 (ถ้าไม่มีให้ใส่ null)",
            "doc2": "ข้อมูลในฉบับที่ 2 (ถ้าไม่มีให้ใส่ null)"
            ${files.length > 2 ? ',\n            "doc3": "ข้อมูลในฉบับที่ 3 (ถ้าไม่มีให้ใส่ null)"' : ''},
            "locations": {
                "doc1": [{ "page": 1, "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.05 }],
                "doc2": [{ "page": 1, "x": 0.1, "y": 0.25, "width": 0.3, "height": 0.05 }]
                ${files.length > 2 ? ',"doc3": [{ "page": 1, "x": 0.1, "y": 0.25, "width": 0.3, "height": 0.05 }]' : ''}
            }
        }
    ]
}

* กฎเหล็ก:
1. เรียงลำดับ array "fields" ให้ครอบคลุมเนื้อหาสำคัญทั้งหมดของเอกสาร โดยเฉพาะหัวข้อที่มีความแตกต่างกัน
2. หากหัวข้อไหนมีความแตกต่างกัน ให้ตั้ง is_diff เป็น true
3. "locations" คือ กล่องพิกัด (Bounding Box) ของข้อความบนเอกสาร
   - x, y คือพิกัด (0..1) ของมุมซ้ายบน
   - width, height คือขนาดกว้างและสูง (0..1)
   - page: หน้าของเอกสาร (เริ่มที่ 1) ถ้าเป็นเอกสารภาพให้ใช้ 1 เสมอ
   - ตำแหน่ง highlight จะต้องตรงและครอบเฉพาะคำที่เกี่ยวข้องเท่านั้น อย่าครอบบล็อกใหญ่เกินจริง
   - ถ้าหาตำแหน่งไม่พบ ให้ส่งเป็น array ว่าง ([]) ใน doc นั้น
4. กรุณาตอบกลับแค่ JSON เพียวๆ ไม่มี markdown หรือ text อื่นนอกเหนือจากรูปแบบที่ระบุ`;

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

        let extracted: any = { summary: [], fields: [] };
        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                extracted = JSON.parse(match[0]);
                if (extracted.differences) {
                    extracted.fields = extracted.differences;
                    delete extracted.differences;
                }
                
                // Sanitize locations
                if (extracted.fields && Array.isArray(extracted.fields)) {
                    const parseNum = (val: any, fallback: number): number => {
                        if (typeof val === 'number') return val;
                        if (typeof val === 'string') {
                            const parsed = parseFloat(val);
                            if (!isNaN(parsed)) return parsed;
                        }
                        return fallback;
                    };

                    extracted.fields.forEach((field: any) => {
                        if (field.locations) {
                            ['doc1', 'doc2', 'doc3'].forEach((docKey) => {
                                if (field.locations[docKey] && Array.isArray(field.locations[docKey])) {
                                    field.locations[docKey] = field.locations[docKey].map((loc: any) => {
                                        let page = Math.max(1, Math.round(parseNum(loc.page, 1)));
                                        let x = parseNum(loc.x, 0);
                                        let y = parseNum(loc.y, 0);
                                        let width = parseNum(loc.width, 0);
                                        let height = parseNum(loc.height, 0);

                                        let maxVal = Math.max(x, y, width, height);

                                        // Auto-normalize if values look like scaled instead of 0..1
                                        if (maxVal > 1) {
                                            // Vision models often default to 0-1000 bounding boxes or 0-100 percentages
                                            let scaleFactor = maxVal > 100 ? 1000 : 100;
                                            x = x / scaleFactor;
                                            y = y / scaleFactor;
                                            width = width / scaleFactor;
                                            height = height / scaleFactor;
                                        }

                                        // Clamp completely within 0..1
                                        x = Math.max(0, Math.min(1, x));
                                        y = Math.max(0, Math.min(1, y));
                                        width = Math.max(0, Math.min(1, width));
                                        height = Math.max(0, Math.min(1, height));
                                        
                                        // Ensure x + width doesn't overflow page
                                        if (x + width > 1) width = 1 - x;
                                        if (y + height > 1) height = 1 - y;

                                        return { page, x, y, width, height, text: loc.text || "" };
                                    });
                                }
                            });
                        }
                    });
                }
            }
        } catch (e) {
            return NextResponse.json({ error: "AI returned invalid format", raw: text }, { status: 502 });
        }

        await logSystemEvent(env, "DOCUMENT_COMPARE", `Compared ${files.length} documents.`, "info", userId);

        return NextResponse.json({
            success: true,
            processing_time_ms: processingTimeMs,
            extracted_data: extracted
        });

    } catch (error: any) {
        console.error("[Compare POST] error:", error);
        const { env } = await getCloudflareContext();
        if (env) {
            await logSystemEvent(env, "COMPARE_ERROR", error.message, "error", userId);
        }
        return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
    }
}
