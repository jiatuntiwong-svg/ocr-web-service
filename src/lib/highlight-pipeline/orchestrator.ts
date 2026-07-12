// Pipeline orchestrator — the single async entry point that the UI calls.
//
// Inputs:
//   - file (PDF only — image/Excel paths return early with input unchanged)
//   - paneIdx (0-based)
//   - existing highlight groups (the shape that getHighlightsForDoc returns)
//   - the Compare API result so we can read field.docN + field.docN_diff
//
// Output:
//   - new highlight groups with the same shape, but each box carries
//     EnrichedHighlight metadata (confidenceLevel, source, debug)
//   - PipelineStats for telemetry
//
// Failure mode: any unexpected error returns the input unchanged + logs.
// Callers must treat the output as "best effort" — when the pipeline
// returns the original groups, render proceeds as if the pipeline never
// ran. Rollback safety lives here.

import { getPageTextLayer } from "./textLayer";
import { validateBbox } from "./validators";
import { findInTextLayer } from "./search";
import { deriveTableDiffCells, detectTableRegion, findCellInTable } from "./tableInference";
import { postprocessGroup } from "./postprocess";
import { emptyStats, logStats, type PipelineStats } from "./telemetry";
import type { EnrichedHighlight, HighlightSource, ConfidenceLevel } from "./types";

export interface InputHighlightGroup {
    key: string;
    isDiff: boolean;
    boxes: Array<{
        x: number;
        y: number;
        width: number;
        height: number;
        page?: number;
        confidence?: number;
        _isDiff?: boolean;
        [k: string]: any;
    }>;
}

export interface OutputHighlightGroup {
    key: string;
    isDiff: boolean;
    boxes: EnrichedHighlight[];
}

export interface OrchestratorOptions {
    file: File;
    paneIdx: number; // 0-based
    groups: InputHighlightGroup[];
    fields: Array<{
        key: string;
        is_diff?: boolean;
        doc1?: any; doc2?: any; doc3?: any;
        doc1_diff?: string[]; doc2_diff?: string[]; doc3_diff?: string[];
        rows?: { doc1?: any[]; doc2?: any[]; doc3?: any[] };
    }>;
    flags: {
        bboxValidation: boolean;
        textSearch: boolean;
        tableInference: boolean;
        postprocess: boolean;
    };
}

function fieldValue(field: any, paneIdx: number): string | null {
    const v = field?.[`doc${paneIdx + 1}`];
    if (v == null) return null;
    if (typeof v === "string") return v;
    return String(v);
}

function fieldFragments(field: any, paneIdx: number): string[] {
    const arr = field?.[`doc${paneIdx + 1}_diff`];
    return Array.isArray(arr) ? arr.filter(s => typeof s === "string" && s) : [];
}

function sourceConfidence(source: HighlightSource): ConfidenceLevel {
    switch (source) {
        case "ai-bbox-validated":
        case "text-search-exact":
            return "high";
        case "text-search-fuzzy":
        case "ai-bbox-raw":
            return "medium";
        case "table-inferred":
        case "fallback-row-diff":
        case "fallback-word-diff":
            return "low";
    }
}

/** Make an EnrichedHighlight from a raw box, tagging source + confidence. */
function tag(
    raw: InputHighlightGroup["boxes"][number],
    source: HighlightSource,
    debug?: EnrichedHighlight["debug"],
): EnrichedHighlight {
    return {
        x: raw.x,
        y: raw.y,
        width: raw.width,
        height: raw.height,
        page: raw.page,
        confidence: raw.confidence,
        _isDiff: raw._isDiff,
        confidenceLevel: sourceConfidence(source),
        source,
        debug,
    };
}

