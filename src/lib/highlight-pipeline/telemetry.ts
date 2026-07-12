// Pipeline telemetry — counters per Compare run so we can measure improvement
// from real production traffic without instrumenting every component.
//
// Phase 2 keeps this entirely client-side: aggregate per-pane stats are
// logged to console on completion (gated by the master flag). A later phase
// can push these to an admin dashboard via /api/system-events if we want
// fleet-wide accuracy metrics.

import type { HighlightSource } from "./types";

export interface PipelineStats {
    paneIdx: number;
    docLabel: string;
    totalGroupsIn: number;
    totalBoxesIn: number;
    bySource: Record<HighlightSource, number>;
    rejected: number;
    addedBySearch: number;
    durationMs: number;
}

export function emptyStats(paneIdx: number, docLabel: string): PipelineStats {
    return {
        paneIdx,
        docLabel,
        totalGroupsIn: 0,
        totalBoxesIn: 0,
        bySource: {
            "ai-bbox-validated": 0,
            "text-search-exact": 0,
            "text-search-fuzzy": 0,
            "table-inferred": 0,
            "ai-bbox-raw": 0,
            "fallback-row-diff": 0,
            "fallback-word-diff": 0,
        },
        rejected: 0,
        addedBySearch: 0,
        durationMs: 0,
    };
}

export function logStats(stats: PipelineStats): void {
    // eslint-disable-next-line no-console
    console.log("[hpv2] pipeline stats", stats);
}
