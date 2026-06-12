// Node-only OCR extraction. Not used by the Cloudflare Worker route — the
// production compare flow does OCR in the browser (see frontend-ocr.ts) and
// matching in the browser too (see text-matcher.ts).
//
// This module is kept for: (a) local Node dev tooling/tests, (b) potential
// non-Worker server runtimes. NEVER import it from a route that ships to
// Cloudflare Workers — it pulls in optional native deps (canvas, tesseract.js,
// image-size) that won't resolve in the Worker runtime.
import { OCRToken } from "./types";

// Re-export matcher functions for backward compatibility with callers that
// historically imported them from this module.
export {
    matchValueToTokens,
    mergeTokenBoxes,
    normalizeStr,
} from "./text-matcher";
export type { MatchResult, MergedBox } from "./text-matcher";

async function extractPdfTokens(fileBuffer: ArrayBuffer): Promise<OCRToken[]> {
    const tokens: OCRToken[] = [];
    try {
        if (typeof globalThis.DOMMatrix === 'undefined') {
            (globalThis as any).DOMMatrix = class DOMMatrix {
                a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
            };
        }
        if (typeof globalThis.Path2D === 'undefined') {
            (globalThis as any).Path2D = class Path2D {};
        }

        // @ts-ignore
        const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
        const getDocument = pdfjs.getDocument;
        const loadingTask = getDocument({ data: new Uint8Array(fileBuffer), disableWorker: true, standardFontDataUrl: 'standard_fonts/' } as any);
        const pdf = await loadingTask.promise;

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1.0 });

            for (const item of textContent.items as any[]) {
                if (!item.str || item.str.trim() === "") continue;

                const pdfX = item.transform[4];
                const pdfY = item.transform[5];
                const itemW = (item.width  ?? 0) as number;
                const itemH = (item.height ?? 12) as number;
                const ASCENT_RATIO = 0.85;

                const nx = pdfX  / viewport.width;
                const ny = 1 - (pdfY + itemH * ASCENT_RATIO) / viewport.height;
                const nw = itemW / viewport.width;
                const nh = itemH * 1.10 / viewport.height;

                tokens.push({
                    text: item.str.trim(),
                    page: pageNum,
                    x: Math.max(0, Math.min(1, nx)),
                    y: Math.max(0, Math.min(1, ny)),
                    width: Math.max(0, Math.min(1, nw)),
                    height: Math.max(0, Math.min(1, nh)),
                });
            }
        }
        return tokens;
    } catch (error) {
        console.error("PDF.js module evaluation or parsing failed:", error);
        throw error;
    }
}

// Detect whether we're running in a Node-like environment with `require`.
// On Cloudflare Workers `require` doesn't exist; this lets us short-circuit
// the OCR path without throwing.
function isNodeRuntime(): boolean {
    return typeof (globalThis as any).process !== "undefined" &&
        !!(globalThis as any).process?.versions?.node &&
        // Cloudflare Workers expose WebSocketPair — Node does not
        typeof (globalThis as any).WebSocketPair === "undefined";
}

export async function extractDocumentTokens(
    fileBuffer: ArrayBuffer,
    mimeType: string
): Promise<OCRToken[]> {
    if (!isNodeRuntime()) {
        // Refuse to attempt Node-only OCR on edge runtimes. Callers should
        // rely on the frontend OCR pipeline instead.
        return [];
    }

    if (mimeType === "application/pdf") {
        try {
            const tokens = await extractPdfTokens(fileBuffer);
            if (tokens.length > 0) return tokens;
        } catch (err) {
            console.error("PDF token extraction failed, falling back to OCR", err);
        }

        // Scanned PDF fallback (Node only)
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { createCanvas } = require("canvas");
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const TesseractMod = require("tesseract.js");
            const Tesseract = TesseractMod.default || TesseractMod;

            if (typeof globalThis.DOMMatrix === 'undefined') {
                (globalThis as any).DOMMatrix = class DOMMatrix {
                    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
                };
            }
            if (typeof globalThis.Path2D === 'undefined') {
                (globalThis as any).Path2D = class Path2D {};
            }
            // @ts-ignore
            const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
            const getDocument = pdfjs.getDocument;
            const loadingTask = getDocument({ data: new Uint8Array(fileBuffer), disableWorker: true, standardFontDataUrl: 'standard_fonts/' } as any);
            const pdf = await loadingTask.promise;
            const worker = await Tesseract.createWorker("tha+eng");
            const allTokens: OCRToken[] = [];

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const viewport = page.getViewport({ scale: 2.0 });
                const canvas = createCanvas(viewport.width, viewport.height);
                const ctx = canvas.getContext("2d");
                await page.render({ canvasContext: ctx, viewport } as any).promise;

                const imgBuffer = canvas.toBuffer("image/jpeg");
                const { data } = await worker.recognize(imgBuffer);
                if (data && data.words) {
                    data.words.forEach((w: any) => {
                        if (!w.text.trim()) return;
                        allTokens.push({
                            text: w.text,
                            page: pageNum,
                            x: Math.max(0, Math.min(1, w.bbox.x0 / viewport.width)),
                            y: Math.max(0, Math.min(1, w.bbox.y0 / viewport.height)),
                            width: Math.max(0, Math.min(1, (w.bbox.x1 - w.bbox.x0) / viewport.width)),
                            height: Math.max(0, Math.min(1, (w.bbox.y1 - w.bbox.y0) / viewport.height)),
                        });
                    });
                }
            }
            await worker.terminate();
            return allTokens;
        } catch (e) {
            console.warn("Scanned-PDF OCR skipped:", (e as any)?.message);
            return [];
        }
    }

    // Image OCR (Node only)
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const TesseractMod = require("tesseract.js");
        const Tesseract = TesseractMod.default || TesseractMod;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sizeMod = require("image-size");
        const sizeOf = sizeMod.default || sizeMod.imageSize || sizeMod;
        const buffer = Buffer.from(fileBuffer);
        const dimensions = sizeOf(buffer);
        const width = dimensions.width || 1;
        const height = dimensions.height || 1;

        const worker = await Tesseract.createWorker("tha+eng");
        const { data } = await worker.recognize(buffer);
        await worker.terminate();

        const tokens: OCRToken[] = [];
        if (data?.words) {
            for (const w of data.words) {
                if (!w.text.trim()) continue;
                tokens.push({
                    text: w.text,
                    page: 1,
                    x: Math.max(0, Math.min(1, w.bbox.x0 / width)),
                    y: Math.max(0, Math.min(1, w.bbox.y0 / height)),
                    width: Math.max(0, Math.min(1, (w.bbox.x1 - w.bbox.x0) / width)),
                    height: Math.max(0, Math.min(1, (w.bbox.y1 - w.bbox.y0) / height)),
                });
            }
        }
        return tokens;
    } catch (error) {
        console.warn("Image OCR skipped:", (error as any)?.message);
        return [];
    }
}
