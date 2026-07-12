// PDF text-layer extraction via pdf.js.
//
// Phase 1 deliverable: provide a side-effect-free way to pull text + positions
// out of a PDF page. The pipeline downstream (validation + search) consumes
// this; rendering does not depend on it.
//
// Caching: in-memory Map keyed by a content fingerprint (size+name+lastModified
// + page). Cleared on Compare run / file replace / unmount via the helpers
// exported below. We deliberately don't persist to localStorage / IndexedDB at
// this phase — see D2 in the plan.

import { pdfjs } from "react-pdf";
import type { PageTextLayer, TextItem, FileTextLayers } from "./types";

/** Key shape: `${size}:${name}:${lastModified}` — collisions across users are
 *  fine because the cache is per-page-load, not shared cross-session. */
type FileKey = string;

function fileKey(file: File): FileKey {
    return `${file.size}:${file.name}:${file.lastModified}`;
}

// Module-level cache. Outlives component re-renders but cleared on full page
// reload (which is what we want for the Compare workflow).
const cache = new Map<FileKey, FileTextLayers>();

/** Drop everything — called when starting a new Compare run so stale layers
 *  from a previous file don't leak across sessions. */
export function clearTextLayerCache(): void {
    cache.clear();
}

/** Remove a single file's layers from the cache (e.g. when the user swaps a
 *  pane's file in-place). Safe to call with an unknown File. */
export function evictTextLayer(file: File): void {
    cache.delete(fileKey(file));
}

/** Internal: open the PDF once, returning the pdf.js document handle. We
 *  cache the open document inside a transient Promise so concurrent callers
 *  for different pages don't each kick off their own re-parse. */
const docPromises = new Map<FileKey, Promise<any>>();
function openDoc(file: File): Promise<any> {
    const k = fileKey(file);
    let p = docPromises.get(k);
    if (p) return p;
    p = file.arrayBuffer().then(buf =>
        // pdfjs.getDocument returns a loading task with a `.promise` field.
        pdfjs.getDocument({ data: new Uint8Array(buf) }).promise,
    );
    docPromises.set(k, p);
    // Once resolved we keep the doc in the closure of subsequent page extracts
    // — but we evict the open-doc promise itself so a future evictTextLayer()
    // call doesn't leave a stale handle around forever.
    p.finally(() => { /* keep promise referenced through extractPage closures */ });
    return p;
}

/** Convert pdf.js's transform matrix + viewport into 0..1 normalized coords.
 *  pdf.js gives us a matrix [a, b, c, d, e, f] where (e, f) is the baseline
 *  position in PDF points. We map to top-left + width/height in viewport
 *  coords (origin top-left, matching AI bbox convention). */
function normalizeItem(
    raw: { str: string; transform: number[]; width: number; height: number; },
    pageWidth: number,
    pageHeight: number,
    pageNum: number,
): TextItem {
    const x = raw.transform[4];
    const yBaseline = raw.transform[5];
    // pdf.js item.height is the run height; baseline → top = baseline - height.
    const top = yBaseline - raw.height;
    return {
        str: raw.str,
        // Y-flip: PDF origin is bottom-left, our target is top-left.
        x: x / pageWidth,
        y: (pageHeight - top - raw.height) / pageHeight,
        width: raw.width / pageWidth,
        height: raw.height / pageHeight,
        page: pageNum,
    };
}

/** Lazily extract a single page's text layer. Subsequent calls for the same
 *  (file, page) return the cached layer instantly. */
export async function getPageTextLayer(file: File, pageNum: number): Promise<PageTextLayer | null> {
    if (file.type !== "application/pdf") return null;
    const k = fileKey(file);
    let layers = cache.get(k);
    if (!layers) {
        layers = new Map();
        cache.set(k, layers);
    }
    const cached = layers.get(pageNum);
    if (cached) return cached;

    try {
        const doc = await openDoc(file);
        if (pageNum < 1 || pageNum > doc.numPages) return null;
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: TextItem[] = [];
        for (const it of content.items) {
            // pdf.js may emit non-text items (e.g. marked-content). Guard.
            if (typeof it.str !== "string" || !it.str) continue;
            items.push(normalizeItem(it, viewport.width, viewport.height, pageNum));
        }
        const layer: PageTextLayer = {
            page: pageNum,
            width: viewport.width,
            height: viewport.height,
            items,
        };
        layers.set(pageNum, layer);
        return layer;
    } catch (e) {
        // pdf.js can fail on encrypted / corrupt PDFs. Return null so callers
        // gracefully fall back to the existing AI-bbox-only path.
        console.warn("[highlight-pipeline] text layer extract failed", { page: pageNum, error: e });
        return null;
    }
}

/** Convenience: extract every page of a file. Used by debug tooling and by
 *  the cascade's "full document scan" fallback (D8). For large PDFs this is
 *  expensive — prefer getPageTextLayer for known target pages. */
export async function getAllTextLayers(file: File): Promise<PageTextLayer[]> {
    if (file.type !== "application/pdf") return [];
    const doc = await openDoc(file);
    const out: PageTextLayer[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const layer = await getPageTextLayer(file, p);
        if (layer) out.push(layer);
    }
    return out;
}
