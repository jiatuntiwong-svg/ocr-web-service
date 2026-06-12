import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateWithAI, getActiveAIConfigs } from "@/lib/ai-handler";
import { logAiUsage } from "@/lib/ai-usage";
import { loadFeatureFlags, isFeatureEnabled } from "@/lib/tier-config";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { verifyPassword, hashPassword, isHashed } from "@/lib/passwordHash";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const email = (formData.get("email") as string)?.toLowerCase().trim();
        const password = formData.get("password") as string;
        const file = formData.get("file") as unknown as File;
        const fieldsToExtract = (formData.get("fields") as string) || "ชื่อบริษัท, เลขผู้เสียภาษี, ยอดรวม, วันที่";
        const selectedModelId = (formData.get("modelId") as string) || "";

        if (!email || !password || !file) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "v1-extract" });
        }

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "v1-extract" });
        }

        // 1. Authenticate User and Check Admin Role
        const userRow = await env.DB.prepare(
            "SELECT id, role, credits_remaining, extra_credits, plan, password FROM users WHERE email = ? LIMIT 1"
        )
            .bind(email)
            .first<{ id: string; role: string; credits_remaining: number; extra_credits: number; plan: string; password: string }>();

        if (!userRow || !(await verifyPassword(password, userRow.password))) {
            return fail(ErrorCode.UNAUTHORIZED, { context: "v1-extract" });
        }

        // One-way migration: rewrite legacy plaintext as a real hash on first
        // successful auth. Best-effort — failure here mustn't block the request.
        if (!isHashed(userRow.password)) {
            try {
                const newHash = await hashPassword(password);
                await env.DB.prepare("UPDATE users SET password = ? WHERE id = ?").bind(newHash, userRow.id).run();
            } catch {}
        }

        const user = {
            id: userRow.id,
            role: userRow.role,
            credits_remaining: userRow.credits_remaining,
            extra_credits: userRow.extra_credits,
            plan: userRow.plan,
        };

        if (user.role !== "admin") {
            return fail(ErrorCode.FEATURE_DISABLED, { detail: "admin-only API", context: "v1-extract" });
        }

        // Feature gate — Public API must be enabled for this user's tier.
        const featureFlags = await loadFeatureFlags(env);
        if (!isFeatureEnabled(featureFlags, user.plan, "public_api")) {
            return fail(ErrorCode.FEATURE_DISABLED, { context: "v1-extract" });
        }

        // 2. Check Credits
        const totalAvailable = user.credits_remaining + user.extra_credits;
        if (totalAvailable <= 0) {
            return fail(ErrorCode.INSUFFICIENT_CREDITS, {
                vars: { need: 1, have: totalAvailable },
                context: "v1-extract",
            });
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
            return fail(ErrorCode.AI_UNAVAILABLE, { context: "v1-extract" });
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
        const ai = await generateWithAI({
            provider: target.provider,
            model: target.model,
            prompt,
            image: { data: base64Data, mimeType: file.type || "image/png" },
            apiKeys: matchingKeys
        });
        const text = ai.text;

        const processingTimeMs = Date.now() - startTime;

        let extracted: Record<string, any> = {};
        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) extracted = JSON.parse(match[0]);
        } catch (e) {
            console.error("[v1/extract] AI parse failed:", (e as any)?.message, "raw:", text?.slice(0, 500));
            return fail(ErrorCode.AI_FAILED, { detail: e, context: "v1-extract-parse" });
        }

        // Record AI token usage for the admin cost dashboard.
        await logAiUsage(env, {
            userId: user.id, fn: "api_extract",
            provider: target.provider, model: target.model,
            inputTokens: ai.usage.inputTokens, outputTokens: ai.usage.outputTokens,
            fileName: file.name,
        });

        // 6. Return the extracted data directly (Synchronous)
        return ok({
            success: true,
            processing_time_ms: processingTimeMs,
            extracted_data: extracted
        });

    } catch (error: any) {
        return fail(ErrorCode.PROCESSING_FAILED, { detail: error, context: "v1-extract" });
    }
}
