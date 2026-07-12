// Shared types for the Compare highlight pipeline. Kept in a single file so
// every sub-module (textLayer, validators, search, tableInference, postprocess)
// imports from one place — easier to evolve as the pipeline matures.

/** A single text run extracted from a PDF page via pdf.js. Coordinates use the
 *  PDF coordinate system at the time of extraction: origin top-left, units
 *  normalized to page width/height (0..1) so they line up with AI bbox math
 *  without an extra conversion step. */
export interface TextItem {
    /** The text content of this run (single line, no decoration). */
    str: string;
    /** Normalized 0..1, left edge of the text run. */
    x: number;
    /** Normalized 0..1, top edge of the text run. */
    y: number;
    /** Normalized 0..1, width of the run. */
    width: number;
    /** Normalized 0..1, height of the run (≈ font height). */
    height: number;
    /** Page number (1-based) this item came from. */
    page: number;
}

/** All extracted text on a single PDF page. The `items` array preserves the
 *  reading order pdf.js returned — which is roughly left-to-right, top-to-bottom
 *  for text PDFs. Caller code should not depend on perfect logical order for
 *  multi-column layouts (a known limitation tracked in the plan doc). */
export interface PageTextLayer {
    page: number;
    width: number;   // PDF page width in points (for downstream conversions)
    height: number;  // PDF page height in points
    items: TextItem[];
}

/** All pages for a single file, indexed by 1-based page number. */
export type FileTextLayers = Map<number, PageTextLayer>;

/** Why this highlight survived (or was added by) the pipeline. Drives the
 *  visual confidence level in the render layer once Phase 4 lands. */
export type HighlightSource =
    | "ai-bbox-validated"   // AI bbox + text-layer cross-check passed
    | "text-search-exact"   // text layer found via normalized exact match
    | "text-search-fuzzy"   // text layer found via Levenshtein within threshold
    | "table-inferred"      // grid coords inferred from header alignment
    | "ai-bbox-raw"         // current path — AI bbox without validation
    | "fallback-row-diff"   // existing row-derived scan (unchanged)
    | "fallback-word-diff"; // existing per-cell word diff (unchanged)

export type ConfidenceLevel = "high" | "medium" | "low";

/** Output of the pipeline — a strict superset of the current highlight shape
 *  so render code can read the new fields while still rendering when the
 *  pipeline is off. */
export interface EnrichedHighlight {
    /** The bbox itself, identical shape to the current highlights[].boxes[]. */
    x: number;
    y: number;
    width: number;
    height: number;
    page?: number;
    confidence?: number;
    /** Cross-pane diff flag preserved from the original highlight group. */
    _isDiff?: boolean;
    /** NEW: pipeline metadata, optional so render falls back gracefully. */
    confidenceLevel?: ConfidenceLevel;
    source?: HighlightSource;
    /** Free-form debug context — printed in `?compareDebug=1` overlay only. */
    debug?: { matchedText?: string; aiClaim?: string; step?: string };
}
