// Profile: verbatim_transcribe
// Full-document transcription mode. Client-side (OCRWorkspaceV2) sends
// `mode=fulldoc` for this profile. Response is a per-page transcript, not
// a field record. Was previously stubbed on the server (see upload/route
// batch code: the mode field was ignored and only `raw_text` field extract
// happened). S2-2 makes this real.

import { SHARED_RULES_TH, SHARED_RULES_VERSION } from "./sharedRules";

export interface VerbatimTranscribeCtx {
    /** When set, prepend the page-selection preamble so the model outputs
     *  page keys matching ORIGINAL PDF page numbers rather than 1..N of the
     *  stacked-image order. Empty = whole document, use 1..N sequentially. */
    selectedPages?: number[];
}

export const VERBATIM_TRANSCRIBE_PROFILE = {
    id: "verbatim_transcribe" as const,
    version: SHARED_RULES_VERSION,
    system: "OCR full-document transcription — verbatim, per page.",
    buildUserPrompt(ctx: VerbatimTranscribeCtx): string {
        const pages = ctx.selectedPages && ctx.selectedPages.length > 0
            ? ctx.selectedPages
            : null;
        const preamble = pages
            ? `หมายเหตุ: ภาพนี้คือหน้าที่เลือก "เรียงต่อกันจากบนลงล่าง" ตามลำดับหมายเลขหน้าต้นฉบับ: ${pages.join(", ")}. ให้ใช้หมายเลขหน้าต้นฉบับเหล่านี้เป็น key ของ pages[] ในผลลัพธ์.\n\n`
            : `หมายเหตุ: ภาพนี้คือทุกหน้าของเอกสารเรียงต่อกันจากบนลงล่าง. ใช้เลขหน้า 1..N ตามลำดับที่เห็น.\n\n`;

        return `${preamble}หน้าที่: ถอดข้อความทั้งหมดในภาพแบบ verbatim (ทีละหน้า) — ไม่ต้องตีความ ไม่ต้องเลือกฟิลด์

${SHARED_RULES_TH}

ข้อกำหนดในการตอบกลับ (JSON format เท่านั้น — ห้าม markdown):
{
  "pages": [
    { "page": <int>, "text": "<เนื้อหาทั้งหน้า, คั่นบรรทัดด้วย \\n>" }
  ],
  "corrections": [ { "page": <int>, "original": "...", "corrected": "...", "reason": "..." } ]
}
- "page" คือหมายเลขหน้าต้นฉบับ (ตามหมายเหตุด้านบน)
- "text" ต้องเป็นข้อความเต็มของหน้านั้น รวมทุกบรรทัดตามลำดับที่เห็น (บนลงล่าง, ซ้ายไปขวา)
- "corrections" รวมทุก typo ที่คุณแก้ (จากทุกหน้า) พร้อมระบุหน้าที่แก้ หากไม่ได้แก้อะไรเลย ให้เป็น []`;
    },
};
