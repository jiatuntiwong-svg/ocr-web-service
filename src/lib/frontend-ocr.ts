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

            const getDocument = pdfjs.getDocument;
            const loadingTask = getDocument({ data: new Uint8Array(arrayBuffer) });
            const pdf = await loadingTask.promise;

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();
                const viewport = page.getViewport({ scale: 1.0 });

                for (const item of textContent.items as any[]) {
                    if (!item.str || item.str.trim() === "") continue;

                    // Map PDF points to Viewport pixels accurately (handles CropBox, rotation, etc.)
                    const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
                    const [v_top_x, v_top_y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5] + item.height);
                    const [v_right_x, v_right_y] = viewport.convertToViewportPoint(item.transform[4] + item.width, item.transform[5]);

                    const v_height = Math.abs(vy - v_top_y);
                    const v_width = Math.abs(v_right_x - vx);

                    const x = Math.min(vx, v_right_x) / viewport.width;
                    const y = Math.min(vy, v_top_y) / viewport.height;
                    const width = v_width / viewport.width;
                    const height = v_height / viewport.height;

                    tokens.push({
                        text: item.str.trim(),
                        page: pageNum,
                        x: Math.max(0, Math.min(1, x)),
                        y: Math.max(0, Math.min(1, y)),
                        width: Math.max(0, Math.min(1, width)),
                        height: Math.max(0, Math.min(1, height)),
                    });
                }
            }
            if (tokens.length > 0) return tokens;
        } catch (err) {
            console.error("Frontend PDF token extraction failed, falling back to OCR", err);
        }

        // Tesseract PDF fallback can be complex, often requiring Canvas rendering which frontend can do!
        try {
            console.log("Rendering scanned PDF to canvas for OCR...");
            const pdfjs = await getPdfJs();
            const loadingTask = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) });
            const pdf = await loadingTask.promise;
            const worker = await Tesseract.createWorker("tha+eng");
            
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const viewport = page.getViewport({ scale: 2.0 });
                
                const canvas = document.createElement("canvas");
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const ctx = canvas.getContext("2d");
                
                if (ctx) {
                    await page.render({ canvasContext: ctx, viewport }).promise;
                    const dataUrl = canvas.toDataURL("image/jpeg");
                    
                    const { data } = await worker.recognize(dataUrl);
                    if (data && data.words) {
                        data.words.forEach((w: any) => {
                            if (!w.text.trim()) return;
                            tokens.push({
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
            }
            await worker.terminate();
            return tokens;
        } catch (err) {
            console.error("Frontend scanned PDF OCR failed", err);
        }
        
    } else {
        // Image processing
        try {
            console.log("Running Tesseract OCR for image...");
            const worker = await Tesseract.createWorker("tha+eng");
            const dataUrl = URL.createObjectURL(file);
            
            // Get image dimensions
            const img = new Image();
            img.src = dataUrl;
            await new Promise((resolve) => { img.onload = resolve; });
            const width = img.naturalWidth || 1;
            const height = img.naturalHeight || 1;

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (ctx) ctx.drawImage(img, 0, 0, width, height);

            const { data } = await worker.recognize(canvas);
            await worker.terminate();
            URL.revokeObjectURL(dataUrl);

            if (data && data.words) {
                data.words.forEach((w: any) => {
                    if (!w.text.trim()) return;
                    tokens.push({
                        text: w.text,
                        page: 1,
                        x: Math.max(0, Math.min(1, w.bbox.x0 / width)),
                        y: Math.max(0, Math.min(1, w.bbox.y0 / height)),
                        width: Math.max(0, Math.min(1, (w.bbox.x1 - w.bbox.x0) / width)),
                        height: Math.max(0, Math.min(1, (w.bbox.y1 - w.bbox.y0) / height)),
                    });
                });
            }
            return tokens;
        } catch (error) {
            console.error("Frontend image OCR skipped:", error);
        }
    }
    return tokens;
}
