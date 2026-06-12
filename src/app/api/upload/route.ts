import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateWithAI, getActiveAIConfigs } from "@/lib/ai-handler";
import { logSystemEvent } from "@/lib/logger";
import { logAiUsage } from "@/lib/ai-usage";
import { loadFeatureFlags, isFeatureEnabled } from "@/lib/tier-config";
import { RETENTION_LIMITS } from "@/lib/devUsers";
import { estimateCredits } from "@/lib/pricing";
import { parseExcel, workbookToPromptText, isExcelFile } from "@/lib/excel-parser";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { createNotification } from "@/lib/notifications";


export async function POST(request: NextRequest) {
  try {
    const data = await request.formData();
    const file = data.get("file") as unknown as File;
    const userId = (data.get("userId") as string) || "guest";
    const fieldsToExtract = (data.get("fields") as string) || "ชื่อบริษัท, เลขผู้เสียภาษี, ยอดรวม, วันที่";
    const selectedModelId = (data.get("selectedModelId") as string) || "";

    if (!file) {
      return fail(ErrorCode.MISSING_FIELDS, { context: "upload" });
    }

    const docId = crypto.randomUUID();
    const fileName = `${docId}-${file.name}`;
    const { env, ctx } = await getCloudflareContext();

    if (!env || !env.BUCKET || !env.DB) {
      throw new Error("Cloudflare bindings (BUCKET or DB) are not available.");
    }

    // ─── 0. Pre-authorize credit ────────────────────────
    // Verify the user HAS a credit before doing any work, but charge only
    // AFTER OCR succeeds (inside runOCR) so a failed extraction never costs
    // a credit. The charge itself is a single atomic UPDATE — the old
    // SELECT-then-UPDATE could race two parallel uploads into a negative
    // balance.
    const userRes = await env.DB.prepare("SELECT credits_remaining, extra_credits, plan FROM users WHERE id = ?")
      .bind(userId)
      .first<{ credits_remaining: number; extra_credits: number; plan: string }>();

    if (!userRes) {
      return fail(ErrorCode.USER_NOT_FOUND, { context: "upload" });
    }

    // Variable pricing — count fields from the prompt to estimate cost.
    // Comma-separated list mirrors the format the frontend sends.
    const fieldCount = fieldsToExtract.split(",").filter(s => s.trim().length > 0).length;
    const estimate = estimateCredits({ operation: "ocr", fields: fieldCount });
    const balance = userRes.credits_remaining + userRes.extra_credits;
    if (balance < estimate.credits) {
      return fail(ErrorCode.INSUFFICIENT_CREDITS, {
        vars: { need: estimate.credits, have: balance },
        context: "upload",
      });
    }
    const userPlan = userRes.plan;

    // ─── Feature gate — OCR must be enabled for this user's tier ───
    const featureFlags = await loadFeatureFlags(env);
    if (!isFeatureEnabled(featureFlags, userPlan, "ocr")) {
      return fail(ErrorCode.FEATURE_DISABLED, { context: "upload-ocr" });
    }

    // ─── 1. Storage & Database ──────────────────────────────────────────────────
    const arrayBuffer = await file.arrayBuffer();
    await env.BUCKET.put(fileName, arrayBuffer);
    await logSystemEvent(env, "DOCUMENT_UPLOAD", `Uploaded file: ${file.name} (${file.type})`, "info", userId);
    
    await env.DB.prepare("INSERT INTO documents (id, user_id, file_name, storage_path, status) VALUES (?, ?, ?, ?, ?)")
      .bind(docId, userId, file.name, fileName, "processing")
      .run();

    // ─── 2. Identify AI Config ──────────────────────────────────────────────────
    const runOCR = async () => {
      try {
        let finalConfigs = await getActiveAIConfigs(env);

        let target = finalConfigs.find(c => c.id === selectedModelId);
        if (!target) target = finalConfigs[0];

        if (!target) throw new Error("No AI Configuration available (Admin needs to set up API keys)");

        // Group keys for the same provider/model to allow rotation
        const matchingKeys = finalConfigs
          .filter(c => c.provider === target.provider && c.model === target.model)
          .map(c => c.apiKey);

        const isExcel = isExcelFile(file);

        // Excel goes through a text-only prompt (POC: Prompt D — CSV+coords —
        // gave 100% cell accuracy). The AI returns cells[] keyed to
        // sheet/row/col so the renderer can highlight them.
        let prompt: string;
        let imagePayload: { data: string; mimeType: string } | undefined;

        if (isExcel) {
          const sheets = parseExcel(arrayBuffer);
          const sheetText = workbookToPromptText(sheets);
          prompt = `คุณคือผู้ช่วยสกัดข้อมูลจาก Excel workbook ที่มี ${sheets.length} sheet(s).

ด้านล่างคือเนื้อหา (แต่ละบรรทัดคือ 1 cell — รูปแบบ \`[S<sheetIndex>!<col><row>] <value>\`):

\`\`\`
${sheetText}
\`\`\`

หน้าที่: สกัดข้อมูลฟิลด์ดังต่อไปนี้: ${fieldsToExtract}

ตอบกลับเป็น JSON เท่านั้น (ห้ามมี markdown/explanation) — โครงสร้าง:
{
  "<field_name>": {
    "value": "<ค่าที่สกัดได้ หรือ null>",
    "cells": [{"sheet": <0-based>, "row": <0-based>, "col": <0-based>}, ...],
    "confidence": <ตัวเลข 0-100>
  }
}

ข้อกำหนด:
1. sheet/row/col เป็น 0-based (sheet 0 = sheet แรก, row 0 = แถวแรก, col 0 = column A)
2. หากค่าฟิลด์เดียวกระจายหลาย cells (เช่น address หลายบรรทัด) — ใส่ cells หลาย entries และ value = รวมข้อความคั่นด้วย space
3. หากเป็นประเภท (date) — value = YYYY-MM-DD
4. หากเป็นประเภท (table) — value = Array of Objects (rows), confidence = ค่าเฉลี่ย
5. หากไม่พบฟิลด์ — value: null, cells: [], confidence: 0`;
        } else {
          prompt = `วิเคราะห์รูปภาพนี้และดึงข้อมูลตามหัวข้อและประเภทที่ระบุ: ${fieldsToExtract}.
ข้อกำหนดในการตอบกลับ (JSON format เท่านั้น):
1. สำหรับแต่ละหัวข้อ ให้ตอบกลับเป็น Object ที่มีโครงสร้างดังนี้:
   { "value": "ค่าที่ดึงได้ (หรือ null)", "confidence": "ระดับความมั่นใจ 0-100 (ตัวเลข)" }
2. หากเป็นประเภท (date) ให้ตอบ "value" เป็น YYYY-MM-DD
3. หากเป็นประเภท (table) ให้ตอบ "value" เป็น Array of Objects และ "confidence" เป็นค่าเฉลี่ยของตารางนั้น
4. ตอบกลับเป็น JSON ก้อนเดียวที่มี key ตามหัวข้อที่ระบุ`;
          imagePayload = { data: Buffer.from(arrayBuffer).toString("base64"), mimeType: file.type || "image/png" };
        }

        const startTime = Date.now();

        const ai = await generateWithAI({
          provider: target.provider,
          model: target.model,
          prompt,
          image: imagePayload,
          apiKeys: matchingKeys
        });
        const text = ai.text;

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

        // ─── Charge credits — only now that OCR has SUCCEEDED ───────────────
        // Atomic single statement: drain `credits_remaining` first, spill
        // the remainder into `extra_credits`. Guarded so the balance can
        // never go negative.
        const charge = estimate.credits;
        const charged = await env.DB.prepare(
          `UPDATE users SET
              credits_remaining = MAX(0, credits_remaining - ?1),
              extra_credits     = extra_credits - MAX(0, ?1 - credits_remaining)
           WHERE id = ?2 AND (credits_remaining + extra_credits) >= ?1
           RETURNING credits_remaining + extra_credits AS remaining`
        ).bind(charge, userId).first<{ remaining: number }>();
        if (!charged) {
          await logSystemEvent(env, "CREDIT_CHARGE_SKIPPED",
            `Doc ${docId} completed but ${charge} credits could not be charged (insufficient balance)`,
            "info", userId).catch(() => { });
        }

        // Persist the actual credit cost on the document for receipts & history.
        await env.DB.prepare("UPDATE documents SET credits_used = ? WHERE id = ?")
          .bind(charge, docId).run();

        // Record AI token usage for the admin cost dashboard.
        await logAiUsage(env, {
          userId, fn: "ocr",
          provider: target.provider, model: target.model,
          inputTokens: ai.usage.inputTokens, outputTokens: ai.usage.outputTokens,
          docId, fileName: file.name,
        });

        await env.BUCKET.delete(fileName);
        await logSystemEvent(env, "OCR_SUCCESS", `Doc ${docId} processed successfully in ${processingTimeMs}ms`, "info", userId);

        // ─── Notifications: low confidence + credit-low ─────────────────────
        // Both reads use the user's stored threshold (default 0.7). Notification
        // writes are best-effort — wrapped so failures never affect the OCR
        // success path.
        try {
          const prefs = await env.DB.prepare(
            "SELECT confidence_threshold FROM user_preferences WHERE user_id = ?",
          ).bind(userId).first<{ confidence_threshold: number | null }>();
          const threshold = prefs?.confidence_threshold ?? 0.7;

          // AI returns confidence as 0..100; normalize to 0..1 to match the
          // threshold stored in user_preferences.
          const fieldConfidences: number[] = [];
          for (const v of Object.values(extracted)) {
            if (v && typeof v === "object" && "confidence" in v && typeof (v as any).confidence === "number") {
              const raw = (v as any).confidence;
              fieldConfidences.push(raw > 1 ? raw / 100 : raw);
            }
          }
          const lowest = fieldConfidences.length ? Math.min(...fieldConfidences) : null;
          if (lowest !== null && lowest < threshold) {
            await createNotification(env, {
              userId,
              kind: "low_confidence",
              severity: "warning",
              title: "Document needs review",
              body: `Lowest field confidence: ${Math.round(lowest * 100)}% (threshold ${Math.round(threshold * 100)}%)`,
              link: "/documents",
              metadata: { docId, lowestConfidence: lowest, threshold },
            });
          }

          if (charged && charged.remaining > 0 && charged.remaining <= 20) {
            await createNotification(env, {
              userId,
              kind: "credit_low",
              severity: "warning",
              title: "Credit running low",
              body: `${charged.remaining} credits remaining`,
              link: "/billing",
              metadata: { remaining: charged.remaining },
            });
          }
        } catch (notifErr) {
          console.warn("[upload] notification trigger failed:", notifErr);
        }

        // Retention
        const retentionLimit = RETENTION_LIMITS[userPlan.toLowerCase()] ?? 50;
        await env.DB.prepare(`UPDATE documents SET raw_json = NULL, storage_path = NULL WHERE user_id = ? AND id NOT IN (SELECT id FROM documents WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`)
          .bind(userId, userId, retentionLimit).run();

      } catch (ocrError: any) {
        console.error("OCR Error:", ocrError);
        await logSystemEvent(env, "OCR_EXTRACTION_ERROR", ocrError.message, "error", userId);
        await env.DB.prepare("UPDATE documents SET status = ?, raw_json = ? WHERE id = ?")
          .bind("error", JSON.stringify({ error: ocrError.message }), docId).run();
        await env.BUCKET.delete(fileName).catch(() => { });
      }
    };

    if (ctx && ctx.waitUntil) ctx.waitUntil(runOCR()); else runOCR();

    return ok({
      success: true,
      message: "ประมวลผล...",
      documentId: docId,
      credits_estimate: estimate.credits,
    });

  } catch (error: any) {
    return fail(ErrorCode.UPLOAD_FAILED, { detail: error, context: "upload" });
  }
}
