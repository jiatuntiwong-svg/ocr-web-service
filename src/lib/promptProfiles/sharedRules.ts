// Shared prompt rule block — one canonical source used by every OCR prompt
// profile so the rules can never drift again the way they did in OCR-6b
// (crop prompt was missing the whole-image rules). See:
//   • docs/080726/OCR_IMPROVEMENT_TECHNIQUES_KB.md §2
//   • pm/reports/S2-2.md (design notes)
//
// Any rule tweak here MUST bump `SHARED_RULES_VERSION` and be recorded in
// pm/reports/OCR-2-runs/ so a regression can be traced back to a prompt
// revision. S2-1 baseline (2026-07-12) was measured against pre-profile
// inline prompts; v1 below is the first versioned block.

// v3 (2026-07-15): added multi-page same-field rule for OCR-9 (same-name
// field appears on multiple pages with different values — previously only
// page-1 value returned; now returned as page-tagged joined string within
// the single-value schema. Structural multi-value response deferred to
// follow-up ticket per pm/reports/OCR-9.md).
// v2 (2026-07-12): added multi-scale reconciliation rule for OCR-8b Rung 3
// (dual-scale crop pass). Prior versions: v1 = first versioned block (S2-2).
export const SHARED_RULES_VERSION = "2026-07-15-v3";

/** Human-readable rule block, Thai. Prepended into every profile's user
 *  prompt so the model sees the same guardrails regardless of task. Keep
 *  each rule short and imperative — long paragraphs get ignored. */
export const SHARED_RULES_TH = `กฎการอ่าน + การแก้คำ (สำคัญมาก — ใช้กับทุกงาน):
- อ่านข้อความ "ทีละตัวอักษร" ตามที่เห็นจริงในภาพก่อน แล้วค่อยตัดสินใจว่าจะแก้หรือไม่
- ห้ามย่อคำ ห้ามตัดคำ ห้ามสลับคำใน string ค่าที่อ่านมา — ถ้าเห็นคำประสม/วลียาว ต้องคืนทั้ง phrase ตามที่เห็น ห้ามเปลี่ยนเป็นวลีอื่นแม้จะดูเข้าที่กว่า (เช่น ห้ามเปลี่ยน "รับบริจาค" เป็น "บริการ" — ทั้งสองเป็นคำจริงคนละคำ)
- อนุญาตให้แก้เฉพาะกรณีชัดเจนว่าเป็น typo (สะกดผิด/สลับตัวอักษร) และรู้แน่ว่าคำที่ถูกต้องคืออะไร — เช่น "Plastelet" → "Platelet", "recieve" → "receive"
- ห้ามเดา ห้ามตีความ ถ้าไม่แน่ใจว่าคำที่ถูกต้องคืออะไร ให้คงตามต้นฉบับ
- "ทุกครั้ง" ที่แก้คำ แม้จะเป็นการแก้ที่คิดว่าถูก (silent correction) ต้องบันทึกทั้ง original และ corrected ใน corrections[] — ห้ามเงียบ หากเจอสิ่งที่อยากแก้แต่ไม่ได้แก้ (เก็บต้นฉบับ) ก็ไม่ต้องรายงาน
- "value" ต้องเป็นข้อความเต็มทั้งบรรทัด/ทั้งช่อง (fulltext) — ห้ามย่อ ห้ามสรุป ห้ามตัดหัว ห้ามตัดท้าย
- ถ้าค่ากินหลายบรรทัดใต้ label เดียวกัน ต้องเอาทุกบรรทัดที่ต่อเนื่องกันจนกว่าจะเจอ label/หัวข้อถัดไป โดยคั่นบรรทัดด้วย "\\n"
- ห้าม "คัดกรอง" ค่าให้ตรงกับที่ชื่อหัวข้อสื่อความหมาย — เอาทุกคำที่ปรากฏในช่องนั้น รวมทั้งคำหน้า/คำท้ายที่ดูไม่เกี่ยว ผู้ใช้จะตัดเอง
- ห้ามยืมค่าจาก label อื่น (anti-borrowing) — ต้องจับคู่ค่ากับ label ที่ "ตัวสะกดตรงกันเป๊ะ" กับชื่อหัวข้อ ถ้าไม่พบ label ตรงในเอกสาร ให้ value เป็น null
- หัวข้อที่ระบุ type เป็น (raw_text) — ต้อง "คัดลอกตามที่เห็นทุกตัวอักษร" ห้ามแก้ typo ห้ามจัดฟอร์แมต ห้ามตัด/เพิ่มคำใดๆ และ corrections ต้องเป็น [] เสมอ
- ถ้า field ที่ระบุปรากฏหลายหน้าและค่าต่างกัน: คืน value ทุกค่าคั่นด้วย " | " โดยระบุหน้าไว้ข้างหน้าแต่ละค่า เช่น "[หน้า 1: XYZ-001 | หน้า 2: XYZ-002]". ถ้าค่าเหมือนกันทุกหน้า ให้คืนค่าเดียว (ไม่ต้องใส่ "[หน้า ...]" prefix)
- เมื่อได้รับภาพเดียวกันหลายขนาด (multi-scale): อ่านจากภาพความละเอียดสูงกว่าเป็นหลัก, ใช้ภาพเล็กเป็น context. ถ้าอ่านได้ต่างกัน ให้เลือกคำที่ยาวกว่า/มีตัวอักษรครบกว่า — ห้ามคืนคำที่สั้นกว่าเมื่อภาพความละเอียดสูงอ่านได้ยาวกว่า`;

/** Standard corrections/JSON contract paragraph re-used by extract-style
 *  profiles (extractFields, layoutScan). verbatim_transcribe returns a
 *  different shape and defines its own contract. */
export const CORRECTIONS_CONTRACT_TH = `field "corrections" — array ของทุกคำที่คุณแก้จากต้นฉบับ เช่น:
[{ "original": "Plastelet", "corrected": "Platelet", "reason": "typo" }]
หากไม่ได้แก้อะไรเลย ให้เป็น []`;
