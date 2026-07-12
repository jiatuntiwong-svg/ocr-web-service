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
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { parseAndValidatePages, describeSelection } from "@/lib/pageSelection";
import { normalizeFieldNameKey } from "@/lib/field-crops";
import { MAX_UPLOAD_SIZE_MB, MAX_UPLOAD_SIZE_BYTES } from "@/lib/ocrBatchConfig";
import { chargeCreditsAtomic } from "@/lib/credits";
import { getPromptProfile } from "@/lib/promptProfiles";
import { ENABLE_PROMPT_PROFILES } from "@/lib/featureFlags";


export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;

    const data = await request.formData();
    const file = data.get("file") as unknown as File;
    // Honour `userId` only when it matches the session (or admin). Older
    // clients pass it explicitly; new clients can omit it.
    const requested = (data.get("userId") as string) || auth.id;
    const cross = ensureCanActAs(auth, requested);
    if (cross) return cross;
    const userId = requested;
    const fieldsToExtract = (data.get("fields") as string) || "ชื่อบริษัท, เลขผู้เสียภาษี, ยอดรวม, วันที่";
    // Structured field spec (name/type/bbox_hint). When present, we build a
    // richer prompt line per field including its expected bbox as a spatial
    // anchor. Malformed JSON silently falls back to the string form above.
    let structuredFields: Array<{ name: string; type?: string; bbox_hint?: { x: number; y: number; width: number; height: number; page?: number } }> = [];
    const fieldsJsonRaw = data.get("fields_json") as string | null;
    if (fieldsJsonRaw) {
        try {
            const parsed = JSON.parse(fieldsJsonRaw);
            if (Array.isArray(parsed)) structuredFields = parsed;
        } catch { /* keep structuredFields empty → string fallback */ }
    }
    // Build the field descriptor block used inside the image prompt below.
    // Each line = "name (type) [hint: x=A%-B%, y=C%-D%, page N]" when bbox
    // is set, plain "name (type)" otherwise. Whitespace preserved for readability.
    const fieldsBlock = structuredFields.length > 0
        ? structuredFields.map(f => {
            const t = f.type && f.type !== "text" ? ` (${f.type})` : "";
            const b = f.bbox_hint;
            if (!b || typeof b.x !== "number") return `- "${f.name}"${t}`;
            const pct = (v: number) => Math.round(v * 100);
            const pageHint = b.page && b.page > 1 ? `, page ${b.page}` : "";
            return `- "${f.name}"${t} [hint: x=${pct(b.x)}%-${pct(b.x + b.width)}%, y=${pct(b.y)}%-${pct(b.y + b.height)}%${pageHint}]`;
        }).join("\n")
        : fieldsToExtract;
    const selectedModelId = (data.get("selectedModelId") as string) || "";

    // ─── OCR-3: retry mode ───────────────────────────────────────────────
    // When the client sends `retry=true` (FormData string, matches the
    // multipart pattern of `pages`, `total_pages`, `field_crops`) the whole
    // extraction (whole-image AI call + optional crop pass) re-runs at
    // temperature 0.6 to shake Gemini out of a stuck deterministic answer
    // (issue 2.5 in docs/OCR_TESTING_LOG.md). Credit + metering treatment is
    // unchanged: retry pays like a fresh run, ai_usage row is tagged with
    // is_retry=1 so admin dashboards can see the cost pattern.
    // Backward-compat: absent flag = today's byte-identical behavior.
    const isRetry = (data.get("retry") as string) === "true";
    const aiTemperature = isRetry ? 0.6 : 0;

    // ─── S2-2: fulldoc verbatim-transcribe mode ─────────────────────────
    // Client (OCRWorkspaceV2) can send `mode=fulldoc` to request a full-
    // document transcript instead of per-field extraction. Absent (or any
    // other value) = today's byte-identical field-extract behavior.
    const uploadMode = (data.get("mode") as string) || "field";
    const isFulldoc = uploadMode === "fulldoc";

    // ─── API-1: page-selection contract ──────────────────────────────────
    // Client (frontend page-picker UI-1, and batch runner) may attach:
    //   pages         — JSON array of 1-based ORIGINAL PDF page numbers
    //                   actually included in the uploaded (stacked) PNG.
    //   total_pages   — int; the source PDF's real page count.
    // Semantics + validation live in `src/lib/pageSelection.ts`. This is
    // ADVISORY metadata — the server never sees the source PDF (raster is
    // browser-side) — but it drives (a) the >5-page cap error, (b) prompt
    // enrichment so the model knows which original pages made it in, and
    // (c) Path A bbox_hint page semantics (hints stay keyed to original
    // page numbers end-to-end).
    const parsedPages = parseAndValidatePages(data);
    if (!parsedPages.ok) {
      return fail(parsedPages.code, {
        vars: parsedPages.vars,
        detail: parsedPages.detail,
        context: "upload-pages",
      });
    }
    const selectedPages = parsedPages.pages;
    const totalPages = parsedPages.totalPages;

    // ─── OCR-6: crop-based extraction inputs ─────────────────────────────
    // Client (see src/lib/field-crops.ts) may attach one PNG blob per hinted
    // field plus a `field_crops` manifest describing which crop_<idx> maps
    // to which fieldName + page. Absent = legacy behavior (whole-image only,
    // fully backward-compatible).
    interface CropManifestEntry { index: number; fieldName: string; page: number }
    let cropManifest: CropManifestEntry[] = [];
    const cropsRaw = data.get("field_crops") as string | null;
    if (cropsRaw) {
        try {
            const parsed = JSON.parse(cropsRaw);
            if (Array.isArray(parsed)) cropManifest = parsed.filter(
                (e: any) => e && typeof e.index === "number" && typeof e.fieldName === "string"
            );
        } catch { /* malformed manifest → treat as no crops */ }
    }
    const cropFiles: Array<{ fieldName: string; page: number; buffer: ArrayBuffer; mimeType: string }> = [];
    for (const m of cropManifest) {
        const f = data.get(`crop_${m.index}`) as unknown as File | null;
        if (!f) continue;
        try {
            cropFiles.push({
                fieldName: m.fieldName,
                page: m.page,
                buffer: await f.arrayBuffer(),
                mimeType: f.type || "image/png",
            });
        } catch { /* skip unreadable part */ }
    }

    if (!file) {
      return fail(ErrorCode.MISSING_FIELDS, { context: "upload" });
    }

    // ─── API-3: upload size guard (PENDING_ISSUES §F4) ────────────────────
    // Reject oversized files BEFORE credit deduction, R2 upload, and
    // arrayBuffer() so huge files can't OOM the Worker or burn credits.
    // File.size is available from formData without buffering the payload.
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      const actualMb = Math.round(file.size / 1024 / 1024);
      const { env: envForLog } = await getCloudflareContext();
      await logSystemEvent(
        envForLog,
        "UPLOAD_TOO_LARGE",
        `Rejected oversized upload: ${file.name} (${actualMb} MB > ${MAX_UPLOAD_SIZE_MB} MB) bytes=${file.size}`,
        "info",
        auth.id,
      ).catch(() => { });
      return fail(ErrorCode.FILE_TOO_LARGE, {
        vars: { limit: MAX_UPLOAD_SIZE_MB, actual: actualMb },
        context: "upload-size",
      });
    }

    const docId = crypto.randomUUID();
    const fileName = `${docId}-${file.name}`;
    const { env, ctx } = await getCloudflareContext();

    if (!env || !env.BUCKET || !env.DB) {
      // API-2: coded response instead of raw throw. Falls into the outer
      // catch otherwise → generic UPLOAD_FAILED with no signal of the
      // binding-config root cause.
      return fail(ErrorCode.SERVER_ERROR, {
        detail: "Cloudflare bindings (BUCKET or DB) are not available",
        context: "upload-bindings",
      });
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
    const selectionLabel = describeSelection(selectedPages, totalPages);
    await logSystemEvent(
      env,
      "DOCUMENT_UPLOAD",
      `Uploaded file: ${file.name} (${file.type}) [${selectionLabel}]`,
      "info",
      userId,
    );
    
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
        } else if (isFulldoc && ENABLE_PROMPT_PROFILES) {
          // S2-2: verbatim_transcribe profile — full-document per-page
          // transcript. `fields_json` from the client is a placeholder
          // (`full_document (raw_text)`) — we ignore it here and produce
          // a { pages: [...] } shape instead. Merge back to `extracted`
          // as a single `full_document` field so the existing status/DB
          // path stays intact (raw_json holds the pages array).
          const built = getPromptProfile("verbatim_transcribe", { selectedPages });
          if ("fallback" in built) {
            // Impossible unless the catalog is broken — degrade to the
            // field-extract prompt so we still return SOMETHING useful.
            prompt = `หน้าที่: ถอดข้อความทั้งหมดในภาพเป็นข้อความยาวก้อนเดียว (verbatim).`;
          } else {
            prompt = built.prompt;
          }
          imagePayload = { data: Buffer.from(arrayBuffer).toString("base64"), mimeType: file.type || "image/png" };
        } else if (ENABLE_PROMPT_PROFILES) {
          // S2-2: extract_fields profile — replaces the inline block below.
          // includeBbox=true keeps the /api/upload contract intact (bbox
          // record + hint rules).
          const built = getPromptProfile("extract_fields", {
            fieldsBlock,
            selectedPages,
            includeBbox: true,
          });
          if ("fallback" in built) {
            // Shouldn't happen — but if the catalog somehow returns fallback
            // we drop into the inline path below by falling through here.
            prompt = "";
          } else {
            prompt = built.prompt;
          }
          imagePayload = { data: Buffer.from(arrayBuffer).toString("base64"), mimeType: file.type || "image/png" };
        } else {
          // Legacy inline prompt (flag OFF). Byte-identical to pre-S2-2.
          // API-1: when the user picked a subset of PDF pages, tell the model
          // which ORIGINAL pages made it into the stacked image and in what
          // order. bbox_hint's `page` field refers to the ORIGINAL page number
          // (Path A — invariant across selections), so this mapping is what
          // lets the model reconcile "hint says page 3" with "page 3 is the
          // 2nd tile from top in the image you're looking at".
          const pageSelectionPreamble = selectedPages.length > 0
            ? `หมายเหตุ: ผู้ใช้เลือกเฉพาะบางหน้าของ PDF ต้นฉบับ. ภาพที่คุณเห็นคือหน้าที่เลือก "เรียงต่อกันจากบนลงล่าง" ตามลำดับต่อไปนี้ (เลขคือหมายเลขหน้าจริงในเอกสารต้นฉบับ): ${selectedPages.join(", ")}. หากหัวข้อระบุ "page N" ให้ตีความว่าเป็นหมายเลขหน้าต้นฉบับ (มองหาเฉพาะในภาพของหน้านั้นถ้ามีในลำดับด้านบน).\n\n`
            : "";
          prompt = `${pageSelectionPreamble}หน้าที่: ดึงข้อมูลตามหัวข้อและประเภทที่ระบุเท่านั้น

หัวข้อที่ต้องดึง:
${fieldsBlock}

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
- หัวข้อที่มี [hint: x=...%, y=...%] คือ "ตำแหน่งที่คาดว่าค่าจะอยู่" (0-100% ของขนาดภาพ, มุมซ้ายบน = 0,0) — ให้ค้นในบริเวณของกรอบ "และพื้นที่ใต้กรอบเสมอ" (สำหรับค่าที่ผู้เขียนกรอกล้นออกใต้เส้น/ใต้ label) ไม่จำกัดเฉพาะภายในกรอบ; หากไม่พบทั้งในกรอบและใต้กรอบเลย จึงค่อย fallback semantic search ทั่วภาพเป็นทางเลือกสุดท้าย

ข้อกำหนดในการตอบกลับ (JSON format เท่านั้น):
1. สำหรับแต่ละหัวข้อ ให้ตอบกลับเป็น Object โครงสร้าง:
   { "value": "ค่าที่ดึงได้ (หรือ null)", "confidence": 0-100, "corrections": [], "bbox": {"x":0-1,"y":0-1,"width":0-1,"height":0-1,"page":1} }
2. field "bbox" — ตำแหน่งจริงของ value ในภาพ (relative 0-1) ที่คุณใช้ในการอ่านค่า สำหรับนำไปเทียบกับ hint ในรอบถัดไป หากไม่พบค่าให้ bbox เป็น null
3. field "corrections" — array ของทุกคำที่คุณแก้จากต้นฉบับ เช่น:
   [{ "original": "Plastelet", "corrected": "Platelet", "reason": "typo" }]
   หากไม่ได้แก้อะไรเลย ให้เป็น []
4. หากเป็นประเภท (date) ให้ตอบ "value" เป็น YYYY-MM-DD
5. หากเป็นประเภท (table) ให้ตอบ "value" เป็น Array of Objects และ "confidence" เป็นค่าเฉลี่ยของตารางนั้น (bbox = ครอบทั้งตาราง)
6. ตอบกลับเป็น JSON ก้อนเดียวที่มี "key ตามหัวข้อที่ระบุด้านบนเท่านั้น" — ห้ามเพิ่มหัวข้ออื่น ห้ามคง key เก่าจากคำสั่งก่อนหน้า`;
          imagePayload = { data: Buffer.from(arrayBuffer).toString("base64"), mimeType: file.type || "image/png" };
        }

        const startTime = Date.now();

        const ai = await generateWithAI({
          provider: target.provider,
          model: target.model,
          prompt,
          image: imagePayload,
          apiKeys: matchingKeys,
          // OCR-3: same temp applied to whole-image AND crop pass below;
          // the whole point of retry is shaking BOTH halves of the merge.
          temperature: aiTemperature,
        });
        const text = ai.text;

        let extracted: Record<string, any> = {};
        try {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) extracted = JSON.parse(match[0]);
        } catch (e) {
          console.error("Parse Error:", e);
        }

        // S2-2: verbatim_transcribe response has shape { pages, corrections },
        // not a field record. Reshape into a single `full_document` field so
        // the existing DB / notifications / crop-merge code paths downstream
        // stay untouched (crop-merge is a no-op anyway — fulldoc uploads have
        // no field_crops manifest).
        if (isFulldoc && extracted && typeof extracted === "object" && Array.isArray((extracted as any).pages)) {
          const pages = (extracted as any).pages as Array<{ page: number; text: string }>;
          const joined = pages
            .map(p => `--- page ${p.page} ---\n${p.text ?? ""}`)
            .join("\n\n");
          extracted = {
            full_document: {
              value: joined,
              confidence: 100,
              corrections: Array.isArray((extracted as any).corrections) ? (extracted as any).corrections : [],
              pages,
            },
          };
        }

        // Accumulate token usage across all AI calls in this run so the
        // ai_usage row reflects the full cost (whole image + optional crop
        // call). Metering stays 1 row per user-perceived operation.
        let totalInputTokens = ai.usage.inputTokens;
        let totalOutputTokens = ai.usage.outputTokens;

        // ─── OCR-6: focused second call on hinted-field crops ────────────
        // Runs only when the client uploaded crops AND we already have a
        // whole-image result. On any failure below we keep the whole-image
        // result untouched — crops are a strict augmentation.
        if (!isExcel && cropFiles.length > 0) {
          try {
            // S2-2: crop pass is now built by the layout_scan profile so it
            // shares the same rule block as the whole-image call. Flag OFF
            // keeps the OCR-6b inline mini-prompt below byte-identical.
            const cropLabels = cropFiles.map((c, i) => `${i + 1}. "${c.fieldName}"`).join("\n");
            // OCR-6b: mini-prompt ported the critical rules from the
            // whole-image prompt (upload/route.ts:230) — the manual crop test
            // succeeded under the FULL prompt, so a distilled subset of THOSE
            // rules is what makes the crop pass deliver:
            //   1. "value" = fulltext, all lines joined with \n (line-2 drop
            //      protection).
            //   2. No autocorrect, verbatim char-by-char, `corrections[]`
            //      reporting mandatory (fixes the silently-corrected spelling
            //      symptom: รับบริจาค→บริการ).
            //   3. "ทุกอย่างในภาพนี้คือค่าของ field นี้" — kills the sibling-
            //      label blend (ศูนย์บริการ vs ศูนย์รับบริจาค) because the model
            //      can no longer reach into a neighbor's value.
            // Deliberately NOT ported (kept the mini-prompt short):
            //   - [hint: x=...%] rules — irrelevant here, the image IS the hint.
            //   - Page-selection preamble — crops are per-image, no page context.
            //   - raw_text vs other type distinctions — the merge decides
            //     which field's `type` matters after; the crop just returns text.
            let cropPrompt: string;
            if (ENABLE_PROMPT_PROFILES) {
              const builtCrop = getPromptProfile("layout_scan", {
                fieldNames: cropFiles.map(c => c.fieldName),
              });
              cropPrompt = "fallback" in builtCrop
                ? // Impossible-in-practice fallback: keep the old mini-prompt.
                  `แต่ละภาพต่อไปนี้คือ "บริเวณที่ครอบไว้" ของหัวข้อ:\n${cropLabels}\nอ่านตามที่เห็น ตอบ JSON { "<fieldName>": { "value": "..." } }`
                : builtCrop.prompt;
            } else {
              cropPrompt = `แต่ละภาพต่อไปนี้คือ "บริเวณที่ครอบไว้" ของหัวข้อที่ต้องอ่านค่าจริงในหน้าเอกสารเดียวกัน ตามลำดับภาพ:
${cropLabels}

หน้าที่ (สำคัญมาก):
- "ข้อความทั้งหมดในภาพแต่ละใบคือค่าของหัวข้อนั้น" — ห้ามหยิบจากที่อื่น ห้ามคัดกรอง ห้ามตีความว่าตรง/ไม่ตรงกับชื่อหัวข้อ
- อ่าน "ทีละตัวอักษร" ตามที่เห็นจริงในภาพ ห้ามแก้คำเงียบๆ ห้าม autocorrect
- ต้องเอา "ทุกบรรทัดที่ปรากฏในภาพ" ห้ามข้ามบรรทัดที่ 2 หรือ 3 คั่นบรรทัดด้วย "\\n"
- ห้ามสรุป ห้ามย่อ ห้ามตัดคำหน้า/คำท้าย ต้องเป็นข้อความเต็ม (fulltext)
- อนุญาตให้แก้เฉพาะกรณีชัดเจนว่าเป็น typo และรู้แน่ว่าคำที่ถูกต้องคืออะไร — เช่น "Plastelet" → "Platelet" — และ "ทุกครั้ง" ที่แก้ ต้องบันทึกใน corrections[]
- ถ้าไม่พบข้อความใดๆ ในภาพเลย ให้ value = null

ตอบกลับเป็น JSON ก้อนเดียวเท่านั้น (ห้าม markdown):
{
  "<fieldName ตรงตามที่ระบุด้านบน>": { "value": "<ค่าเต็ม หรือ null>", "confidence": 0-100, "corrections": [] }
}
- key ของทุกหัวข้อต้องตรง "ตัวสะกดเป๊ะ" กับชื่อในรายการด้านบน ห้ามเพิ่มหัวข้ออื่น
- corrections = array ของทุกคำที่คุณแก้ เช่น [{"original":"Plastelet","corrected":"Platelet","reason":"typo"}] ถ้าไม่ได้แก้อะไรเลย ให้เป็น []`;
            }

            const cropImages = cropFiles.map(c => ({
              data: Buffer.from(c.buffer).toString("base64"),
              mimeType: c.mimeType,
            }));
            const cropAi = await generateWithAI({
              provider: target.provider,
              model: target.model,
              prompt: cropPrompt,
              images: cropImages,
              apiKeys: matchingKeys,
              // OCR-3: mirror whole-image temp so retry shakes the crop
              // pass too — otherwise the merge would still lean on a
              // stuck deterministic crop answer.
              temperature: aiTemperature,
            });
            totalInputTokens += cropAi.usage.inputTokens;
            totalOutputTokens += cropAi.usage.outputTokens;

            let cropExtracted: Record<string, any> = {};
            try {
              const m = cropAi.text.match(/\{[\s\S]*\}/);
              if (m) cropExtracted = JSON.parse(m[0]);
            } catch (e) {
              console.error("[ocr-6] crop response parse error:", e);
            }

            // Merge policy (OCR-6b — observability invariant):
            //   For EVERY entry in cropManifest, the merged record MUST end up
            //   carrying exactly one of these provenance markers so a bad
            //   crop pass is never invisible again:
            //     - source: "crop"    → crop delivered a usable value
            //     - crop_miss: true   → crop responded but value null/empty
            //     - crop_no_match: true → crop response didn't include this key
            //                             (fieldName normalization failed or
            //                              model dropped it entirely)
            //   This closes the "documented merge observability gap" flagged
            //   in pm/reports/OCR-6.md — previously "manifest sent, key absent
            //   from response" silently kept the whole-image value with NO
            //   trace in raw_json, which is exactly what happened on the
            //   ใบโอนย้ายสินทรัพย์ form.
            //
            //   Matching is tolerant: whitespace-collapse + trim + lowercase
            //   via normalizeFieldNameKey() (shared with the client so both
            //   ends can't drift). Only fieldNames present in cropManifest are
            //   merge candidates — crop response cannot introduce new fields.
            const normalizedResponse: Record<string, { origKey: string; entry: any }> = {};
            for (const k of Object.keys(cropExtracted)) {
              if (typeof k !== "string") continue;
              normalizedResponse[normalizeFieldNameKey(k)] = { origKey: k, entry: cropExtracted[k] };
            }
            const hintedFieldNames = Array.from(new Set(cropManifest.map(c => c.fieldName)));
            const dbgProvenance: Array<{ field: string; outcome: string }> = [];
            for (const fieldName of hintedFieldNames) {
              const norm = normalizeFieldNameKey(fieldName);
              // Try exact first (fast path), then normalized lookup.
              let cropEntry: any = cropExtracted[fieldName];
              if (cropEntry === undefined) {
                const hit = normalizedResponse[norm];
                if (hit) cropEntry = hit.entry;
              }
              const cropVal = cropEntry && typeof cropEntry === "object" ? cropEntry.value : undefined;
              const existing = extracted[fieldName];
              const existingObj = (existing && typeof existing === "object" && !Array.isArray(existing))
                ? existing
                : { value: existing ?? null };

              if (cropVal !== undefined && cropVal !== null && cropVal !== "") {
                extracted[fieldName] = {
                  ...existingObj,
                  value: cropVal,
                  confidence: typeof cropEntry.confidence === "number"
                    ? cropEntry.confidence
                    : existingObj.confidence,
                  // Preserve crop's `corrections` when the model reported any
                  // — critical for the "silent autocorrect" symptom (OCR-6b).
                  ...(Array.isArray(cropEntry.corrections) && cropEntry.corrections.length > 0
                    ? { corrections: cropEntry.corrections }
                    : {}),
                  source: "crop",
                };
                dbgProvenance.push({ field: fieldName, outcome: "crop" });
              } else if (cropEntry !== undefined) {
                // Crop was attempted; model responded but value null/empty.
                extracted[fieldName] = { ...existingObj, crop_miss: true };
                dbgProvenance.push({ field: fieldName, outcome: "crop_miss" });
              } else {
                // Crop sent, but response has no matching key at all — this
                // is the previously-silent path. Now recorded.
                extracted[fieldName] = { ...existingObj, crop_no_match: true };
                dbgProvenance.push({ field: fieldName, outcome: "crop_no_match" });
              }
            }
            // Dev-only breadcrumb — mirrors the [OCR-6] client-side debug so
            // the operator can trace a bad merge end-to-end on the first run
            // in preview. Gated on NODE_ENV so prod bundles emit nothing.
            if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
              console.debug("[OCR-6b] crop merge provenance", {
                manifest: cropManifest.map(m => m.fieldName),
                responseKeys: Object.keys(cropExtracted),
                outcomes: dbgProvenance,
              });
            }
          } catch (cropErr) {
            console.error("[ocr-6] crop pass failed, falling back to whole-image only:", cropErr);
          }
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
        // BILL-1: both OCR entry points go through the same guarded helper
        // in `credits.ts` so the deduction pattern can't drift between them.
        const charge = estimate.credits;
        const chargeResult = await chargeCreditsAtomic(env, userId, charge);
        if (!chargeResult.ok) {
          await logSystemEvent(env, "CREDIT_CHARGE_SKIPPED",
            `Doc ${docId} completed but ${charge} credits could not be charged (insufficient balance)`,
            "info", userId).catch(() => { });
        }

        // Persist the actual credit cost on the document for receipts & history.
        await env.DB.prepare("UPDATE documents SET credits_used = ? WHERE id = ?")
          .bind(charge, docId).run();

        // Record AI token usage for the admin cost dashboard. When the
        // OCR-6 crop pass ran, its tokens are already folded into
        // total{Input,Output}Tokens above → still ONE ai_usage row per
        // user-perceived operation (metering rule: one extraction = one row).
        await logAiUsage(env, {
          userId, fn: "ocr",
          provider: target.provider, model: target.model,
          inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
          docId, fileName: file.name,
          // OCR-3: tag row so admin dashboards can filter retry cost.
          isRetry,
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

          if (chargeResult.ok && chargeResult.remaining != null && chargeResult.remaining > 0 && chargeResult.remaining <= 20) {
            await createNotification(env, {
              userId,
              kind: "credit_low",
              severity: "warning",
              title: "Credit running low",
              body: `${chargeResult.remaining} credits remaining`,
              link: "/billing",
              metadata: { remaining: chargeResult.remaining },
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
