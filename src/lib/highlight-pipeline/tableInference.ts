// Table inference — Step 3 of the cascade.
//
// Why this exists:
//   AI compare often returns docN_diff for tables as raw cell values
//   ("10" vs "12") without bbox. Without context those are too short to find
//   reliably with the generic Step 2 search — "10" likely appears multiple
//   times across a page. This module derives the actual diff cells from
//   field.rows + locates them inside a detected table region so we narrow
//   the search and avoid Step 2's "first hit" disambiguation pitfall.
//
// Heuristic-only — no AI calls, no extra cost. If detection or lookup fails,
// the orchestrator simply falls through to the existing fallbacks.

import type { PageTextLayer, TextItem } from "./types";
import { findInTextLayer, type SearchHit } from "./search";
import { normalize } from "./strings";

/** A field row dictionary as the AI returns it — keys are column labels,
 *  values are cell contents (string / number / null). */
type Row = Record<string, unknown>;

export interface DiffCell {
    rowIdx: number;
    colKey: string;
    value: string;
}

/** Compare the rows of this pane against the other panes' matching rows.
 *  Returns every cell where THIS pane's value differs from at least one
 *  other pane. Matches the verdict the user sees in the result panel for
 *  diff fields, which is what we want to highlight on the page. */
export function deriveTableDiffCells(
    rowsByDoc: { doc1?: Row[]; doc2?: Row[]; doc3?: Row[] },
    paneIdx: number,
): DiffCell[] {
    const myKey = (`doc${paneIdx + 1}` as keyof typeof rowsByDoc);
    const myRows = (rowsByDoc[myKey] ?? []) as Row[];
    const otherKeys = (["doc1", "doc2", "doc3"] as const).filter(k => k !== myKey);
    const others = otherKeys.map(k => (rowsByDoc[k] ?? []) as Row[]);
    const out: DiffCell[] = [];
    for (let i = 0; i < myRows.length; i++) {
        const mine = myRows[i];
        if (!mine || typeof mine !== "object") continue;
        for (const colKey of Object.keys(mine)) {
            const myVal = String(mine[colKey] ?? "").trim();
            if (!myVal) continue;
            const diff = others.some(o => {
                const other = o[i];
                if (!other || typeof other !== "object") return false;
                const oVal = String((other as Row)[colKey] ?? "").trim();
                return normalize(myVal) !== normalize(oVal);
            });
            if (diff) out.push({ rowIdx: i, colKey, value: myVal });
        }
    }
    return out;
}

/** Detect a vertical strip on the page that looks like a table — used to
 *  scope the search for short cell values so we don't match the same digit
 *  outside the table. Heuristic: find runs of >= 3 items that share a y-band
 *  with at least 2 other y-bands also having items aligned in similar x
 *  columns. */
export function detectTableRegion(layer: PageTextLayer): { yMin: number; yMax: number } | null {
    if (layer.items.length < 9) return null;
    // 1. Bucket items into y-bands (band width ≈ median item height).
    const heights = layer.items.map(i => i.height).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 0.015;
    const band = medianH * 0.7;
    const bands = new Map<number, TextItem[]>();
    for (const it of layer.items) {
        const k = Math.round(it.y / band);
        if (!bands.has(k)) bands.set(k, []);
        bands.get(k)!.push(it);
    }
    // 2. Bands with >=3 items are candidate table rows.
    const tableRowBands = Array.from(bands.entries())
        .filter(([, items]) => items.length >= 3)
        .sort((a, b) => a[0] - b[0]);
    if (tableRowBands.length < 3) return null;
    // 3. Find the longest run of consecutive bands (or near-consecutive) —
    //    that strip is most likely the table body.
    let bestStart = 0, bestLen = 0, curStart = 0, curLen = 1;
    for (let i = 1; i < tableRowBands.length; i++) {
        const gap = tableRowBands[i][0] - tableRowBands[i - 1][0];
        if (gap <= 2) {
            curLen += 1;
        } else {
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
            curStart = i; curLen = 1;
        }
    }
    if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    if (bestLen < 3) return null;
    const run = tableRowBands.slice(bestStart, bestStart + bestLen);
    const allItems = run.flatMap(([, items]) => items);
    const yMin = Math.min(...allItems.map(it => it.y));
    const yMax = Math.max(...allItems.map(it => it.y + it.height));
    return { yMin: Math.max(0, yMin - band), yMax: Math.min(1, yMax + band) };
}

/** Run search.findInTextLayer but restricted to the table region. We do
 *  this by building a transient PageTextLayer containing only items inside
 *  the region, then searching that subset. */
export function findCellInTable(
    layer: PageTextLayer,
    region: { yMin: number; yMax: number },
    value: string,
    hint?: { x: number; y: number; width: number; height: number },
): SearchHit | null {
    const subset: PageTextLayer = {
        page: layer.page,
        width: layer.width,
        height: layer.height,
        items: layer.items.filter(it => it.y >= region.yMin && it.y + it.height <= region.yMax),
    };
    if (subset.items.length === 0) return null;
    return findInTextLayer(subset, value, hint);
}
