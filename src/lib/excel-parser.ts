// Shared Excel parsing utilities. Used by:
//   - /api/upload Excel branch  → CSV+coords text for the AI prompt
//   - <ExcelPreview>            → 2D arrays for HTML rendering
//
// Cell coords are 0-based throughout. Sheet index is 0-based too. The AI
// returns cells as { sheet, row, col }; the renderer uses the same triple.

import * as XLSX from "xlsx";

export interface ExcelCellRef { sheet: number; row: number; col: number }
export interface ExcelSheet {
    name: string;
    rows: any[][];   // 2D array, blank-padded so row.length is consistent
    rowCount: number;
    colCount: number;
}

/** Parse a workbook from an ArrayBuffer (browser or Worker) into sheet arrays. */
export function parseExcel(buffer: ArrayBuffer): ExcelSheet[] {
    const wb = XLSX.read(buffer, { type: "array" });
    return wb.SheetNames.map(name => sheetToArray(wb.Sheets[name], name));
}

function sheetToArray(sheet: XLSX.WorkSheet, name: string): ExcelSheet {
    const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const rowCount = range.e.r + 1;
    const colCount = range.e.c + 1;
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1, blankrows: false, defval: null,
    }) as any[][];
    // Normalise: pad short rows so col indices line up across rows.
    const padded = rows.map(r => {
        const out = new Array(colCount).fill(null);
        for (let i = 0; i < Math.min(r.length, colCount); i++) out[i] = r[i];
        return out;
    });
    return { name, rows: padded, rowCount, colCount };
}

/** Column index → letter (0 → "A", 25 → "Z", 26 → "AA"). */
export function colLetter(c: number): string {
    let s = "";
    c++;
    while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
}

/**
 * Convert a workbook into the CSV+coords format that POC proved most accurate
 * for Gemini (each non-empty cell prefixed with `[A1]`-style coord).
 * Sheets are stacked with a `### Sheet N` header line so the AI can return
 * coords keyed back to the right sheet.
 */
export function workbookToPromptText(sheets: ExcelSheet[]): string {
    const blocks: string[] = [];
    sheets.forEach((sh, sIdx) => {
        const lines: string[] = [`### Sheet ${sIdx}: "${sh.name}" (${sh.rowCount} rows × ${sh.colCount} cols)`];
        sh.rows.forEach((row, r) => {
            row.forEach((cell, c) => {
                if (cell != null && String(cell).trim() !== "") {
                    lines.push(`[S${sIdx}!${colLetter(c)}${r + 1}] ${cell}`);
                }
            });
        });
        blocks.push(lines.join("\n"));
    });
    return blocks.join("\n\n");
}

/**
 * Client-side text matcher — used by Compare to highlight Excel cells whose
 * contents match a value the AI extracted. Bidirectional substring match
 * after currency/whitespace/case normalisation so "ABC Co." matches the
 * fuller "ABC Co., Ltd." in either direction.
 *
 * Best-effort only: a value present in multiple cells will highlight all of
 * them. False positives are acceptable for visual guidance.
 */
export function findCellMatches(sheets: ExcelSheet[], value: any): ExcelCellRef[] {
    if (value == null) return [];
    const needle = normalizeForMatch(String(value));
    if (needle.length < 2) return [];
    const out: ExcelCellRef[] = [];
    sheets.forEach((sh, sIdx) => {
        sh.rows.forEach((row, r) => {
            row.forEach((cell, c) => {
                if (cell == null) return;
                const hay = normalizeForMatch(String(cell));
                if (hay.length < 2) return;
                if (hay.includes(needle) || needle.includes(hay)) {
                    out.push({ sheet: sIdx, row: r, col: c });
                }
            });
        });
    });
    return out;
}

function normalizeForMatch(s: string): string {
    return s.toLowerCase().replace(/[,\s_฿$€£¥]/g, "").trim();
}

/** Match a File against Excel mime types or extensions. */
export function isExcelFile(file: File | { name: string; type: string }): boolean {
    const t = (file.type || "").toLowerCase();
    if (t.includes("spreadsheetml") || t === "application/vnd.ms-excel") return true;
    return /\.(xlsx|xls|xlsm)$/i.test(file.name);
}
