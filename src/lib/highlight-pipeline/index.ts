// Compare highlight pipeline — entry point.
//
// Phase 1 ships this module dark: it only re-exports building blocks so the
// surface area exists. Subsequent phases will land the actual `runPipeline`
// orchestrator that wires validators → search → table inference → postprocess.
//
// See: docs/COMPARE_HIGHLIGHT_PIPELINE_PLAN.md

export type {
    TextItem,
    PageTextLayer,
    FileTextLayers,
    HighlightSource,
    ConfidenceLevel,
    EnrichedHighlight,
} from "./types";

export {
    getPageTextLayer,
    getAllTextLayers,
    clearTextLayerCache,
    evictTextLayer,
} from "./textLayer";

export { runHighlightPipeline, logStats } from "./orchestrator";
export type { OrchestratorOptions, InputHighlightGroup, OutputHighlightGroup } from "./orchestrator";

export { deriveTableDiffCells, detectTableRegion, findCellInTable } from "./tableInference";
export { iou, dedupe, groupAdjacent, postprocessGroup } from "./postprocess";
