// Removed top-level import of pdfjs-dist to prevent Edge worker module evaluation crash
import { OCRToken } from "./types";
// tesseract.js and image-size are optional – loaded dynamically so esbuild
// never bundles their native .node binaries into the Cloudflare Worker.
// pdfjs-dist: do NOT set GlobalWorkerOptions.workerSrc here.
// We use disableWorker:true in every getDocument() call so it works in both
// Node.js and the Cloudflare Workers runtime (no Web Worker / importScripts).

async function extractPdfTokens(fileBuffer: ArrayBuffer): Promise<OCRToken[]> {
    const tokens: OCRToken[] = [];
    try {
        // Polyfill DOM objects required by the browser build of pdf.js
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

            // pdf.js coordinates system is from bottom left
            // item.transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
            const x = item.transform[4] / viewport.width;
            let y = (viewport.height - item.transform[5]) / viewport.height;
            const width = item.width / viewport.width;
            const height = item.height / viewport.height;
            
            // Adjust y to be the top-left rather than bottom-left
            y = y - height;

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
    return tokens;
    } catch (error) {
        console.error("PDF.js module evaluation or parsing failed:", error);
        throw error; // Rethrow to let the fallback mechanism take over
    }
}

export async function extractDocumentTokens(
    fileBuffer: ArrayBuffer,
    mimeType: string
): Promise<OCRToken[]> {
    if (mimeType === "application/pdf") {
        try {
            const tokens = await extractPdfTokens(fileBuffer);
            if (tokens.length > 0) return tokens;
        } catch (err) {
            console.error("PDF token extraction failed, falling back to OCR", err);
        }

        // Fallback for Scanned PDF using canvas + Tesseract (Node.js only, not Cloudflare edge)
        try {
            console.log("Rendering scanned PDF to canvas for OCR...");
            // Dynamic require so esbuild treats these as external and
            // does NOT bundle the native .node binary into the CF Worker.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { createCanvas } = require("canvas");
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { default: Tesseract } = require("tesseract.js");

            // Load pdf.js dynamically to avoid top-level crash on edge
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
            // canvas or tesseract not available (Cloudflare edge) – skip silently
            console.warn("Scanned-PDF OCR skipped (canvas/tesseract not available in this runtime)", (e as any)?.message);
        }
        return [];
    }

    // Image OCR with Tesseract (dynamic require – optional, not available on CF edge)
    try {
        console.log("Running Tesseract OCR for image...");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { default: Tesseract } = require("tesseract.js");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { default: sizeOf } = require("image-size");
        const buffer = Buffer.from(fileBuffer);
        const dimensions = sizeOf(buffer);
        const width = dimensions.width || 1;
        const height = dimensions.height || 1;

        const worker = await Tesseract.createWorker("tha+eng");
        const { data } = await worker.recognize(buffer);
        await worker.terminate();

        const tokens: OCRToken[] = [];
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
        // tesseract/image-size not available in this runtime
        console.warn("Image OCR skipped (tesseract/image-size not available in this runtime)", (error as any)?.message);
    }
    return [];
}

interface TableCell {
    cleanText: string;
    tokens: any[];
}

interface TableRow {
    cleanText: string;
    cells: TableCell[];
    tokens: any[];
}

