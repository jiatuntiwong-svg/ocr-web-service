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
    /** Stop after this many pages (bounds memory on huge PDFs). Ignored when
     *  `pages` is set — the caller's explicit list wins. */
    maxPages?: number;
    /** Target px on the long edge of each rendered page (OCR resolution). */
    targetLongEdge?: number;
    /** UI-1 / API-1 Path A: render ONLY these 1-based ORIGINAL PDF page
     *  numbers, in the given order (dedup'd, order preserved). Undefined /
     *  empty = today's behaviour (all pages up to `maxPages`). Callers that
     *  pass a subset get a stacked PNG containing exactly those tiles; the
     *  i-th `pageRects[i]` describes the i-th RENDERED tile (not the i-th
     *  original page), and `pageNumbers[i]` records the ORIGINAL page number
     *  it came from. */
    pages?: number[];
}

/** Per-page pixel rect inside the stacked output PNG. Origin is top-left of the
 *  stacked image; each page has `x = 0` and its own width/height. Used by the
 *  crop helper in `field-crops.ts` to translate a per-page bbox_hint (`y%`
 *  relative to a single page) into stacked-image pixel coordinates.
 */
export interface StackedPageRect {
    /** y-offset (px) of this page's top edge in the stacked image. */
    y: number;
    /** Rendered pixel width of this page (each page is left-aligned at x=0). */
    width: number;
    /** Rendered pixel height of this page. */
    height: number;
}

export interface PdfRasterResult {
    file: File;
    /** Stacked-image dimensions (total). */
    width: number;
    height: number;
    /** One entry per rendered page (in page order, 0-based). */
    pageRects: StackedPageRect[];
    /** OCR-6c: per-page PNG blobs, one entry per rendered page (in page order,
     *  0-based). Each blob is the SAME pixels as the corresponding region of
     *  the stacked upload file, sliced at rendering time — so the preview the
     *  user sees is byte-identical to what the model receives. Used by
     *  OCRWorkspace to render the hint-drawing surface in one coordinate
     *  space with the crop path (no iframe letterbox → no wrapper-vs-page
     *  rect mismatch on landscape pages). Callers that only need the stacked
     *  upload file can ignore this. */
    pagePngs: Blob[];
    /** UI-1: 1-based ORIGINAL PDF page number of each rendered tile.
     *  Length == pagePngs.length == pageRects.length. When the caller did NOT
     *  supply `opts.pages`, this is simply `[1, 2, …, N]` so existing callers
     *  behave the same. When they did, this is the (deduped, order-preserved)
     *  selection they passed. Bridges Path A hints (`bbox_hint.page` = original
     *  page) back to the rendered index in `pageRects`. */
    pageNumbers: number[];
}

/**
 * Convert a PDF File to a PNG File. All pages (up to maxPages) are rendered
 * and stacked into one tall image so a multi-page document stays a single
 * document in the compare workspace. Backward-compatible: returns only the
 * File; call `pdfFileToImageDetailed` if you also need page layout for crop
 * translation.
 */
export async function pdfFileToImage(
    file: File,
    opts: PdfRasterOptions = {},
): Promise<File> {
    const { file: out } = await pdfFileToImageDetailed(file, opts);
    return out;
}

/**
 * Same as `pdfFileToImage` but also returns per-page pixel rects in the
 * stacked output. Callers that need to translate a per-page `bbox_hint`
 * (whose y% is relative to one PDF page) into stacked-image pixel space
 * must use this — the flat File API loses the page boundaries.
 */
export async function pdfFileToImageDetailed(
    file: File,
    opts: PdfRasterOptions = {},
): Promise<PdfRasterResult> {
    const maxPages = opts.maxPages ?? 10;
    // 3600px ~= 300 DPI on A4 long-edge. Bumped from 2400 (200 DPI) after
    // users reported misreads on small Thai text (e.g. "ช็อคบอล" → "คอบอล").
    // Trade-off: image ~2.25× larger → more input tokens + 1-2s slower conversion.
    const targetLongEdge = opts.targetLongEdge ?? 3600;

    const pdfjs = await loadPdfjs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;

    // UI-1: resolve which ORIGINAL page numbers to render. Explicit
    // `opts.pages` (deduped, order preserved) wins; otherwise fall back to
    // the historical 1..maxPages behaviour so existing callers don't change.
    let pageNumbers: number[];
    if (Array.isArray(opts.pages) && opts.pages.length > 0) {
        const seen = new Set<number>();
        pageNumbers = [];
        for (const raw of opts.pages) {
            if (!Number.isInteger(raw) || raw < 1 || raw > pdf.numPages) continue;
            if (seen.has(raw)) continue;
            seen.add(raw);
            pageNumbers.push(raw);
        }
        if (pageNumbers.length === 0) {
            throw new Error("PDF has no renderable pages (empty selection)");
        }
    } else {
        const pageCount = Math.min(pdf.numPages, maxPages);
        pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);
    }

    const canvases: HTMLCanvasElement[] = [];
    for (const pageNum of pageNumbers) {
        const page = await pdf.getPage(pageNum);
        // Rotation semantics (OCR-6b): pdfjs `getViewport({ scale })` HONORS
        // the page's `/Rotate` metadata by default — a landscape page with
        // /Rotate 90 renders in its intended orientation and its viewport's
        // width/height are already the display-space dimensions. The client
        // preview uses `<iframe src="…pdf">` which invokes the browser's
        // built-in PDF viewer; that viewer likewise honors /Rotate. Both
        // sides therefore see the SAME orientation, which is what the
        // bbox_hint (drawn on the preview) must match at crop time. We
        // deliberately do NOT force `rotation: 0` here — that would produce
        // the raw un-rotated bitmap and desync from the preview the user
        // drew against.
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
    const pageRects: StackedPageRect[] = [];
    for (const c of canvases) {
        octx.drawImage(c, 0, y);
        pageRects.push({ y, width: c.width, height: c.height });
        y += c.height;
    }

    // OCR-6c: emit per-page PNG blobs from the SAME canvases used for the
    // stacked upload image. Preview and upload share pixels — a hint drawn
    // on the preview is drawn on the exact bitmap the crop step will read.
    const pagePngs: Blob[] = [];
    for (const c of canvases) {
        const b: Blob | null = await new Promise(resolve => {
            c.toBlob(x => resolve(x), "image/png");
        });
        if (b) pagePngs.push(b);
    }

    const blob: Blob = await new Promise((resolve, reject) => {
        out.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
    const name = file.name.replace(/\.pdf$/i, "") + ".png";
    const outFile = new File([blob], name, { type: "image/png" });
    // UI-1: `pageNumbers` may have been trimmed by canvas-context failures
    // above (rare). Slice to match what actually rendered so callers can
    // rely on `pageNumbers[i]` describing `pagePngs[i]`.
    const renderedPageNumbers = pageNumbers.slice(0, canvases.length);
    return { file: outFile, width, height, pageRects, pagePngs, pageNumbers: renderedPageNumbers };
}
