import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateWithAI } from "@/lib/ai-handler";
import { RETENTION_LIMITS } from "@/lib/devUsers";


export async function POST(request: NextRequest) {
  try {
    const data = await request.formData();
    const file = data.get("file") as unknown as File;
    const userId = (data.get("userId") as string) || "guest";
    const fieldsToExtract = (data.get("fields") as string) || "ชื่อบริษัท, เลขผู้เสียภาษี, ยอดรวม, วันที่";
    const selectedModelId = (data.get("selectedModelId") as string) || "";

    if (!file) {
      return NextResponse.json({ error: "ไม่พบไฟล์ที่อัปโหลด" }, { status: 400 });
    }

    const docId = crypto.randomUUID();
    const fileName = `${docId}-${file.name}`;
    const { env, ctx } = await getCloudflareContext();

    if (!env || !env.BUCKET || !env.DB) {
      throw new Error("Cloudflare bindings (BUCKET or DB) are not available.");
    }

    // ─── 0. Check & Decrement Credits ───────────────────
    const userRes = await env.DB.prepare("SELECT credits_remaining, extra_credits, plan FROM users WHERE id = ?")
      .bind(userId)
      .first<{ credits_remaining: number; extra_credits: number; plan: string }>();

    if (!userRes) {
      return NextResponse.json({ error: "ไม่พบข้อมูลผู้ใช้" }, { status: 404 });
    }

    const totalAvailable = userRes.credits_remaining + userRes.extra_credits;
    if (totalAvailable <= 0) {
      return NextResponse.json({ error: `เครดิตหมดแล้ว กรุณาอัปเกรดแผนหรือซื้อเพิ่ม` }, { status: 403 });
    }

    // Decrement credits
    if (userRes.credits_remaining > 0) {
      await env.DB.prepare("UPDATE users SET credits_remaining = credits_remaining - 1 WHERE id = ?").bind(userId).run();
    } else {
      await env.DB.prepare("UPDATE users SET extra_credits = extra_credits - 1 WHERE id = ?").bind(userId).run();
    }
    const userPlan = userRes.plan;

    // ─── 1. Storage & Database ──────────────────────────────────────────────────
    const arrayBuffer = await file.arrayBuffer();
    await env.BUCKET.put(fileName, arrayBuffer);
    await env.DB.prepare("INSERT INTO documents (id, user_id, file_name, storage_path, status) VALUES (?, ?, ?, ?, ?)")
      .bind(docId, userId, file.name, fileName, "processing")
      .run();

    // ─── 2. Identify AI Config ──────────────────────────────────────────────────
    const runOCR = async () => {
      try {
        let finalConfigs: any[] = [];
        const result = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'AI_POWER_CONFIG'").first<{ value: string }>();
        if (result) finalConfigs = JSON.parse(result.value);

        // Fallback to Env if no DB config
        if (finalConfigs.length === 0) {
          const envKey = (env as any).GEMINI_API_KEY || (env as any).GEMINI_API_KEYS || "";
          if (envKey) finalConfigs.push({ id: 'fallback', provider: 'gemini', model: 'gemini-2.5-flash', apiKey: envKey });
        }

        let target = finalConfigs.find(c => c.id === selectedModelId);
        if (!target) target = finalConfigs[0];

        if (!target) throw new Error("No AI Configuration available (Admin needs to set up API keys)");

        // Group keys for the same provider/model to allow rotation
        const matchingKeys = finalConfigs
          .filter(c => c.provider === target.provider && c.model === target.model)
          .map(c => c.apiKey);

        const prompt = `วิเคราะห์รูปภาพนี้และดึงข้อมูลตามหัวข้อและประเภทที่ระบุ: ${fieldsToExtract}.
ข้อกำหนดในการตอบกลับ (JSON format เท่านั้น):
1. สำหรับแต่ละหัวข้อ ให้ตอบกลับเป็น Object ที่มีโครงสร้างดังนี้:
   { "value": "ค่าที่ดึงได้ (หรือ null)", "confidence": "ระดับความมั่นใจ 0-100 (ตัวเลข)" }
2. หากเป็นประเภท (date) ให้ตอบ "value" เป็น YYYY-MM-DD
3. หากเป็นประเภท (table) ให้ตอบ "value" เป็น Array of Objects และ "confidence" เป็นค่าเฉลี่ยของตารางนั้น
4. ตอบกลับเป็น JSON ก้อนเดียวที่มี key ตามหัวข้อที่ระบุ`;

        const base64Data = Buffer.from(arrayBuffer).toString("base64");
        const startTime = Date.now();

        const text = await generateWithAI({
          provider: target.provider,
          model: target.model,
          prompt,
          image: { data: base64Data, mimeType: file.type || "image/png" },
          apiKeys: matchingKeys
        });

        let extracted: Record<string, any> = {};
        try {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) extracted = JSON.parse(match[0]);
        } catch (e) {
          console.error("Parse Error:", e);
        }

        const processingTimeMs = Date.now() - startTime;
        const getValue = (obj: any) => (obj && typeof obj === 'object' && 'value' in obj) ? obj.value : obj;

        const companyName = getValue(extracted.company_name || extracted.company || extracted["ชื่อบริษัท"]) ?? null;
        const taxId = getValue(extracted.tax_id || extracted.tax || extracted["เลขผู้เสียภาษี"]) ?? null;
        const totalAmount = getValue(extracted.total_amount || extracted.total || extracted["ยอดรวม"]) ?? null;
        const invoiceDate = getValue(extracted.invoice_date || extracted.date || extracted["วันที่"]) ?? null;

        await env.DB.prepare("INSERT INTO extracted_data (doc_id, company_name, tax_id, total_amount, invoice_date) VALUES (?, ?, ?, ?, ?)")
          .bind(docId, companyName, taxId, totalAmount, invoiceDate).run();

        await env.DB.prepare("UPDATE documents SET status = ?, raw_json = ?, processing_time_ms = ? WHERE id = ?")
          .bind("completed", JSON.stringify(extracted), processingTimeMs, docId).run();

        await env.BUCKET.delete(fileName);

        // Retention
        const retentionLimit = RETENTION_LIMITS[userPlan.toLowerCase()] ?? 50;
        await env.DB.prepare(`UPDATE documents SET raw_json = NULL, storage_path = NULL WHERE user_id = ? AND id NOT IN (SELECT id FROM documents WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`)
          .bind(userId, userId, retentionLimit).run();

      } catch (ocrError: any) {
        console.error("OCR Error:", ocrError);
        await env.DB.prepare("UPDATE documents SET status = ?, raw_json = ? WHERE id = ?")
          .bind("error", JSON.stringify({ error: ocrError.message }), docId).run();
        await env.BUCKET.delete(fileName).catch(() => { });
      }
    };

    if (ctx && ctx.waitUntil) ctx.waitUntil(runOCR()); else runOCR();

    return NextResponse.json({ success: true, message: "ประมวลผล...", documentId: docId });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
