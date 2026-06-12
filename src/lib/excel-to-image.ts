// Convert .xlsx/.xls → image File at the browser, mirroring docx-to-image so
// the Compare pipeline can treat Excel like any other image (current Compare
// flow is image-based AI; native cell-coord Compare is deferred to Phase
// 6C-3b). Multi-sheet workbooks are stacked vertically.

import * as XLSX from "xlsx";
import html2canvas from "html2canvas";

const STYLES = `
    .docroom-xlsx { font-family: 'Segoe UI', Tahoma, 'Noto Sans Thai', Arial, sans-serif; font-size: 12px; color: #1f2937; }
    .docroom-xlsx .sheet-title { font-size: 14px; font-weight: 700; margin: 18px 0 8px; color: #374151; }
    .docroom-xlsx .sheet-title:first-child { margin-top: 0; }
    .docroom-xlsx table { border-collapse: collapse; margin-bottom: 12px; }
    .docroom-xlsx th, .docroom-xlsx td { border: 1px solid #cbd5e1; padding: 4px 8px; vertical-align: top; }
    .docroom-xlsx th { background: #f1f5f9; font-weight: 700; color: #475569; font-size: 10px; text-align: center; min-width: 40px; }
    .docroom-xlsx td { min-width: 70px; max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .docroom-xlsx td.row-head { background: #f8fafc; font-weight: 700; color: #64748b; font-size: 10px; text-align: center; min-width: 32px; }
`;

function colLetter(c: number): string {
    let s = "";
    c++;
    while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

function sheetToHtml(sheet: XLSX.WorkSheet, name: string): string {
    const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const colCount = range.e.c + 1;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null }) as any[][];

    const head = `<tr><th></th>${Array.from({ length: colCount }, (_, c) => `<th>${colLetter(c)}</th>`).join("")}</tr>`;
    const body = rows.map((row, r) => {
        const cells = Array.from({ length: colCount }, (_, c) => {
            const v = row[c];
            return `<td>${v == null ? "" : escapeHtml(String(v))}</td>`;
        }).join("");
        return `<tr><td class="row-head">${r + 1}</td>${cells}</tr>`;
    }).join("");

    return `<div class="sheet-title">Sheet: ${escapeHtml(name)}</div><table>${head}${body}</table>`;
}

export async function excelFileToImage(file: File): Promise<File> {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const html = wb.SheetNames.map(n => sheetToHtml(wb.Sheets[n], n)).join("");

    const container = document.createElement("div");
    container.className = "docroom-xlsx";
    container.style.cssText = [
        "position:absolute", "left:-99999px", "top:0",
        "background:#ffffff", "padding:32px",
        "box-sizing:border-box", "overflow:visible",
        "display:inline-block",  // shrink-to-fit so wide sheets aren't cropped
    ].join(";");

    const styleTag = document.createElement("style");
    styleTag.textContent = STYLES;
    container.appendChild(styleTag);

    const content = document.createElement("div");
    content.innerHTML = html;
    container.appendChild(content);

    document.body.appendChild(container);

    try {
        await new Promise(r => setTimeout(r, 150));

        const fullWidth = Math.max(container.scrollWidth, container.offsetWidth);
        const fullHeight = Math.max(container.scrollHeight, container.offsetHeight);

        const canvas = await html2canvas(container, {
            backgroundColor: "#ffffff",
            scale: 2,
            useCORS: true,
            logging: false,
            width: fullWidth,
            height: fullHeight,
            windowWidth: fullWidth,
            windowHeight: fullHeight,
        });

        const blob: Blob = await new Promise((resolve, reject) => {
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png");
        });

        const baseName = file.name.replace(/\.(xlsx|xls|xlsm)$/i, "");
        return new File([blob], `${baseName}.png`, { type: "image/png" });
    } finally {
        document.body.removeChild(container);
    }
}
