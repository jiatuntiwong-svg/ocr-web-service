// Profile: compare
// Placeholder for the compare route — future wiring lands in S2-x when
// compare is rewritten around the OCR store. Today the compare route
// (`src/app/api/compare/route.ts`) has its own inline prompt and is out
// of scope for S2-2. This profile exists so the catalog is complete and
// so a future migration only needs to swap the callsite, not add a new
// profile.

import { SHARED_RULES_TH, SHARED_RULES_VERSION } from "./sharedRules";

export interface CompareCtx {
    /** Comma-separated list of field names being compared. */
    fields: string;
}

export const COMPARE_PROFILE = {
    id: "compare" as const,
    version: SHARED_RULES_VERSION,
    system: "Compare two documents field-by-field.",
    buildUserPrompt(ctx: CompareCtx): string {
        return `หน้าที่: เปรียบเทียบค่าของหัวข้อเดียวกันระหว่างเอกสาร 2 ฉบับ (SI vs BL) เฉพาะหัวข้อที่ระบุ: ${ctx.fields}

${SHARED_RULES_TH}

ตอบกลับเป็น JSON ตามโครงสร้าง compare route เดิม (ดู src/app/api/compare/route.ts).`;
    },
};