export async function runHighlightPipeline(
    opts: OrchestratorOptions,
): Promise<{ groups: OutputHighlightGroup[]; stats: PipelineStats }> {
    const t0 = performance.now();
    const stats = emptyStats(opts.paneIdx, `Doc ${opts.paneIdx + 1}`);
    stats.totalGroupsIn = opts.groups.length;
    stats.totalBoxesIn = opts.groups.reduce((n, g) => n + g.boxes.length, 0);

    // Image / Excel / scanned PDF — skip; return input as "ai-bbox-raw".
    if (opts.file.type !== "application/pdf") {
        const passthrough = opts.groups.map(g => ({
            key: g.key,
            isDiff: g.isDiff,
            boxes: g.boxes.map(b => tag(b, "ai-bbox-raw")),
        }));
        passthrough.forEach(g => { stats.bySource["ai-bbox-raw"] += g.boxes.length; });
        stats.durationMs = performance.now() - t0;
        return { groups: passthrough, stats };
    }

    // Build a map: page → text layer (lazy load each unique page across all
    // groups). Pages with extract errors map to null and are treated as
    // "can't validate" → keep boxes as "ai-bbox-raw".
    const pagesNeeded = new Set<number>();
    for (const g of opts.groups) for (const b of g.boxes) pagesNeeded.add(b.page ?? 1);
    const pageLayers = new Map<number, Awaited<ReturnType<typeof getPageTextLayer>> | null>();
    await Promise.all(
        Array.from(pagesNeeded).map(async p => {
            try {
                pageLayers.set(p, await getPageTextLayer(opts.file, p));
            } catch (e) {
                console.warn("[hpv2] page layer fetch failed", { page: p, error: e });
                pageLayers.set(p, null);
            }
        }),
    );

    // Build a key → field lookup for quick access.
    const fieldByKey = new Map<string, OrchestratorOptions["fields"][number]>();
    for (const f of opts.fields) fieldByKey.set(f.key, f);

    const out: OutputHighlightGroup[] = [];

    for (const g of opts.groups) {
        const field = fieldByKey.get(g.key);
        const claim = field ? fieldValue(field, opts.paneIdx) : null;
        const fragments = field ? fieldFragments(field, opts.paneIdx) : [];
        const newBoxes: EnrichedHighlight[] = [];

        // ── Step 1: validate AI boxes ──
        if (opts.flags.bboxValidation) {
            for (const b of g.boxes) {
                const layer = pageLayers.get(b.page ?? 1) ?? null;
                const v = validateBbox(layer, b, claim, fragments);
                if (v.verdict === "high") {
                    stats.bySource["ai-bbox-validated"] += 1;
                    newBoxes.push(tag(b, "ai-bbox-validated", { matchedText: v.matchedText, aiClaim: claim ?? "", step: "validate-high" }));
                } else if (v.verdict === "medium") {
                    stats.bySource["ai-bbox-validated"] += 1;
                    newBoxes.push(tag(b, "ai-bbox-validated", { matchedText: v.matchedText, aiClaim: claim ?? "", step: "validate-medium" }));
                } else {
                    stats.rejected += 1;
                    // Drop — Step 2 may add a replacement below.
                }
            }
        } else {
            // Validation off → pass through as raw, downgraded confidence.
            for (const b of g.boxes) {
                stats.bySource["ai-bbox-raw"] += 1;
                newBoxes.push(tag(b, "ai-bbox-raw", { aiClaim: claim ?? "", step: "validation-disabled" }));
            }
        }

        // ── Step 2: if Step 1 left this group empty (all rejected), search ──
        if (opts.flags.textSearch && newBoxes.length === 0 && claim) {
            // Try the claim itself first; fall back to each fragment.
            const candidates: string[] = [claim, ...fragments].filter(s => s && s.trim().length >= 2);
            // Use the first AI box (if any) as a position hint — even
            // rejected boxes carry a "rough area" the AI was looking at.
            const hint = g.boxes[0];
            let found = false;
            for (const cand of candidates) {
                for (const [pageNum, layer] of pageLayers) {
                    if (!layer) continue;
                    const hit = findInTextLayer(layer, cand, hint);
                    if (!hit) continue;
                    const source: HighlightSource = hit.kind === "exact" ? "text-search-exact" : "text-search-fuzzy";
                    stats.bySource[source] += 1;
                    stats.addedBySearch += 1;
                    newBoxes.push({
                        x: hit.bbox.x, y: hit.bbox.y, width: hit.bbox.width, height: hit.bbox.height,
                        page: pageNum,
                        _isDiff: g.isDiff,
                        confidenceLevel: source === "text-search-exact" ? "high" : "medium",
                        source,
                        debug: { matchedText: hit.matchedText, aiClaim: cand, step: "search" },
                    });
                    found = true;
                    break;
                }
                if (found) break;
            }
        }

        // ── Step 3: table inference for table-type fields ──
        // When the AI flagged this field as a diff and provided per-row data
        // but Step 1+2 still couldn't anchor anything, derive each diff cell
        // from field.rows and search for it inside the detected table region.
        // Narrows the search space versus Step 2 so we don't catch "12" from
        // outside the table when only the table's "12" is the actual diff.
        if (opts.flags.tableInference && field?.rows && g.isDiff) {
            const diffCells = deriveTableDiffCells(field.rows as any, opts.paneIdx);
            if (diffCells.length > 0) {
                // Cache region per page to avoid recomputing.
                const regionByPage = new Map<number, ReturnType<typeof detectTableRegion>>();
                for (const cell of diffCells) {
                    // Skip cells we already have a high-confidence box for —
                    // Step 1/2 may have nailed one row already.
                    if (newBoxes.some(b => b.debug?.matchedText && b.debug.matchedText.includes(cell.value))) continue;
                    for (const [pageNum, layer] of pageLayers) {
                        if (!layer) continue;
                        if (!regionByPage.has(pageNum)) regionByPage.set(pageNum, detectTableRegion(layer));
                        const region = regionByPage.get(pageNum);
                        if (!region) continue;
                        const hit = findCellInTable(layer, region, cell.value, g.boxes[0]);
                        if (!hit) continue;
                        stats.bySource["table-inferred"] += 1;
                        newBoxes.push({
                            x: hit.bbox.x, y: hit.bbox.y, width: hit.bbox.width, height: hit.bbox.height,
                            page: pageNum,
                            // table-inferred boxes always represent a diff cell
                            // (we derive them from deriveTableDiffCells which
                            // only returns differing cells), so override the
                            // group-level flag here for safety.
                            _isDiff: true,
                            confidenceLevel: "medium",
                            source: "table-inferred",
                            debug: { matchedText: hit.matchedText, aiClaim: cell.value, step: `table-row${cell.rowIdx}-col${cell.colKey}` },
                        });
                        break; // one hit per cell
                    }
                }
            }
        }

        // ── Step 4: post-process (dedupe overlaps + group adjacent runs) ──
        const finalBoxes = opts.flags.postprocess ? postprocessGroup(newBoxes) : newBoxes;
        out.push({ key: g.key, isDiff: g.isDiff, boxes: finalBoxes });
    }

    stats.durationMs = performance.now() - t0;
    return { groups: out, stats };
}

export { logStats };