// Helper to build rows and cells from tokens
function buildTableStructure(tokens: OCRToken[]): TableRow[] {
    if (tokens.length === 0) return [];
    
    const byPage = tokens.reduce((acc, t) => {
        if (!acc[t.page]) acc[t.page] = [];
        acc[t.page].push(t);
        return acc;
    }, {} as Record<number, OCRToken[]>);

    const rows: TableRow[] = [];
    for (const pageTokens of Object.values(byPage)) {
        const sorted = [...pageTokens].sort((a, b) => {
            if (Math.abs(a.y - b.y) > Math.max(a.height, b.height) * 0.5) return a.y - b.y;
            return a.x - b.x;
        });

        // Group into physical rows
        const pageRows: OCRToken[][] = [];
        let currentLine = [sorted[0]];
        for (let i = 1; i < sorted.length; i++) {
            const current = currentLine[currentLine.length - 1];
            const next = sorted[i];
            const isSameLine = Math.abs(current.y - next.y) < Math.max(current.height, next.height) * 0.5;
            if (isSameLine) {
                currentLine.push(next);
            } else {
                pageRows.push(currentLine);
                currentLine = [next];
            }
        }
        pageRows.push(currentLine);

        // For each physical row, split into cells based on horizontal gap
        for (const lineTokens of pageRows) {
            const cells: TableCell[] = [];
            let currentCell = [lineTokens[0]];
            for (let i = 1; i < lineTokens.length; i++) {
                const current = currentCell[currentCell.length - 1];
                const next = lineTokens[i];
                const horizontalGap = next.x - (current.x + current.width);
                // A gap larger than 0.05 usually means a new column
                if (horizontalGap < 0.05) {
                    currentCell.push(next);
                } else {
                    cells.push({
                        cleanText: currentCell.map(t => (t as any).cleanText || t.text.toLowerCase().replace(/[^\w\s\u0E00-\u0E7F]/g, "")).join(" "),
                        tokens: currentCell
                    });
                    currentCell = [next];
                }
            }
            cells.push({
                cleanText: currentCell.map(t => (t as any).cleanText || t.text.toLowerCase().replace(/[^\w\s\u0E00-\u0E7F]/g, "")).join(" "),
                tokens: currentCell
            });

            rows.push({
                cleanText: lineTokens.map(t => (t as any).cleanText || t.text.toLowerCase().replace(/[^\w\s\u0E00-\u0E7F]/g, "")).join(" "),
                cells,
                tokens: lineTokens
            });
        }
    }
    return rows;
}

