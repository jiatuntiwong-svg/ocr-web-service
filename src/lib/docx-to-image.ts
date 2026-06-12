// Convert .docx → image File at the browser so the result slots straight into
// the existing image preview/highlight pipeline.
//
// Library choice: mammoth.js
//
//   docx-preview was tried first because it preserves Word's pagination, fonts
//   and multi-column layouts. In practice it dropped large chunks of content on
//   real-world docs that used text frames or 2-column section layouts (header
//   right-side info + table cell values vanished). For Compare we need content
//   reliability — the AI must see every value — so mammoth is the right
//   trade-off: it linearises the layout into clean HTML but never loses text.

import mammoth from "mammoth";
import html2canvas from "html2canvas";

// Conservative print-style CSS injected around mammoth output so the rendered
// image looks like a document instead of unstyled HTML. Tables get borders so
// columns stay readable when overlay highlights land on them later.
const STYLES = `
    body, .docroom-docx { font-family: 'Segoe UI', Tahoma, 'Noto Sans Thai', Arial, sans-serif; font-size: 14px; line-height: 1.45; color: #1f2937; }
    .docroom-docx p { margin: 0 0 8px 0; }
    .docroom-docx h1 { font-size: 22px; font-weight: 700; margin: 16px 0 10px; }
    .docroom-docx h2 { font-size: 18px; font-weight: 700; margin: 14px 0 8px; }
    .docroom-docx h3 { font-size: 16px; font-weight: 600; margin: 12px 0 6px; }
    .docroom-docx h4, .docroom-docx h5, .docroom-docx h6 { font-size: 14px; font-weight: 600; margin: 10px 0 5px; }
    .docroom-docx table { border-collapse: collapse; margin: 10px 0; width: 100%; }
    .docroom-docx table, .docroom-docx th, .docroom-docx td { border: 1px solid #d1d5db; }
    .docroom-docx th, .docroom-docx td { padding: 6px 9px; vertical-align: top; }
    .docroom-docx th { background: #f3f4f6; font-weight: 700; }
    .docroom-docx ul, .docroom-docx ol { margin: 6px 0 10px 24px; padding: 0; }
    .docroom-docx li { margin: 2px 0; }
    .docroom-docx strong, .docroom-docx b { font-weight: 700; }
    .docroom-docx em, .docroom-docx i { font-style: italic; }
    .docroom-docx img { max-width: 100%; height: auto; }
    .docroom-docx hr { border: 0; border-top: 1px solid #d1d5db; margin: 12px 0; }
`;

export async function docxFileToImage(file: File): Promise<File> {
    const buffer = await file.arrayBuffer();

    // mammoth pulls every paragraph, table cell, header, footer and list out
    // of the OOXML, even from frames and odd structures. Output is plain HTML
    // (no Word-specific positioning) — exactly what we want for downstream OCR.
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
    const html = result.value || "";

    // Off-screen render container.
    const container = document.createElement("div");
    container.className = "docroom-docx";
    container.style.cssText = [
        "position:absolute",
        "left:-99999px",
        "top:0",
        "width:880px",
        "background:#ffffff",
        "padding:48px 56px",
        "box-sizing:border-box",
        "overflow:visible",
    ].join(";");

    const styleTag = document.createElement("style");
    styleTag.textContent = STYLES;
    container.appendChild(styleTag);

    const content = document.createElement("div");
    content.innerHTML = html;
    container.appendChild(content);

    document.body.appendChild(container);

    try {
        // Let the browser lay out + load any inline images mammoth produced.
        await new Promise(r => setTimeout(r, 250));

        const fullWidth = Math.max(container.scrollWidth, container.offsetWidth);
        const fullHeight = Math.max(container.scrollHeight, container.offsetHeight);

        const canvas = await html2canvas(container, {
            backgroundColor: "#ffffff",
            scale: 2,             // sharper for highlight overlay text matching
            useCORS: true,
            allowTaint: false,
            logging: false,
            width: fullWidth,
            height: fullHeight,
            windowWidth: fullWidth,
            windowHeight: fullHeight,
        });

        const blob: Blob = await new Promise((resolve, reject) => {
            canvas.toBlob(
                b => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
                "image/png",
            );
        });

        const baseName = file.name.replace(/\.docx?$/i, "");
        return new File([blob], `${baseName}.png`, { type: "image/png" });
    } finally {
        document.body.removeChild(container);
    }
}
