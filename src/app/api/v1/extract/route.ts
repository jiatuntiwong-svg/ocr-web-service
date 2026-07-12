import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateWithAI, getActiveAIConfigs } from "@/lib/ai-handler";
import { logAiUsage } from "@/lib/ai-usage";
import { loadFeatureFlags, isFeatureEnabled } from "@/lib/tier-config";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { verifyPassword, hashPassword, isHashed } from "@/lib/passwordHash";
import { parseAndValidatePages, describeSelection } from "@/lib/pageSelection";
import { logSystemEvent } from "@/lib/logger";
import { MAX_UPLOAD_SIZE_MB, MAX_UPLOAD_SIZE_BYTES } from "@/lib/ocrBatchConfig";
import { chargeCreditsAtomic } from "@/lib/credits";
import { getPromptProfile } from "@/lib/promptProfiles";
import { ENABLE_PROMPT_PROFILES } from "@/lib/featureFlags";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const email = (formData.get("email") as string)?.toLowerCase().trim();
        const password = formData.get("password") as string;
        const file = formData.get("file") as unknown as File;
        const fieldsToExtract = (formData.get("fields") as string) || "ชื่อบริษัท, เลขผู้เสียภาษี, ยอดรวม, วันที่";
        const selectedModelId = (formData.get("modelId") as string) || "";

        // ─── OCR-3: retry mode ────────────────────────────────────────
        // Symmetric with /api/upload: `retry=true` bumps AI temperature
        // to 0.6 for a single call. API-2 coded-response contract is
        // untouched — this flag ONLY changes AI sampling + ai_usage tag,
        // never the success/error envelope shape. Backward-compatible:
        // absent = today's byte-identical behavior.
        const isRetry = (formData.get("retry") as string) === "true";
        const aiTemperature = isRetry ? 0.6 : 0;

        if (!email || !password || !file) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "v1-extract" });
        }

        // ─── API-3: upload size guard (PENDING_ISSUES §F4) ────────────────
        // Same limit + placement rationale as /api/upload — reject BEFORE
        // credit deduction, AI call, and arrayBuffer() so oversized payloads
        // never touch the Worker's memory or the user's balance. Public API
        // gets the same protection as the web UI.
        if (file.size > MAX_UPLOAD_SIZE_BYTES) {
            const actualMb = Math.round(file.size / 1024 / 1024);
            const { env: envForLog } = await getCloudflareContext();
            await logSystemEvent(
                envForLog,
                "UPLOAD_TOO_LARGE",
                `v1/extract rejected oversized upload: ${file.name} (${actualMb} MB > ${MAX_UPLOAD_SIZE_MB} MB) email=${email}`,
                "info",
                null,
            ).catch(() => { });
            return fail(ErrorCode.FILE_TOO_LARGE, {
                vars: { limit: MAX_UPLOAD_SIZE_MB, actual: actualMb },
                context: "v1-extract-size",
            });
        }

        // API-1: page-selection contract. Same validator as /api/upload.
        // /v1/extract never grew bbox_hint / crop support (OCR-4 discipline —
        // public API stays on the pre-hint path), so `pages` here is purely
        // advisory metadata: it drives the >5-page cap and gets echoed into
        // the prompt so the model knows which original pages made it in.
        // If the caller also sends `fields_json` with `bbox_hint`, those
        // hints are ignored — this endpoint does not parse them.
        const parsedPages = parseAndValidatePages(formData);
        if (!parsedPages.ok) {
            return fail(parsedPages.code, {
                vars: parsedPages.vars,
                detail: parsedPages.detail,
                context: "v1-extract-pages",
            });
        }
        const selectedPages = parsedPages.pages;
        const totalPages = parsedPages.totalPages;

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

        // 2+3. Atomic guarded charge — one credit per call under the current
        // v1/extract contract (per-request billing). Race-safe: `WHERE` clause
        // rejects if combined balance is short, so parallel requests can't
        // drive the account negative. Shared with `/api/upload` via
        // `chargeCreditsAtomic` (BILL-1 alignment) so the two paths can't
        // drift again (see security-review 2026-07-09).
        const charge = await chargeCreditsAtomic(env, user.id, 1);
        if (!charge.ok) {
            return fail(ErrorCode.INSUFFICIENT_CREDITS, {
                vars: { need: 1, have: user.credits_remaining + user.extra_credits },
                context: "v1-extract",
            });
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
        // S2-2: profile-driven prompt. `includeBbox: false` mirrors the
        // public API's simpler 3-field response record (no bbox rules).
        let prompt: string;
        if (ENABLE_PROMPT_PROFILES) {
            const built = getPromptProfile("extract_fields", {
                fieldsBlock: fieldsToExtract,
                selectedPages,
                includeBbox: false,
            });
            prompt = "fallback" in built
                ? // Impossible in practice — degrade to a short instruction.
                  `หน้าที่: ดึงข้อมูลตามหัวข้อ: ${fieldsToExtract}. ตอบ JSON.`
                : built.prompt;
        } else {
        const pageSelectionPreamble = selectedPages.length > 0
            ? `หมายเหตุ: ผู้ใช้เลือกเฉพาะบางหน้าของ PDF ต้นฉบับ. ภาพที่คุณเห็นคือหน้าที่เลือกเรียงจากบนลงล่างตามลำดับ: ${selectedPages.join(", ")} (เลขคือหมายเลขหน้าจริงในเอกสารต้นฉบับ).\n\n`
            : "";
        prompt = `${pageSelectionPreamble}หน้าที่: ดึงข้อมูลตามหัวข้อและประเภทที่ระบุเท่านั้น: ${fieldsToExtract}

กฎการอ่าน + การแก้คำ (สำคัญมาก):
- อ่านข้อความ "ทีละตัวอักษร" ตามที่เห็นจริงในภาพก่อน แล้วค่อยตัดสินใจว่าจะแก้หรือไม่
- อนุญาตให้แก้เฉพาะกรณีชัดเจนว่าเป็น typo (สะกดผิด/สลับตัวอักษร) และรู้แน่ว่าคำที่ถูกต้องคืออะไร — เช่น "Plastelet" → "Platelet", "recieve" → "receive"
- ห้ามเดา ห้ามตีความ ถ้าไม่แน่ใจว่าคำที่ถูกต้องคืออะไร ให้คงตามต้นฉบับ
- "ทุกครั้ง" ที่แก้คำ ต้องบันทึกใน corrections[] (ดูข้อ 3) — ห้ามแก้เงียบๆ
- "value" ต้องเป็นข้อความเต็มทั้งบรรทัด/ทั้งช่อง (fulltext) — ห้ามย่อ ห้ามสรุป ห้ามตัดหัว ห้ามตัดท้าย
- ถ้าค่ากินหลายบรรทัดใต้ label เดียวกัน (เช่น ที่อยู่ ชื่อยาว รายละเอียด) ต้องเอาทุกบรรทัดที่ต่อเนื่องกันจนกว่าจะเจอ label/หัวข้อถัดไป โดยคั่นบรรทัดด้วย "\n"
- ห้าม "คัดกรอง" ค่าให้ตรงกับที่ชื่อหัวข้อสื่อความหมาย — เอาทุกคำที่ปรากฏในช่องนั้น รวมทั้งคำหน้า/คำท้ายที่ดูไม่เกี่ยว ผู้ใช้จะตัดเอง
- ต้องจับคู่ค่ากับ label ที่ "ตัวสะกดตรงกันเป๊ะ" กับชื่อหัวข้อ ห้ามหยิบค่าจาก label อื่นแม้จะดูใกล้เคียง (เช่น label "ผู้รับโอน" ≠ "คลังวัสดุ") — ถ้าไม่พบ label ตรงในเอกสาร ให้ value เป็น null
- หัวข้อที่ระบุ type เป็น (raw_text) — ต้อง "คัดลอกตามที่เห็นทุกตัวอักษร" ห้ามแก้ typo ห้ามจัดฟอร์แมต ห้ามตัด/เพิ่มคำใดๆ และ corrections ต้องเป็น [] เสมอ

ข้อกำหนดในการตอบกลับ (JSON format เท่านั้น):
1. สำหรับแต่ละหัวข้อ ให้ตอบกลับเป็น Object โครงสร้าง:
   { "value": "ค่าที่ดึงได้ (หรือ null)", "confidence": 0-100, "corrections": [] }
2. field "corrections" — array ของทุกคำที่คุณแก้จากต้นฉบับ เช่น:
   [{ "original": "Plastelet", "corrected": "Platelet", "reason": "typo" }]
   หากไม่ได้แก้อะไรเลย ให้เป็น []
3. หากเป็นประเภท (date) ให้ตอบ "value" เป็น YYYY-MM-DD
4. หากเป็นประเภท (table) ให้ตอบ "value" เป็น Array of Objects และ "confidence" เป็นค่าเฉลี่ยของตารางนั้น
5. ตอบกลับเป็น JSON ก้อนเดียวที่มี "key ตามหัวข้อที่ระบุด้านบนเท่านั้น" — ห้ามเพิ่มหัวข้ออื่น ห้ามคง key เก่าจากคำสั่งก่อนหน้า`;
        }

        const arrayBuffer = await file.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString("base64");
        
        const startTime = Date.now();
        const ai = await generateWithAI({
            provider: target.provider,
            model: target.model,
            prompt,
            image: { data: base64Data, mimeType: file.type || "image/png" },
            apiKeys: matchingKeys,
            // OCR-3: honour retry flag from FormData; default 0 keeps the
            // public API's deterministic-ish behavior for existing callers.
            temperature: aiTemperature,
        });
        const text = ai.text;

        const processingTimeMs = Date.now() - startTime;

        let extracted: Record<string, any> = {};
        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) extracted = JSON.parse(match[0]);
        } catch (e) {
            // API-2 (H4): DO NOT include `raw` AI text in the failure body —
            // the caller has no use for it and it leaks model internals. The
            // raw slice goes to admin logs so operators can still diagnose.
            await logSystemEvent(
                env,
                "V1_EXTRACT_PARSE_FAIL",
                `parse=${(e as any)?.message || "unknown"} file=${file.name} raw="${(text || "").slice(0, 500)}"`,
                "info",
                user.id,
            ).catch(() => { });
            return fail(ErrorCode.AI_FAILED, { detail: e, context: "v1-extract-parse" });
        }

        // Trace slow runs — page count + selection when present.
        await logSystemEvent(
            env,
            "API_EXTRACT",
            `v1/extract ${file.name} [${describeSelection(selectedPages, totalPages)}] ${processingTimeMs}ms`,
            "info",
            user.id,
        );

        // Record AI token usage for the admin cost dashboard.
        await logAiUsage(env, {
            userId: user.id, fn: "api_extract",
            provider: target.provider, model: target.model,
            inputTokens: ai.usage.inputTokens, outputTokens: ai.usage.outputTokens,
            fileName: file.name,
            // OCR-3: mirror upload route — tag retry rows for dashboards.
            isRetry,
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
