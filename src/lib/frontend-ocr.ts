import { OCRToken } from "./types";
import Tesseract from "tesseract.js";

function getPdfJs() {
    // @ts-ignore
    return (window as any).pdfjsLib || import("pdfjs-dist/build/pdf.mjs");
}

export async function extractTokensOnFrontend(file: File): Promise<OCRToken[]> {
    const tokens: OCRToken[] = [];
    const arrayBuffer = await file.arrayBuffer();

    if (file.type === "application/pdf") {
        // --- Attempt 1: Text-layer extraction (text PDFs) ---
        try {
            if (typeof globalThis.DOMMatrix === "undefined") {
                (globalThis as any).DOMMatrix = class DOMMatrix { a=1;b=0;c=0;d=1;e=0;f=0; };
            }
            if (typeof globalThis.Path2D === "undefined") {
                (globalThis as any).Path2D = class Path2D {};
            }
            const pdfjs = await getPdfJs();
            if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
                pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
            }

            const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                // CRITICAL: extract at scale=1 — react-pdf <Page> normalises coordinates at scale=1 internally
                const viewport = page.getViewport({ scale: 1.0 });
                const textContent = await page.getTextContent();

                for (const item of textContent.items as any[]) {
                    if (!item.str || item.str.trim() === "") continue;

                    const pdfX = item.transform[4];
                    const pdfY = item.transform[5];
                    const itemW = (item.width  ?? 0) as number;
                    const itemH = (item.height ?? 12) as number;

                    // PDF coordinate: Y=0 at BOTTOM-LEFT → flip to CSS: Y=0 at TOP-LEFT
                    // Top of the glyph in PDF space = pdfY + itemH
                    const nx = pdfX  / viewport.width;
                    const ny = 1 - (pdfY + itemH) / viewport.height;
                    const nw = itemW / viewport.width;
                    const nh = itemH / viewport.height;

                    tokens.push({
                        text:   item.str.trim(),
                        page:   pageNum,
                        x:      Math.max(0, Math.min(1, nx)),
                        y:      Math.max(0, Math.min(1, ny)),
                        width:  Math.max(0, Math.min(1, nw)),
                        height: Math.max(0, Math.min(1, nh)),
                    });
                }
            }

            // If we found meaningful tokens it's a text PDF — return them
            if (tokens.length > 5) return tokens;
        } catch (err) {
            console.error("Frontend PDF text-layer extraction failed, trying OCR fallback", err);
        }

        // --- Attempt 2: Scanned PDF — render page to canvas → Tesseract ---
        try {
            console.log("Rendering scanned PDF pages to canvas for Tesseract OCR...");
            const pdfjs = await getPdfJs();
            const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
            const worker = await Tesseract.createWorker("tha+eng");

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                // Render at scale=2 for sharper OCR; bbox fractions are scale-independent
                const RENDER_SCALE = 2.0;
                const viewport = page.getViewport({ scale: RENDER_SCALE });

                const canvas = document.createElement("canvas");
                canvas.width  = Math.round(viewport.width);
                canvas.height = Math.round(viewport.height);
                const ctx = canvas.getContext("2d");
                if (!ctx) continue;

                await page.render({ canvasContext: ctx, viewport }).promise;

                const { data } = await worker.recognize(canvas);
                if (data?.words) {
                    for (const w of data.words) {
                        if (!w.text.trim()) continue;
                        // bbox is in canvas pixels at RENDER_SCALE — divide by canvas size for fractions
                        tokens.push({
                            text:   w.text,
                            page:   pageNum,
                            x:      Math.max(0, Math.min(1, w.bbox.x0 / canvas.width)),
                            y:      Math.max(0, Math.min(1, w.bbox.y0 / canvas.height)),
                            width:  Math.max(0, Math.min(1, (w.bbox.x1 - w.bbox.x0) / canvas.width)),
                            height: Math.max(0, Math.min(1, (w.bbox.y1 - w.bbox.y0) / canvas.height)),
                        });
                    }
                }
            }
            await worker.terminate();
            return tokens;
        } catch (err) {
            console.error("Frontend scanned PDF OCR failed", err);
        }

    } else {
        // --- Image file → Tesseract at natural resolution ---
        try {
            console.log("Running Tesseract OCR for image...");
            const dataUrl = URL.createObjectURL(file);

            const img = new Image();
            img.src = dataUrl;
            await new Promise<void>((resolve) => { img.onload = () => resolve(); });

            const naturalW = img.naturalWidth  || 1;
            const naturalH = img.naturalHeight || 1;

            // Draw at NATURAL dimensions — avoids devicePixelRatio / CSS pixel confusion
            const canvas = document.createElement("canvas");
            canvas.width  = naturalW;
            canvas.height = naturalH;
            const ctx = canvas.getContext("2d");
            if (ctx) ctx.drawImage(img, 0, 0, naturalW, naturalH);

            URL.revokeObjectURL(dataUrl);

            const worker = await Tesseract.createWorker("tha+eng");
            const { data } = await worker.recognize(canvas);
            await worker.terminate();

            if (data?.words) {
                for (const w of data.words) {
                    if (!w.text.trim()) continue;
                    tokens.push({
                        text:   w.text,
                        page:   1,
                        x:      Math.max(0, Math.min(1, w.bbox.x0 / naturalW)),
                        y:      Math.max(0, Math.min(1, w.bbox.y0 / naturalH)),
                        width:  Math.max(0, Math.min(1, (w.bbox.x1 - w.bbox.x0) / naturalW)),
                        height: Math.max(0, Math.min(1, (w.bbox.y1 - w.bbox.y0) / naturalH)),
                    });
                }
            }
            return tokens;
        } catch (error) {
            console.error("Frontend image OCR failed:", error);
        }
    }

    return tokens;
}
