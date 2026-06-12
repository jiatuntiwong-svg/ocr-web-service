// POC — verify Gemini can extract structured fields from Excel with cell coordinates.
// Run: GEMINI_API_KEY=xxx node scripts/poc-excel-extraction/run-poc.mjs
//
// Compares 4 prompt formats to find the one that gives best cell-coordinate accuracy.

import * as XLSX from "xlsx";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, "samples");

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("ERR: set GEMINI_API_KEY env var");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ─── Formatters: 4 ways to send sheet data to AI ───
function colLetter(c) {
    let s = "";
    c++;
    while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
}

function asJsonGrid(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
    return JSON.stringify(rows, null, 2);
}

function asCsv(sheet) {
    return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
}

function asMarkdown(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
    if (rows.length === 0) return "(empty)";
    const maxCols = Math.max(...rows.map(r => r.length));
    const header = Array.from({ length: maxCols }, (_, i) => colLetter(i));
    const sep = header.map(() => "---");
    const body = rows.map(r => Array.from({ length: maxCols }, (_, i) => String(r[i] ?? "")).join(" | "));
    return [header.join(" | "), sep.join(" | "), ...body].join("\n");
}

// Annotated CSV — each cell prefixed with its coord. Most explicit.
function asCsvCoord(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
    const out = [];
    rows.forEach((row, r) => {
        row.forEach((cell, c) => {
            if (cell != null && String(cell).trim() !== "") {
                out.push(`[${colLetter(c)}${r + 1}] ${cell}`);
            }
        });
    });
    return out.join("\n");
}

// ─── Build prompt ───
function buildPrompt(format, sheetData, sheetName) {
    return `คุณคือผู้ช่วยสกัดข้อมูลจากเอกสาร Excel (Shipping Invoice / Bill of Lading)

ด้านล่างคือเนื้อหาของ sheet "${sheetName}" ในรูปแบบ ${format}:

\`\`\`
${sheetData}
\`\`\`

หน้าที่: สกัดข้อมูลฟิลด์ดังต่อไปนี้ (เท่าที่หาได้):
- shipper_name (ชื่อบริษัทผู้ส่ง)
- shipper_address (ที่อยู่ผู้ส่ง — อาจกระจายหลายบรรทัด)
- consignee_name (ชื่อผู้รับ)
- consignee_address (ที่อยู่ผู้รับ — อาจกระจายหลายบรรทัด)
- vessel (เรือ)
- voyage (เที่ยว)
- port_of_loading
- port_of_discharge
- bl_number (Bill of Lading No)
- invoice_number
- invoice_date
- container_number
- gross_weight
- total_amount

ตอบกลับเป็น JSON เท่านั้น (ห้ามมี markdown/explanation):
{
  "<field_name>": {
    "value": "<ค่าที่สกัดได้>",
    "cells": [{"row": <0-based>, "col": <0-based>}, ...],
    "confidence": <0-100>
  },
  ...
}

หมายเหตุสำคัญ:
1. row/col เป็น 0-based (row 0 = แถวแรก, col 0 = column A)
2. หากข้อมูลฟิลด์เดียวกระจายหลาย cells (เช่น address มีหลายบรรทัด) → ใส่ cells หลาย entries
3. หากไม่พบฟิลด์ → ไม่ต้องใส่ใน output
4. value: รวมข้อความจากทุก cells ของฟิลด์นั้น (ใช้ space หรือ comma คั่น)`;
}

// ─── Call AI ───
async function callAI(prompt) {
    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        // Strip markdown fence if present
        const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();
        return JSON.parse(cleaned);
    } catch (e) {
        return { _error: e.message };
    }
}

// ─── Render: show sheet preview with AI highlights ───
function renderHighlights(sheet, aiResult) {
    if (aiResult._error) return `  ERROR: ${aiResult._error}`;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
    const lines = [];
    for (const [field, info] of Object.entries(aiResult)) {
        if (field.startsWith("_")) continue;
        lines.push(`  ${field}: "${String(info.value).slice(0, 80)}" (${info.confidence}%)`);
        if (Array.isArray(info.cells)) {
            for (const c of info.cells) {
                const actual = rows[c.row]?.[c.col];
                const match = String(actual ?? "").trim() !== "";
                const marker = match ? "✓" : "✗ EMPTY";
                lines.push(`    [${colLetter(c.col)}${c.row + 1}] ${marker}  actual: "${String(actual ?? "").slice(0, 60)}"`);
            }
        }
    }
    return lines.join("\n");
}

// ─── Main ───
const PROMPT_VARIANTS = [
    { name: "A. CSV plain",       fn: asCsv },
    { name: "B. JSON 2D array",   fn: asJsonGrid },
    { name: "C. Markdown table",  fn: asMarkdown },
    { name: "D. CSV+coords",      fn: asCsvCoord },
];

const samples = readdirSync(SAMPLES_DIR).filter(f => /\.xlsx?$/i.test(f));
console.log(`Found ${samples.length} samples: ${samples.join(", ")}\n`);

for (const sample of samples) {
    console.log("═".repeat(80));
    console.log(`FILE: ${sample}`);
    console.log("═".repeat(80));

    const buf = readFileSync(join(SAMPLES_DIR, sample));
    const wb = XLSX.read(buf);

    for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
        const rowCount = range.e.r + 1;
        const colCount = range.e.c + 1;
        console.log(`\n─ Sheet "${sheetName}" (${rowCount} rows × ${colCount} cols) ─`);

        for (const variant of PROMPT_VARIANTS) {
            console.log(`\n  >>> Prompt ${variant.name}`);
            const formatted = variant.fn(sheet);
            const prompt = buildPrompt(variant.name, formatted, sheetName);
            const start = Date.now();
            const result = await callAI(prompt);
            const ms = Date.now() - start;
            console.log(`  (${ms}ms)`);
            console.log(renderHighlights(sheet, result));
        }
    }
    console.log("");
}

console.log("DONE");
