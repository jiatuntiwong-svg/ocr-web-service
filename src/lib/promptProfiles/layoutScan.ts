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
    /** 1-based list of UNIQUE field names in image-group order. When
     *  `scaleGroups` is omitted or every entry is 1, each fieldName is
     *  described by exactly one image (single-scale, OCR-6 behaviour). */
    fieldNames: string[];
    /** OCR-8b Rung 3 — dual-scale reconciliation.
     *  If provided, `scaleGroups[i]` is the number of images that describe
     *  `fieldNames[i]`. E.g. `[2, 2, 2]` means the caller sent
     *  [f0_hi, f0_lo, f1_hi, f1_lo, f2_hi, f2_lo]. When any entry is > 1
     *  the prompt tells the model to read each field from multiple scales
     *  and prefer the higher-DPI reading. `scaleLabels[i][j]` (optional)
     *  labels each image in a group — e.g. `["high", "med"]` — so the
     *  prompt can call them by name. */
    scaleGroups?: number[];
    scaleLabels?: string[][];
}

export const LAYOUT_SCAN_PROFILE = {
    id: "layout_scan" as const,
    version: SHARED_RULES_VERSION,
    system: "OCR focused crop pass — read the contents of each pre-cropped image verbatim.",
    buildUserPrompt(ctx: LayoutScanCtx): string {
        const groups = ctx.scaleGroups && ctx.scaleGroups.length === ctx.fieldNames.length
            ? ctx.scaleGroups
            : ctx.fieldNames.map(() => 1);
        const hasMultiScale = groups.some(g => g > 1);

        // Build a "1-2. field A (สูง, กลาง)" style label per group so the
        // model can map image index → fieldName + scale unambiguously.
        let cursor = 1;
        const cropLabels = ctx.fieldNames.map((name, i) => {
            const g = groups[i] ?? 1;
            const first = cursor;
            const last = cursor + g - 1;
            cursor = last + 1;
            if (g <= 1) return `${first}. "${name}"`;
            const labels = (ctx.scaleLabels?.[i] ?? []).slice(0, g);
            const scaleTag = labels.length === g
                ? ` (ภาพ ${first}-${last} = ${labels.map((l, k) => `${l} (ภาพที่ ${first + k})`).join(", ")})`
                : ` (ภาพ ${first}-${last} = เป็นภาพเดียวกันหลายขนาด, ภาพที่ ${first} = ความละเอียดสูงสุด)`;
            return `${first}-${last}. "${name}"${scaleTag}`;
        }).join("\n");

        const multiScaleNote = hasMultiScale
            ? `\n- ภาพหลายใบต่อ 1 หัวข้อ = "ภาพเดียวกันในหลายความละเอียด" ห้ามคืนหลายค่า ห้ามต่อค่าจากภาพต่างขนาด ให้อ่านจากภาพความละเอียดสูงสุดเป็นหลัก ใช้ภาพเล็กเป็น context ยืนยัน ถ้าอ่านได้ต่างกันให้เลือกคำที่ยาวกว่า/มีตัวอักษรครบกว่า (เช่น "รับบริจาค" ยาวกว่า "บริการ" → เลือก "รับบริจาค")`
            : "";
        return `แต่ละภาพต่อไปนี้คือ "บริเวณที่ครอบไว้" ของหัวข้อที่ต้องอ่านค่าจริงในหน้าเอกสารเดียวกัน ตามลำดับภาพ:
${cropLabels}${multiScaleNote}

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