export function matchValueToTokens(value: string, tokens: OCRToken[], isTableField: boolean = false, counterpartVal?: string): OCRToken[] {
    if (!value) return [];
    
    // Normalize string to match token words, preserving Thai characters
    const normalizeStr = (s: string) => s.trim().toLowerCase().replace(/[^\w\s\u0E00-\u0E7F]/g, "");
    
    const normalizedTokens = tokens.map(t => ({
        ...t,
        cleanText: t.text.toLowerCase().replace(/[^\w\s\u0E00-\u0E7F]/g, "")
    }));

    // For tables, use context-aware row and cell diffing
    if (isTableField && counterpartVal) {
        const valLines = value.split('\n').map(l => l.trim()).filter(Boolean);
        const counterLines = counterpartVal.split('\n').map(l => l.trim()).filter(Boolean);
        
        const diffLinesInfo = [];
        for (let i = 0; i < valLines.length; i++) {
            if (valLines[i] !== counterLines[i]) {
                diffLinesInfo.push({ valLine: valLines[i], counterLine: counterLines[i] || "" });
            }
        }
        
        const rows = buildTableStructure(normalizedTokens);
        let matchInfo: OCRToken[] = [];

        for (const diffInfo of diffLinesInfo) {
            const targetWords = normalizeStr(diffInfo.valLine).split(/\s+/).filter(Boolean);
            if (targetWords.length === 0) continue;
            
            // 1) Find the target Row
            let bestRow: TableRow | null = null;
            let bestScore = 0;
            for (const row of rows) {
                let matches = 0;
                for (const mw of targetWords) {
                    if (row.cleanText.includes(mw)) matches++;
                }
                const score = matches / Math.max(targetWords.length, 1);
                if (score > bestScore && score > 0.3) {
                    bestScore = score;
                    bestRow = row;
                }
            }
            
            if (bestRow) {
                // 2) Split valLine and counterLine to words
                const valWords = targetWords;
                const counterWords = normalizeStr(diffInfo.counterLine).split(/\s+/).filter(Boolean);
                
                // Which physical cells changed?
                for (const cell of bestRow.cells) {
                    const cellText = cell.cleanText;
                    if (!cellText) continue;

                    let foundInVal = valWords.some(vw => cellText.includes(vw) || vw.includes(cellText));
                    let foundInCounter = counterWords.some(cw => cellText.includes(cw) || cw.includes(cellText));
                    
                    if (foundInVal && !foundInCounter) {
                        // This specific physical cell has changed! Highlight tokens inside it!
                        for (let t of cell.tokens) {
                            const orig = tokens.find(ot => ot === t || ot.text === t.text);
                            if (orig && !matchInfo.includes(orig)) matchInfo.push(orig);
                        }
                    }
                }
            }
        }
        return matchInfo;
    }

    // For regular fields
    let targetWords = normalizeStr(value).split(/\s+/).filter(Boolean);
    if (targetWords.length === 0) return [];

    let matchInfo: OCRToken[] = [];

    // Simple exact contiguous sequence match for non-table fields
    for (let i = 0; i <= normalizedTokens.length - targetWords.length; i++) {
        matchInfo = [];
        let wordIndex = 0;
        let tokenIndex = i;

        while (wordIndex < targetWords.length && tokenIndex < normalizedTokens.length) {
            const tokenText = normalizedTokens[tokenIndex].cleanText;
            if (!tokenText) {
                tokenIndex++;
                continue;
            }
            if (tokenText === targetWords[wordIndex]) {
                matchInfo.push(tokens[tokenIndex]);
                wordIndex++;
            } else if (targetWords[wordIndex].startsWith(tokenText) || tokenText.startsWith(targetWords[wordIndex])) {
                matchInfo.push(tokens[tokenIndex]);
                wordIndex++; // loose fallback
            } else {
                break;
            }
            tokenIndex++;
        }

        if (wordIndex === targetWords.length) {
            return matchInfo;
        }
    }
    
    // Fuzzy match fallback: check if any token matches the full value string (if it's a single token that merged words)
    const exactSingleMatch = normalizedTokens.find(t => t.cleanText.includes(targetWords.join("")));
    if (exactSingleMatch) {
        const orig = tokens.find(t => t === exactSingleMatch || t.text === exactSingleMatch.text);
        if (orig) return [orig];
    }

    return [];
}

export function mergeTokenBoxes(tokens: OCRToken[]): { page: number; x: number; y: number; width: number; height: number; text: string }[] {
    if (tokens.length === 0) return [];
    
    // Group by page
    const byPage = tokens.reduce((acc, t) => {
        if (!acc[t.page]) acc[t.page] = [];
        acc[t.page].push(t);
        return acc;
    }, {} as Record<number, OCRToken[]>);

    const result: OCRToken[] = [];
    for (const [pageStr, pageTokens] of Object.entries(byPage)) {
        // Line-aware sorting
        const sorted = [...pageTokens].sort((a, b) => {
            if (Math.abs(a.y - b.y) > Math.max(a.height, b.height) * 0.5) return a.y - b.y;
            return a.x - b.x;
        });

        let current = { ...sorted[0] };
        for (let i = 1; i < sorted.length; i++) {
            const next = sorted[i];
            
            const isSameLine = Math.abs(current.y - next.y) < Math.max(current.height, next.height) * 0.5;
            const horizontalGap = next.x - (current.x + current.width);
            const isCloseHorizontally = isSameLine && (horizontalGap > -0.05 && horizontalGap < 0.05);

            if (isSameLine && isCloseHorizontally) {
                const minX = Math.min(current.x, next.x);
                const minY = Math.min(current.y, next.y);
                const maxX = Math.max(current.x + current.width, next.x + next.width);
                const maxY = Math.max(current.y + current.height, next.y + next.height);
                
                current.x = minX;
                current.y = minY;
                current.width = maxX - minX;
                current.height = maxY - minY;
                current.text += " " + next.text;
            } else {
                result.push(current);
                current = { ...next };
            }
        }
        result.push(current);
    }
    
    return result;
}
