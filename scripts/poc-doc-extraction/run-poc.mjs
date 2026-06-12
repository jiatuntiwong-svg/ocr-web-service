// POC — Test whether Gemini can extract text from raw .doc bytes.
// Run: GEMINI_API_KEY=xxx node scripts/poc-doc-extraction/run-poc.mjs
//
// Tries 3 mime-type variants since .doc is not officially supported in Gemini File API.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, basename } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Samples currently live in the excel POC folder
const SAMPLES = [
    join(__dirname, "..", "poc-excel-extraction", "samples", "BKKA20721000.doc"),
    join(__dirname, "..", "poc-excel-extraction", "samples", "BKKFY3315800.doc"),
];

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("ERR: set GEMINI_API_KEY env var");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const MIME_VARIANTS = [
    "application/msword",
    "application/vnd.ms-word",
    "application/octet-stream",
];

const EXTRACT_PROMPT = `นี่คือไฟล์ Word เอกสารเดินเรือ/ใบส่งของ ในรูปแบบ binary .doc (Office 97-2003).

หน้าที่: สกัด text content ทั้งหมดจากเอกสาร แสดงผลเป็น plain text โดยรักษาโครงสร้าง:
- คงลำดับ paragraph ตามต้นฉบับ
- คงตารางในรูปแบบ text (ใช้ | คั่นคอลัมน์, newline คั่นแถว)
- ระบุหัวข้อ/section heading ถ้ามี

ตอบกลับเฉพาะ extracted text เท่านั้น (ไม่ต้องอธิบาย ไม่ต้องใส่ markdown)`;

const EXTRACT_FIELDS_PROMPT = `นี่คือไฟล์ Word เอกสารเดินเรือ/ใบส่งของ ในรูปแบบ binary .doc.

สกัดฟิลด์ต่อไปนี้เท่าที่หาได้ ตอบเป็น JSON เท่านั้น:
- shipper_name, shipper_address
- consignee_name, consignee_address
- vessel, voyage
- port_of_loading, port_of_discharge
- bl_number, invoice_number, invoice_date
- container_number, gross_weight, total_amount

Format:
{
  "<field>": { "value": "...", "confidence": 0-100 }
}

ไม่พบฟิลด์ → ไม่ต้องใส่ใน output. ห้าม markdown fence.`;

async function tryExtract(filePath, mimeType, prompt, label) {
    const bytes = readFileSync(filePath);
    const base64 = bytes.toString("base64");
    try {
        const start = Date.now();
        const result = await model.generateContent([
            { inlineData: { mimeType, data: base64 } },
            prompt,
        ]);
        const ms = Date.now() - start;
        const text = result.response.text();
        return { ok: true, ms, text: text.trim(), len: text.length };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function preview(s, n = 600) {
    if (!s) return "";
    return s.length <= n ? s : s.slice(0, n) + "\n... [truncated, total " + s.length + " chars]";
}

for (const filePath of SAMPLES) {
    const name = basename(filePath);
    const size = readFileSync(filePath).length;
    console.log("\n" + "═".repeat(80));
    console.log(`FILE: ${name} (${(size / 1024).toFixed(1)} KB)`);
    console.log("═".repeat(80));

    for (const mime of MIME_VARIANTS) {
        console.log(`\n──── MIME: ${mime} ────`);

        console.log("\n  >>> Test A: extract all text");
        const a = await tryExtract(filePath, mime, EXTRACT_PROMPT, "text");
        if (a.ok) {
            console.log(`  ✓ ${a.ms}ms · ${a.len} chars`);
            console.log("  --- response preview ---");
            console.log(preview(a.text).split("\n").map(l => "  " + l).join("\n"));
        } else {
            console.log(`  ✗ ERROR: ${a.error}`);
        }

        console.log("\n  >>> Test B: extract structured fields");
        const b = await tryExtract(filePath, mime, EXTRACT_FIELDS_PROMPT, "fields");
        if (b.ok) {
            console.log(`  ✓ ${b.ms}ms · ${b.len} chars`);
            // Try parse JSON
            try {
                const cleaned = b.text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();
                const json = JSON.parse(cleaned);
                console.log("  --- parsed fields ---");
                for (const [k, v] of Object.entries(json)) {
                    console.log(`    ${k}: "${String(v.value).slice(0, 60)}" (${v.confidence}%)`);
                }
            } catch (e) {
                console.log("  ⚠ Not valid JSON. Raw preview:");
                console.log(preview(b.text, 400).split("\n").map(l => "  " + l).join("\n"));
            }
        } else {
            console.log(`  ✗ ERROR: ${b.error}`);
        }
    }
}

console.log("\nDONE");
