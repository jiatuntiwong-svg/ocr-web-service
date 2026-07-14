// Client-side crop generation for OCR-6 (crop-based extraction).
//
// Background (see docs/OCR_TESTING_LOG.md §OCR-6, pm/reports/OCR-2.md Case 6):
// Dense pages caused Gemini to drop line 2 of multi-line values *deterministically*
// even with a wide bbox_hint drawn around the whole field region. Manually cropping
// the field area to a small standalone image (same pixels) → the model reads
// every line correctly. So instead of sending only the whole 3600px stacked PNG
// with a soft `[hint: ...]` in the prompt, we ALSO crop each hinted field from
// that exact same PNG and send those crops as focused sub-images in a second
// AI call. Whole-image result stays canonical for non-hinted fields; crop
// result wins for hinted fields (see merge policy in upload/route.ts).
//
// Coordinate model — the important part:
//   * `bbox_hint` is drawn in the UI on a single-page preview. Its `x/y/width/
//     height` are normalized 0..1 RELATIVE TO ONE PAGE (not the stacked image).
//   * `bbox_hint.page` is 1-based.
//   * The uploaded PNG is the vertical stack of all pages (see pdf-to-image.ts).
//   * `StackedPageRect[]` (from pdfFileToImageDetailed) tells us where each page
//     lives inside the stacked image. We translate here.
//   * When the source is not a PDF (docx-to-image, plain image upload) there is
//     only one "page" — pass `pageRects = null` and we treat the whole image as
//     page 1.

import type { StackedPageRect } from "./pdf-to-image";
import { remapBboxHintPage } from "./pageSelection";

/** Normalize a fieldName for tolerant equality: collapse any run of whitespace
 *  (incl. NBSP, tab, newline) to a single space, trim, then lowercase. Thai
 *  fieldNames carry no case so lowercasing is a no-op for them, but Latin-alphabet
 *  templates benefit. Rationale (OCR-6b): the crop AI occasionally returns keys
 *  with a stray leading/trailing space or an internal NBSP, which used to slip
 *  past the strict `cropExtracted[fieldName]` lookup and silently drop the crop
 *  merge with NO observability signal ("documented merge observability gap" in
 *  pm/reports/OCR-6.md). Both client (fieldName under `field_crops` manifest)
 *  and server (crop merge in upload/route.ts) share this exact function so
 *  they can never drift.
 */
export function normalizeFieldNameKey(name: string): string {
    return name.replace(/[\s ]+/g, " ").trim().toLowerCase();
}

/** Padding applied around each bbox_hint before cropping.
 *  Values are fractions of the hint's own width/height.
 *  Rationale (per OCR-6 spec):
 *  - ±15% X → keep field label + a bit of margin on both sides.
 *  - +40% down → capture below-line handwriting spill (issue 1.2).
 *  - +15% up → keep the printed label in frame so the model can confirm
 *    which field it is looking at (crucial for the multi-image call).
 */
export const CROP_LABEL_MARGIN = {
    x: 0.15,
    top: 0.15,
    bottom: 0.40,
} as const;

export interface BboxHint {
    x: number;
    y: number;
    width: number;
    height: number;
    /** 1-based; defaults to 1 when omitted. */
    page?: number;
}

export interface FieldWithHint {
    name: string;
    bbox_hint?: BboxHint;
}

export interface FieldCrop {
    fieldName: string;
    /** 1-based page the hint was drawn on. */
    page: number;
    blob: Blob;
    /** Pixel rect actually cropped from the stacked image (debug/telemetry). */
    rect: { x: number; y: number; width: number; height: number };
    /** OCR-8 telemetry: emitted crop PNG size in bytes. Bubbled up in the
     *  `field_crops` manifest so the server can log per-run `_crop_bytes` /
     *  `_crop_dpi` metadata to raw_json for cost-observability. */
    bytes: number;
    /** OCR-8b Rung 3: scale tag when the caller emits the SAME field at
     *  multiple resolutions in one crop pass. Undefined = single-scale (the
     *  OCR-6..OCR-8 Rung-1 behaviour). "hi" = highest-DPI render; "lo" =
     *  standard-DPI render. Server groups by fieldName preserving array
     *  order, so [hi, lo] pairs must stay contiguous per field. */
    scale?: "hi" | "lo";
}

