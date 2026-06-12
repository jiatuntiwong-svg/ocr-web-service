// Rasterize a PDF File into a single PNG image File by rendering every page
// to a canvas and stacking them vertically. This lets PDF uploads reuse the
// fully-verified IMAGE pipeline (preview <img>, Tesseract OCR, image-overlay
// highlight rendering) with zero PDF-specific worker/coordinate code — the
// react-pdf <Document> path was unreliable on the Cloudflare/OpenNext build.

let pdfjsPromise: Promise<any> | null = null;

async function loadPdfjs(): Promise<any> {
    if (!pdfjsPromise) {
        // @ts-expect-error - the .mjs build entry ships no type declarations
        pdfjsPromise = import("pdfjs-dist/build/pdf.mjs").then((lib: any) => {
            // Same worker the rest of the app serves from /public — version
            // locked to the installed pdfjs-dist, no CDN dependency.
            if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
                lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
            }
            return lib;
        });
    }
    return pdfjsPromise;
}

export interface PdfRasterOptions {
    /** Stop after this many pages (bounds memory on huge PDFs). */
    maxPages?: number;
    /** Target px on the long edge of each rendered page (OCR resolution). */
    targetLongEdge?: number;
}

/**
 * Convert a PDF File to a PNG File. All pages (up to maxPages) are rendered
 * and stacked into one tall image so a multi-page document stays a single
 * document in the compare workspace.
 */
export async function pdfFileToImage(
    file: File,
    opts: PdfRasterOptions = {},
): Promise<File> {
    const maxPages = opts.maxPages ?? 10;
    const targetLongEdge = opts.targetLongEdge ?? 2400;

    const pdfjs = await loadPdfjs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const pageCount = Math.min(pdf.numPages, maxPages);

    const canvases: HTMLCanvasElement[] = [];
    for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const longEdge = Math.max(base.width, base.height) || 1;
        // Scale up small PDF pages so OCR has enough resolution; cap at 4x.
        const scale = Math.min(4, Math.max(1, targetLongEdge / longEdge));
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        canvases.push(canvas);
    }

    if (canvases.length === 0) {
        throw new Error("PDF has no renderable pages");
    }

    // Stack pages vertically into one image.
    const width = Math.max(...canvases.map(c => c.width));
    const height = canvases.reduce((sum, c) => sum + c.height, 0);
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const octx = out.getContext("2d");
    if (!octx) throw new Error("Canvas 2D context unavailable");
    octx.fillStyle = "#ffffff";
    octx.fillRect(0, 0, width, height);
    let y = 0;
    for (const c of canvases) {
        octx.drawImage(c, 0, y);
        y += c.height;
    }

    const blob: Blob = await new Promise((resolve, reject) => {
        out.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
    const name = file.name.replace(/\.pdf$/i, "") + ".png";
    return new File([blob], name, { type: "image/png" });
}
