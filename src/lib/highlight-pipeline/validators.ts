// Bbox validation — Step 1 of the cascade.
//
// Given an AI-supplied bbox + the AI's claimed text, look up the text the PDF
// actually has inside that region and decide whether the bbox is trustworthy.
//
//   high   — text in bbox matches claim after normalization (exact)
//   medium — text in bbox is fuzzy-equal to the claim, OR matches one of the
//            doc_diff fragments (the AI flagged it as "the changed part" but
//            its bbox may have drifted a bit)
//   reject — no match → caller should fall through to the search step
//
// The bbox uses normalized 0..1 coords on the page; we expand it by a small
// padding factor before extracting text since the AI sometimes returns a
// slightly tight bbox that excludes the last glyph.

import type { PageTextLayer, TextItem } from "./types";
import { fuzzyEqual, normalize, normalizedEqual, normalizedIncludes } from "./strings";

const BBOX_PADDING = 0.005; // 0.5% of page on each side

/** Concatenate all text items whose center falls inside the (padded) bbox.
 *  Items are joined with single spaces — good enough for short field values;
 *  multi-line fields end up with the line break collapsed to a space, which
 *  matches what `normalize` would do anyway. */
export function extractTextInBbox(
    layer: PageTextLayer,
    bbox: { x: number; y: number; width: number; height: number },
): string {
    const minX = bbox.x - BBOX_PADDING;
    const minY = bbox.y - BBOX_PADDING;
    const maxX = bbox.x + bbox.width + BBOX_PADDING;
    const maxY = bbox.y + bbox.height + BBOX_PADDING;
    const inside: TextItem[] = [];
    for (const item of layer.items) {
        const cx = item.x + item.width / 2;
        const cy = item.y + item.height / 2;
        if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) inside.push(item);
    }
    return inside.map(it => it.str).join(" ");
}

export type ValidationVerdict = "high" | "medium" | "reject";

/** Decide whether an AI bbox can be trusted for the given claim/fragments. */
export function validateBbox(
    layer: PageTextLayer | null,
    bbox: { x: number; y: number; width: number; height: number },
    claim: string | null | undefined,
    fragments: readonly string[] = [],
): { verdict: ValidationVerdict; matchedText: string } {
    // No text layer → can't validate; let caller decide whether to keep or
    // try the next step. We surface this as "medium" so callers default to
    // showing it (don't strip AI bbox just because we couldn't verify).
    if (!layer) return { verdict: "medium", matchedText: "" };
    const text = extractTextInBbox(layer, bbox);
    if (!text) return { verdict: "reject", matchedText: "" };

    const c = claim ? normalize(claim) : "";
    const t = normalize(text);

    // Exact / containment against the full claim
    if (c && (t === c || normalizedIncludes(t, c) || normalizedIncludes(c, t))) {
        return { verdict: "high", matchedText: text };
    }

    // Fuzzy against the full claim
    if (c && fuzzyEqual(t, c)) {
        return { verdict: "medium", matchedText: text };
    }

    // Fragment matching — the AI's docN_diff fragments are the exact substrings
    // it flagged as changed, so finding ANY of them inside the bbox text is
    // a strong-enough signal to keep the highlight.
    for (const f of fragments) {
        if (!f) continue;
        if (normalizedIncludes(t, f) || fuzzyEqual(t, f)) {
            return { verdict: "medium", matchedText: text };
        }
    }

    return { verdict: "reject", matchedText: text };
}