/** OCR-8 Rung 1: scale multiplier applied to the crop-pass render vs the
 *  whole-image render. `2` means the pages that carry hints are re-rasterized
 *  at 2× the whole-image DPI purely for the crop tiles the model sees. Token
 *  cost of the crop pass rises ~4× (roughly bytes^2 for image tokens on
 *  Gemini) but only affects hinted fields — whole-image pass remains cheap.
 *  Bumped from implicit 1 after `landscape-a4-widefield` demonstrated the
 *  model cannot resolve the "รับบริจาค" glyph cluster at 300 DPI (S2-2). */
export const CROP_DPI_SCALE = 2;

/** Load a File/Blob into an HTMLImageElement once and return its natural
 *  pixel dimensions along with the element (ready to `drawImage` from). */
async function loadImage(source: Blob): Promise<{ img: HTMLImageElement; width: number; height: number }> {
    const url = URL.createObjectURL(source);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error("crop: image decode failed"));
            el.src = url;
        });
        return { img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
        // Revoking here is safe because the browser has already decoded the
        // pixels — subsequent drawImage calls no longer need the URL.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

/**
 * For every field with a `bbox_hint`, crop the corresponding region from
 * the already-rendered upload image. All returned Blobs are PNGs.
 *
 * @param imageFile   The exact File that will be sent to /api/upload
 *                    (post pdf-to-image / docx-to-image conversion).
 * @param fields      The template's fields. Only entries with `bbox_hint`
 *                    produce a crop; non-hinted fields are skipped.
 * @param pageRects   Per-page pixel rects in `imageFile` when it is a
 *                    stacked multi-page PNG (from pdfFileToImageDetailed).
 *                    Pass `null` for single-page images.
 */
export async function buildFieldCrops(
    imageFile: File,
    fields: FieldWithHint[],
    pageRects: StackedPageRect[] | null,
    /** Page selection (API-1 Path A): 1-based ORIGINAL PDF page numbers, in
     *  stacked-image order. `hint.page` refers to an ORIGINAL page number —
     *  when a subset was rendered we must translate it into the rendered
     *  index. Empty / omitted = "all pages rendered, no remap".
     *
     *  Dropped hints (their page didn't make the selection) are silently
     *  skipped so the crop pass reflects what's actually in the image. */
    selectedPages?: number[] | null,
): Promise<FieldCrop[]> {
    const hinted = fields.filter(f => !!f.bbox_hint);
    if (hinted.length === 0) return [];

    const { img, width: imgW, height: imgH } = await loadImage(imageFile);

    const effectiveRects: StackedPageRect[] = pageRects && pageRects.length > 0
        ? pageRects
        : [{ y: 0, width: imgW, height: imgH }];
    const selection = Array.isArray(selectedPages) ? selectedPages : [];

    const crops: FieldCrop[] = [];
    for (const f of hinted) {
        const hint = f.bbox_hint!;
        // API-1 follow-up: translate original page number → rendered index.
        // When no selection was applied, remapBboxHintPage returns the input
        // unchanged, so this is a no-op for the OCR-6-verified path (full-doc
        // uploads without a page picker).
        const originalPage = hint.page ?? 1;
        const renderedPage = remapBboxHintPage(originalPage, selection);
        if (renderedPage === null) continue; // hint's page not in selection → skip
        const pageIdx = Math.max(0, Math.min(effectiveRects.length - 1, renderedPage - 1));
        const pr = effectiveRects[pageIdx];

        // Expanded rect in normalized page-space.
        const x0 = Math.max(0, hint.x - hint.width * CROP_LABEL_MARGIN.x);
        const y0 = Math.max(0, hint.y - hint.height * CROP_LABEL_MARGIN.top);
        const x1 = Math.min(1, hint.x + hint.width * (1 + CROP_LABEL_MARGIN.x));
        const y1 = Math.min(1, hint.y + hint.height * (1 + CROP_LABEL_MARGIN.bottom));

        // Translate to stacked-image pixel-space:
        //   x is straightforward (each page starts at x=0 in the stack).
        //   y adds the page's y-offset — this is the fix the OCR-5/6 spec
        //   flagged as necessary. Without it, a hint drawn on page 3 with
        //   y=0.2 would crop 20% down the FIRST page in a stacked image.
        const px = Math.round(x0 * pr.width);
        const py = Math.round(pr.y + y0 * pr.height);
        const pw = Math.max(1, Math.round((x1 - x0) * pr.width));
        const ph = Math.max(1, Math.round((y1 - y0) * pr.height));

        // Clamp to image bounds — defense against float error / bad hints.
        const sx = Math.max(0, Math.min(imgW - 1, px));
        const sy = Math.max(0, Math.min(imgH - 1, py));
        const sw = Math.max(1, Math.min(imgW - sx, pw));
        const sh = Math.max(1, Math.min(imgH - sy, ph));

        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        // Same source pixel buffer — no re-render, no coordinate drift.
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

        const blob: Blob | null = await new Promise(res => {
            canvas.toBlob(b => res(b), "image/png");
        });
        if (!blob) continue;

        crops.push({
            fieldName: f.name,
            page: hint.page ?? 1,
            blob,
            rect: { x: sx, y: sy, width: sw, height: sh },
            bytes: blob.size,
        });
    }

    // Dev-only visibility: helps verify multi-page y translation on a real run.
    // Guarded so it never runs in prod.
    if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.debug("[OCR-6] field crops", crops.map(c => ({
            field: c.fieldName, page: c.page, rect: c.rect,
        })));
    }
    return crops;
}

