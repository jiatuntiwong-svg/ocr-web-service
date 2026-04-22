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
    if (!value || tokens.length === 0) return [];
    
    // Normalize string preserving Thai characters and digits
    const normalizeStr = (s: string) => s.trim().toLowerCase().replace(/[^\w\s\u0E00-\u0E7F0-9]/g, " ").replace(/\s+/g, " ").trim();
    
    const normalizedTokens = tokens.map(t => ({
        ...t,
        cleanText: normalizeStr(t.text)
    }));

    // For tables, use context-aware row and cell diffing
    if (isTableField) {
        const valLines = value.split('\n').map(l => l.trim()).filter(Boolean);
        const counterLines = (counterpartVal || '').split('\n').map(l => l.trim()).filter(Boolean);
        
        const rows = buildTableStructure(normalizedTokens);
        const matchInfo: OCRToken[] = [];

        for (let lineIdx = 0; lineIdx < valLines.length; lineIdx++) {
            const valLine = valLines[lineIdx];
            const counterLine = counterLines[lineIdx] || "";
            
            // Only highlight rows that differ (or all if no counterpart)
            const lineDiffers = !counterpartVal || valLine !== counterLine;
            if (!lineDiffers) continue;

            const targetWords = normalizeStr(valLine).split(/\s+/).filter(Boolean);
            if (targetWords.length === 0) continue;

            // Score each row for how well it matches the target value line
            let bestRow: TableRow | null = null;
            let bestScore = 0;
            for (const row of rows) {
                let matches = 0;
                for (const tw of targetWords) {
                    // Exact word match OR numeric substring match
                    if (row.cleanText.includes(tw)) matches++;
                    else if (/^\d/.test(tw) && row.cleanText.split(/\s+/).some(rt => rt === tw)) matches += 0.8;
                }
                const score = matches / Math.max(targetWords.length, 1);
                if (score > bestScore && score > 0.25) {
                    bestScore = score;
                    bestRow = row;
                }
            }
            
            if (bestRow) {
                if (counterpartVal) {
                    // Highlight only the cells that changed vs counterpart
                    const counterWords = normalizeStr(counterLine).split(/\s+/).filter(Boolean);
                    let foundDiffCell = false;
                    
                    for (const cell of bestRow.cells) {
                        const cellText = cell.cleanText;
                        if (!cellText || cellText.length < 1) continue;

                        const inVal = targetWords.some(vw => cellText.includes(vw) || vw.includes(cellText));
                        const inCounter = counterWords.some(cw => cellText.includes(cw) || cw.includes(cellText));
                        
                        if (inVal && !inCounter) {
                            // This cell changed — highlight its tokens
                            for (const t of cell.tokens) {
                                const orig = tokens.find(ot => ot === t || ot.text === t.text);
                                if (orig && !matchInfo.includes(orig)) matchInfo.push(orig);
                            }
                            foundDiffCell = true;
                        }
                    }
                    
                    // Fallback: if no specific cell found, highlight the whole row
                    if (!foundDiffCell) {
                        for (const t of bestRow.tokens) {
                            const orig = tokens.find(ot => ot === t || ot.text === t.text);
                            if (orig && !matchInfo.includes(orig)) matchInfo.push(orig);
                        }
                    }
                } else {
                    // No counterpart — highlight the best-matching row entirely
                    for (const t of bestRow.tokens) {
                        const orig = tokens.find(ot => ot === t || ot.text === t.text);
                        if (orig && !matchInfo.includes(orig)) matchInfo.push(orig);
                    }
                }
            }
        }
        
        // If we got table matches return them, otherwise fall through to text matching
        if (matchInfo.length > 0) return matchInfo;
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

    // Extended Multi-line Block Match Fallback
    // Create sliding windows that merge tokens within a small Y-range
    const sortedByY = [...normalizedTokens].sort((a, b) => Math.abs(a.y - b.y) > 0.02 ? a.y - b.y : a.x - b.x);
    for (let i = 0; i < sortedByY.length; i++) {
        const windowTokens: any[] = [];
        const baseY = sortedByY[i].y;
        for (let j = i; j < sortedByY.length; j++) {
            if (sortedByY[j].y - baseY > 0.05) break; // Allow up to roughly 3 lines
            windowTokens.push(sortedByY[j]);
        }
        
        const windowText = windowTokens.map(t => t.cleanText).join("");
        
        // Find how many targetWords are in this block
        let matches = 0;
        for (const w of targetWords) {
            if (windowText.includes(w)) matches++;
        }
        
        if (matches / targetWords.length >= 0.7) {
            // High confidence! Get original tokens
            const matchedOrigins = windowTokens
                .filter(wt => targetWords.some(tw => wt.cleanText.includes(tw) || tw.includes(wt.cleanText)))
                .map(wt => tokens.find(t => t === wt || t.text === wt.text))
                .filter(Boolean) as OCRToken[];
                
            if (matchedOrigins.length > 0) {
                return matchedOrigins;
            }
        }
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
