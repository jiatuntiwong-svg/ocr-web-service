// Profile: layout_scan
// Inspired by Chandra `ocr_layout` — the crop-pass mini prompt for OCR-6.
// Each image sent is a pre-cropped region for exactly one field; response
// is text-only per field. Kept small on purpose (no hint rules, no page
// preamble, no bbox record — those are irrelevant when the image IS the
// bbox). Reuses the shared rule block to guarantee the crop pass never
// silently loses no-autocorrect / anti-borrowing again (OCR-6b regression
// root cause).

import { SHARED_RULES_TH, SHARED_RULES_VERSION, CORRECTIONS_CONTRACT_TH } from "./sharedRules";

export interface LayoutScanCtx {
    /** 1-based list of field names in the same order as the image parts. */
    fieldNames: string[];
}

export const LAYOUT_SCAN_PROFILE = {
    id: "layout_scan" as const,
    version: SHARED_RULES_VERSION,
    system: "OCR focused crop pass — read the contents of each pre-cropped image verbatim.",
    buildUserPrompt(ctx: LayoutScanCtx): string {
        const cropLabels = ctx.fieldNames.map((n, i) => `${i + 1}. "${n}"`).join("\n");
        return `แต่ละภาพต่อไปนี้คือ "บริเวณที่ครอบไว้" ของหัวข้อที่ต้องอ่านค่าจริงในหน้าเอกสารเดียวกัน ตามลำดับภาพ:
${cropLabels}

หน้าที่ (สำคัญมาก):
- "ข้อความทั้งหมดในภาพแต่ละใบคือค่าของหัวข้อนั้น" — ห้ามหยิบจากที่อื่น ห้ามคัดกรอง ห้ามตีความว่าตรง/ไม่ตรงกับชื่อหัวข้อ
- ต้องเอา "ทุกบรรทัดที่ปรากฏในภาพ" ห้ามข้ามบรรทัดที่ 2 หรือ 3 คั่นบรรทัดด้วย "\\n"
- ถ้าไม่พบข้อความใดๆ ในภาพเลย ให้ value = null

${SHARED_RULES_TH}

ตอบกลับเป็น JSON ก้อนเดียวเท่านั้น (ห้าม markdown):
{
  "<fieldName ตรงตามที่ระบุด้านบน>": { "value": "<ค่าเต็ม หรือ null>", "confidence": 0-100, "corrections": [] }
}
- key ของทุกหัวข้อต้องตรง "ตัวสะกดเป๊ะ" กับชื่อในรายการด้านบน ห้ามเพิ่มหัวข้ออื่น
- ${CORRECTIONS_CONTRACT_TH}`;
    },
};
