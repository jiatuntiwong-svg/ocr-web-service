// Post-processing — Phase 4 of the cascade.
//
// Runs AFTER the cascade has produced candidate boxes. Two jobs:
//   1. De-duplicate overlapping bboxes within a group. The cascade can
//      legitimately add the same box twice (Step 1 kept it; Step 2 re-found
//      it via search) — without dedupe the user sees double-thickness
//      borders and inflated counts.
//   2. Merge adjacent boxes on the same horizontal line into a single
//      union rectangle. AI sometimes splits a single field value into
//      multiple word-level boxes ("ABC", "Trading", "Co.") which feel
//      noisy — one rectangle covering the whole phrase reads cleaner.
//
// Both are pure transforms over already-enriched data; flag-gated at the
// orchestrator level so any regression is rolled back by flipping the
// post-process flag without touching upstream steps.

import type { EnrichedHighlight, ConfidenceLevel } from "./types";

interface BoxLike {
    x: number; y: number; width: number; height: number; page?: number;
}

/** Intersection-over-union for two boxes on the same page. Pages differ → 0. */
export function iou(a: BoxLike, b: BoxLike): number {
    if ((a.page ?? 1) !== (b.page ?? 1)) return 0;
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1) return 0;
    const inter = (x2 - x1) * (y2 - y1);
    const union = a.width * a.height + b.width * b.height - inter;
    return union > 0 ? inter / union : 0;
}

/** Smallest rect that contains both boxes (page from `a`). */
function unionBox(a: BoxLike, b: BoxLike): BoxLike {
    const x1 = Math.min(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.width, b.x + b.width);
    const y2 = Math.max(a.y + a.height, b.y + b.height);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, page: a.page };
}

function confidenceRank(c?: ConfidenceLevel): number {
    if (c === "high") return 0;
    if (c === "medium") return 1;
    if (c === "low") return 2;
    return 3; // missing → treat as below low
}

/** Drop boxes whose IoU with a higher-ranked box exceeds threshold. */
export function dedupe(boxes: EnrichedHighlight[], threshold = 0.5): EnrichedHighlight[] {
    // Sort so higher-confidence boxes are checked first → they win duplicates.
    const sorted = [...boxes].sort((a, b) => confidenceRank(a.confidenceLevel) - confidenceRank(b.confidenceLevel));
    const kept: EnrichedHighlight[] = [];
    for (const box of sorted) {
        if (kept.some(k => iou(k, box) > threshold)) continue;
        kept.push(box);
    }
    return kept;
}

/** Merge boxes that sit on the same horizontal line and are close enough
 *  horizontally (gap below `gapThreshold`, default 1.2% of page width).
 *  Same-line is decided by y-center proximity ≤ half the average height —
 *  forgiving enough to catch slight baseline shifts pdf.js sometimes emits. */
export function groupAdjacent(
    boxes: EnrichedHighlight[],
    gapThreshold = 0.012,
): EnrichedHighlight[] {
    if (boxes.length < 2) return boxes;
    // Group by page.
    const byPage = new Map<number, EnrichedHighlight[]>();
    for (const b of boxes) {
        const p = b.page ?? 1;
        if (!byPage.has(p)) byPage.set(p, []);
        byPage.get(p)!.push(b);
    }
    const out: EnrichedHighlight[] = [];
    for (const pageBoxes of byPage.values()) {
        // Sort left → right, then top → bottom.
        const sorted = [...pageBoxes].sort((a, b) => a.y - b.y || a.x - b.x);
        const merged: EnrichedHighlight[] = [];
        for (const box of sorted) {
            const last = merged[merged.length - 1];
            if (!last) { merged.push(box); continue; }
            const sameLine = Math.abs((last.y + last.height / 2) - (box.y + box.height / 2))
                <= Math.max(last.height, box.height) * 0.5;
            const gap = box.x - (last.x + last.width);
            if (sameLine && gap >= 0 && gap <= gapThreshold) {
                // Merge: take union bbox + keep the higher-ranked source/level.
                const u = unionBox(last, box);
                const winner = confidenceRank(last.confidenceLevel) <= confidenceRank(box.confidenceLevel)
                    ? last : box;
                merged[merged.length - 1] = {
                    ...winner,
                    x: u.x, y: u.y, width: u.width, height: u.height,
                };
            } else {
                merged.push(box);
            }
        }
        out.push(...merged);
    }
    return out;
}

/** Run both passes in order: dedupe then group. The order matters — group
 *  works better once obvious duplicates are gone, otherwise two overlapping
 *  boxes would each try to merge with neighbors and produce inconsistent
 *  unions depending on iteration order. */
export function postprocessGroup(boxes: EnrichedHighlight[]): EnrichedHighlight[] {
    return groupAdjacent(dedupe(boxes));
}
