import { OCRToken } from "./types";
import Tesseract from "tesseract.js";

export type SourceMethod = "text-layer" | "ocr-image" | "ocr-pdf-scan" | "none";

export interface ExtractResult {
    tokens: OCRToken[];
    sourceMethod: SourceMethod;
    error?: string;
}

function getPdfJs() {
    // @ts-ignore
    return (window as any).pdfjsLib || import("pdfjs-dist/build/pdf.mjs");
}

// Create a Tesseract worker tuned for Thai documents. Preserving inter-word
// spaces keeps Thai runs together; the bigger win is feeding hi-res images
// (see callers) so Tesseract stops splitting Thai into per-glyph fragments.
async function createTunedWorker() {
    const worker = await Tesseract.createWorker("tha+eng");
    try {
        await worker.setParameters({
            preserve_interword_spaces: "1",
            // PSM 3 = fully automatic page segmentation (handles columns).
            tessedit_pageseg_mode: "3" as any,
        });
    } catch { /* older tesseract.js may not accept — non-fatal */ }
    return worker;
}

/** @deprecated Use extractTokensWithMethod — kept for callers that only need tokens. */
export async function extractTokensOnFrontend(file: File): Promise<OCRToken[]> {
    return (await extractTokensWithMethod(file)).tokens;
}

// Debug logging gate. Enable via ?debug=1 (persists to localStorage) or
// localStorage.setItem("ocr_debug","1"). Read at module load so Next.js
// client routing stripping the query later doesn't matter.
let _dbgCached: boolean | null = null;
function dbg(): boolean {
    if (_dbgCached !== null) return _dbgCached;
    try {
        if (typeof window === "undefined") { _dbgCached = false; return false; }
        const url = new URL(window.location.href);
        if (url.searchParams.get("debug") === "1") {
            localStorage.setItem("ocr_debug", "1");
        }
        _dbgCached = localStorage.getItem("ocr_debug") === "1";
        return _dbgCached;
    } catch { _dbgCached = false; return false; }
}

function logExtract(file: File, method: SourceMethod, tokens: OCRToken[]) {
    if (!dbg()) return;
    /* eslint-disable no-console */
    console.groupCollapsed(`[ocr] ${file.name} — ${method} — ${tokens.length} tokens`);
    console.log("First 10 tokens:", tokens.slice(0, 10).map(t => ({
        text: t.text, page: t.page,
        x: +t.x.toFixed(3), y: +t.y.toFixed(3),
        w: +t.width.toFixed(3), h: +t.height.toFixed(3),
    })));
    // Sample tokens on each line (first 5 lines)
    const byLine = new Map<string, OCRToken[]>();
    for (const t of tokens) {
        const lk = `${t.page}:${Math.round(t.y * 100)}`;
        if (!byLine.has(lk)) byLine.set(lk, []);
        byLine.get(lk)!.push(t);
    }
    const lines = [...byLine.entries()].slice(0, 8).map(([lk, ts]) => ({
        line: lk, text: ts.map(t => t.text).join(" "), count: ts.length,
    }));
    console.log("First 8 lines (concat):", lines);
    console.groupEnd();
    /* eslint-enable no-console */
}

export async function extractTokensWithMethod(file: File): Promise<ExtractResult> {
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

                    // PDF: Y=0 at BOTTOM-LEFT; transform[5] is the baseline (not glyph top).
                    // Empirically, treating ascent ≈ 0.85 * itemH and expanding height by ~10%
                    // produces tight boxes that still cover Thai upper marks (สระบน/วรรณยุกต์)
                    // and Latin descenders.
                    const ASCENT_RATIO = 0.85;
                    const HEIGHT_PAD   = 1.10;
                    const nx = pdfX  / viewport.width;
                    const ny = 1 - (pdfY + itemH * ASCENT_RATIO) / viewport.height;
                    const nw = itemW / viewport.width;
                    const nh = (itemH * HEIGHT_PAD) / viewport.height;

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
            if (tokens.length > 5) {
                logExtract(file, "text-layer", tokens);
                return { tokens, sourceMethod: "text-layer" };
            }
        } catch (err) {
            console.error("Frontend PDF text-layer extraction failed, trying OCR fallback", err);
        }

        // --- Attempt 2: Scanned PDF — render page to canvas → Tesseract ---
        try {
            console.log("Rendering scanned PDF pages to canvas for Tesseract OCR...");
            const pdfjs = await getPdfJs();
            const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
            const worker = await createTunedWorker();

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                // Render at scale=3 — higher DPI markedly reduces Tesseract
                // per-glyph splitting of Thai. bbox fractions stay scale-free.
                const RENDER_SCALE = 3.0;
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
            logExtract(file, "ocr-pdf-scan", tokens);
            return { tokens, sourceMethod: "ocr-pdf-scan" };
        } catch (err) {
            console.error("Frontend scanned PDF OCR failed", err);
            return { tokens: [], sourceMethod: "none", error: (err as any)?.message || "PDF OCR failed" };
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

            // Upscale small scans so Thai glyphs are large enough for Tesseract
            // to keep them as words (not per-glyph). Target ≥2400px on the long
            // edge, capped at 3x to bound memory. bbox fractions are unaffected.
            const longEdge = Math.max(naturalW, naturalH);
            const scale = Math.min(3, Math.max(1, Math.round((2400 / longEdge) * 10) / 10));
            const canvas = document.createElement("canvas");
            canvas.width  = Math.round(naturalW * scale);
            canvas.height = Math.round(naturalH * scale);
            const ctx = canvas.getContext("2d");
            if (ctx) {
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }

            URL.revokeObjectURL(dataUrl);

            const worker = await createTunedWorker();
            const { data } = await worker.recognize(canvas);
            await worker.terminate();

            if (data?.words) {
                // bbox is in SCALED canvas pixels → divide by canvas size
                for (const w of data.words) {
                    if (!w.text.trim()) continue;
                    tokens.push({
                        text:   w.text,
                        page:   1,
                        x:      Math.max(0, Math.min(1, w.bbox.x0 / canvas.width)),
                        y:      Math.max(0, Math.min(1, w.bbox.y0 / canvas.height)),
                        width:  Math.max(0, Math.min(1, (w.bbox.x1 - w.bbox.x0) / canvas.width)),
                        height: Math.max(0, Math.min(1, (w.bbox.y1 - w.bbox.y0) / canvas.height)),
                    });
                }
            }
            logExtract(file, "ocr-image", tokens);
            return { tokens, sourceMethod: "ocr-image" };
        } catch (error) {
            console.error("Frontend image OCR failed:", error);
            return { tokens: [], sourceMethod: "none", error: (error as any)?.message || "Image OCR failed" };
        }
    }

    return { tokens, sourceMethod: "none" };
}