/** OCR-8b Rung 3 — interleave two per-field crop arrays into a single
 *  dual-scale manifest. Preserves fieldName order (order of `hiCrops`),
 *  contiguously grouping each field's [hi, lo] pair. Fields present in one
 *  side but not the other (e.g. hint dropped by page-remap in one render)
 *  are emitted as a single-scale entry in whichever list they appeared so
 *  the crop pass still runs.
 *
 *  Both inputs MUST have been built with the SAME field list and page
 *  selection — the caller is expected to run buildFieldCrops twice with two
 *  raster sources (hi-DPI, standard-DPI) sharing pageRects semantics. */
export function interleaveDualScaleCrops(
    hiCrops: FieldCrop[],
    loCrops: FieldCrop[],
): FieldCrop[] {
    const loByField = new Map<string, FieldCrop[]>();
    for (const c of loCrops) {
        const k = normalizeFieldNameKey(c.fieldName);
        const arr = loByField.get(k) ?? [];
        arr.push(c);
        loByField.set(k, arr);
    }
    const consumedHiFields = new Set<string>();
    const out: FieldCrop[] = [];
    for (const hi of hiCrops) {
        const k = normalizeFieldNameKey(hi.fieldName);
        consumedHiFields.add(k);
        out.push({ ...hi, scale: "hi" });
        const loList = loByField.get(k);
        const lo = loList && loList.shift();
        if (lo) out.push({ ...lo, scale: "lo" });
    }
    // Fields with only a lo crop (rare — hi render failed for that field
    // but lo succeeded): still send them so the field isn't silently dropped.
    for (const c of loCrops) {
        const k = normalizeFieldNameKey(c.fieldName);
        if (consumedHiFields.has(k)) continue;
        out.push({ ...c, scale: "lo" });
    }
    return out;
}
