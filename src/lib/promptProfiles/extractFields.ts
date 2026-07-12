// Profile: extract_fields
// The whole-image AI call that reads the stacked-PNG upload and returns a
// { value, confidence, corrections, bbox } record per requested field.
// Wired from /api/upload (single + batch) and /api/v1/extract.
//
// bbox is only produced by /api/upload today; /api/v1/extract asks for the
// simpler 3-field record. Both paths reuse the same shared rule block.

import { SHARED_RULES_TH, SHARED_RULES_VERSION, CORRECTIONS_CONTRACT_TH } from "./sharedRules";

export interface ExtractFieldsCtx {
    /** Full descriptor block — one field per line, with optional bbox_hint
     *  spatial anchors when the caller sent structured fields. */
    fieldsBlock: string;
    /** When set, prepend the page-selection preamble so the model knows
     *  which original PDF pages made it into the stacked image and in what
     *  order (bbox_hint.page semantics — API-1). */
    selectedPages?: number[];
    /** Whether the caller wants the bbox record in the response. `/api/upload`
     *  uses it; `/api/v1/extract` skips it (public API stayed on the smaller
     *  record). */
    includeBbox: boolean;
}

export const EXTRACT_FIELDS_PROFILE = {
    id: "extract_fields" as const,
    version: SHARED_RULES_VERSION,
    system: "OCR field extraction with strict verbatim reading.",
    buildUserPrompt(ctx: ExtractFieldsCtx): string {
        const pageSelectionPreamble = ctx.selectedPages && ctx.selectedPages.length > 0
            ? `หมายเหตุ: ผู้ใช้เลือกเฉพาะบางหน้าของ PDF ต้นฉบับ. ภาพที่คุณเห็นคือหน้าที่เลือก "เรียงต่อกันจากบนลงล่าง" ตามลำดับต่อไปนี้ (เลขคือหมายเลขหน้าจริงในเอกสารต้นฉบับ): ${ctx.selectedPages.join(", ")}. หากหัวข้อระบุ "page N" ให้ตีความว่าเป็นหมายเลขหน้าต้นฉบับ (มองหาเฉพาะในภาพของหน้านั้นถ้ามีในลำดับด้านบน).\n\n`
            : "";

        const hintRule = ctx.includeBbox
            ? `- หัวข้อที่มี [hint: x=...%, y=...%] คือ "ตำแหน่งที่คาดว่าค่าจะอยู่" (0-100% ของขนาดภาพ, มุมซ้ายบน = 0,0) — ให้ค้นในบริเวณของกรอบ "และพื้นที่ใต้กรอบเสมอ" (สำหรับค่าที่ผู้เขียนกรอกล้นออกใต้เส้น/ใต้ label) ไม่จำกัดเฉพาะภายในกรอบ; หากไม่พบทั้งในกรอบและใต้กรอบเลย จึงค่อย fallback semantic search ทั่วภาพเป็นทางเลือกสุดท้าย\n`
            : "";

        const responseShape = ctx.includeBbox
            ? `1. สำหรับแต่ละหัวข้อ ให้ตอบกลับเป็น Object โครงสร้าง:
   { "value": "ค่าที่ดึงได้ (หรือ null)", "confidence": 0-100, "corrections": [], "bbox": {"x":0-1,"y":0-1,"width":0-1,"height":0-1,"page":1} }
2. field "bbox" — ตำแหน่งจริงของ value ในภาพ (relative 0-1) ที่คุณใช้ในการอ่านค่า สำหรับนำไปเทียบกับ hint ในรอบถัดไป หากไม่พบค่าให้ bbox เป็น null
3. ${CORRECTIONS_CONTRACT_TH}
4. หากเป็นประเภท (date) ให้ตอบ "value" เป็น YYYY-MM-DD
5. หากเป็นประเภท (table) ให้ตอบ "value" เป็น Array of Objects และ "confidence" เป็นค่าเฉลี่ยของตารางนั้น (bbox = ครอบทั้งตาราง)
6. ตอบกลับเป็น JSON ก้อนเดียวที่มี "key ตามหัวข้อที่ระบุด้านบนเท่านั้น" — ห้ามเพิ่มหัวข้ออื่น ห้ามคง key เก่าจากคำสั่งก่อนหน้า`
            : `1. สำหรับแต่ละหัวข้อ ให้ตอบกลับเป็น Object โครงสร้าง:
   { "value": "ค่าที่ดึงได้ (หรือ null)", "confidence": 0-100, "corrections": [] }
2. ${CORRECTIONS_CONTRACT_TH}
3. หากเป็นประเภท (date) ให้ตอบ "value" เป็น YYYY-MM-DD
4. หากเป็นประเภท (table) ให้ตอบ "value" เป็น Array of Objects และ "confidence" เป็นค่าเฉลี่ยของตารางนั้น
5. ตอบกลับเป็น JSON ก้อนเดียวที่มี "key ตามหัวข้อที่ระบุด้านบนเท่านั้น" — ห้ามเพิ่มหัวข้ออื่น ห้ามคง key เก่าจากคำสั่งก่อนหน้า`;

        return `${pageSelectionPreamble}หน้าที่: ดึงข้อมูลตามหัวข้อและประเภทที่ระบุเท่านั้น

หัวข้อที่ต้องดึง:
${ctx.fieldsBlock}

${SHARED_RULES_TH}
${hintRule}
ข้อกำหนดในการตอบกลับ (JSON format เท่านั้น):
${responseShape}`;
    },
};
