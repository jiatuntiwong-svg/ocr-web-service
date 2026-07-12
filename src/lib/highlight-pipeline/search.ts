// Text-layer search — Step 2 of the cascade.
//
// Strategy:
//   1. Normalized exact substring scan over the full page text
//   2. When multiple hits, use AI's bbox as a "hint" — pick the hit nearest
//      to the AI's claimed position. This is what removes the "common word
//      appears 5 times, AI was actually pointing at hit #3" failure mode.
//   3. If exact finds nothing, fall through to a fuzzy word-window scan.
//
// All matches return a *synthesized* bbox that wraps the matched run of
// text items, in 0..1 page-normalized coords, matching the existing
// highlight render path's expectations.

import type { PageTextLayer, TextItem } from "./types";
import { fuzzyEqual, levenshtein, normalize } from "./strings";

export type SearchMatchKind = "exact" | "fuzzy";

export interface SearchHit {
    bbox: { x: number; y: number; width: number; height: number };
    kind: SearchMatchKind;
    matchedText: string;
    /** Number of items merged into the bbox — useful for telemetry. */
    itemCount: number;
}

/** Bounding box of a contiguous run of TextItems. */
function unionBbox(items: readonly TextItem[]): SearchHit["bbox"] {
    const minX = Math.min(...items.map(i => i.x));
    const minY = Math.min(...items.map(i => i.y));
    const maxX = Math.max(...items.map(i => i.x + i.width));
    const maxY = Math.max(...items.map(i => i.y + i.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Center distance, used for AI-bbox-hint disambiguation. */
function centerDistance(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
): number {
    const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2, by = b.y + b.height / 2;
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Walk the text layer accumulating items into a sliding window until the
 *  joined window contains the needle (exact mode) or fuzzy-matches it.
 *  Returns ALL hit positions so the caller can disambiguate. */
function scanWindows(
    layer: PageTextLayer,
    needle: string,
    kind: "exact" | "fuzzy",
): SearchHit[] {
    const n = normalize(needle);
    if (!n) return [];
    const hits: SearchHit[] = [];
    const items = layer.items;
    // For very short needles (1-2 chars) a window walk is overkill — match
    // any item whose normalized str contains the needle.
    if (n.length <= 2) {
        for (const it of items) {
            if (kind === "exact" && normalize(it.str).includes(n)) {
                hits.push({ bbox: unionBbox([it]), kind, matchedText: it.str, itemCount: 1 });
            }
        }
        return hits;
    }
    // Otherwise: try windows of up to 12 items (covers a long address field
    // split across many runs by pdf.js). 12 is empirical — most field values
    // fit in 1-4 items, and bigger windows produce more false positives.
    const MAX_WINDOW = 12;
    for (let i = 0; i < items.length; i++) {
        let acc = "";
        for (let j = i; j < items.length && j < i + MAX_WINDOW; j++) {
            acc = acc ? `${acc} ${items[j].str}` : items[j].str;
            const normAcc = normalize(acc);
            if (kind === "exact") {
                if (normAcc.includes(n)) {
                    hits.push({
                        bbox: unionBbox(items.slice(i, j + 1)),
                        kind: "exact",
                        matchedText: acc,
                        itemCount: j - i + 1,
                    });
                    break; // don't accumulate further past first hit in this window
                }
            } else {
                // Fuzzy mode: accept once the levenshtein-vs-needle drops to
                // the same threshold as fuzzyEqual().
                const ref = Math.min(normAcc.length, n.length);
                if (ref >= 3) {
                    const threshold = Math.min(3, Math.ceil(ref * 0.15));
                    if (levenshtein(normAcc.slice(0, n.length + threshold), n) <= threshold) {
                        hits.push({
                            bbox: unionBbox(items.slice(i, j + 1)),
                            kind: "fuzzy",
                            matchedText: acc,
                            itemCount: j - i + 1,
                        });
                        break;
                    }
                }
            }
            // Optimization: stop growing the window once it's clearly past
            // the needle length (no longer plausible).
            if (normAcc.length > n.length * 2 + 8) break;
        }
    }
    return hits;
}

/** Find the best position for `needle` inside the page text layer.
 *  `hint` (optional) is the AI's original bbox — when multiple matches exist,
 *  we pick the one closest to the hint. Without a hint we pick the first. */
export function findInTextLayer(
    layer: PageTextLayer,
    needle: string,
    hint?: { x: number; y: number; width: number; height: number },
): SearchHit | null {
    // 1. exact
    const exact = scanWindows(layer, needle, "exact");
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
        if (!hint) return exact[0];
        return [...exact].sort((a, b) => centerDistance(a.bbox, hint) - centerDistance(b.bbox, hint))[0];
    }
    // 2. fuzzy — only for needles 3+ chars; shorter ones are too risky
    if (normalize(needle).length < 3) return null;
    if (!fuzzyEqual(needle, needle)) return null; // sanity, never false
    const fuzzy = scanWindows(layer, needle, "fuzzy");
    if (!fuzzy.length) return null;
    if (!hint) return fuzzy[0];
    return [...fuzzy].sort((a, b) => centerDistance(a.bbox, hint) - centerDistance(b.bbox, hint))[0];
}
