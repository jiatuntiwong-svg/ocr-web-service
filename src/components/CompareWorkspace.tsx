"use client";
import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { User } from "@/lib/types";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { Icon } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { apiError } from "@/lib/friendlyError";
import { fetchJson } from "@/lib/fetchJson";
import { ErrorCode } from "@/lib/errorCodes";
import { estimateCredits, creditTone } from "@/lib/pricing";
import { usePanZoom } from "@/lib/hooks/usePanZoom";
import { ENABLE_OCR_SCAN_LINE, ENABLE_FIELD_POP, ENABLE_HIGHLIGHT_PIPELINE_V2, ENABLE_TEXT_LAYER_EXTRACTION, ENABLE_BBOX_VALIDATION, ENABLE_TEXT_LAYER_SEARCH, ENABLE_TABLE_INFERENCE, ENABLE_HIGHLIGHT_POSTPROCESS, ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";
import CorrectionModal from "./CorrectionModal";
import TemplateRulesPanel from "./TemplateRulesPanel";
import { getPageTextLayer, runHighlightPipeline, logStats, deriveTableDiffCells } from "@/lib/highlight-pipeline";
import html2canvas from "html2canvas";

// Stagger helper: capped delay so 30+ fields don't lag (matches OCRWorkspace).
const fieldPopStyle = (i: number): React.CSSProperties =>
    ENABLE_FIELD_POP ? { animationDelay: `${Math.min(i, 14) * 0.08}s` } : {};
const FIELD_POP_CLASS = ENABLE_FIELD_POP ? "docroom-field-pop" : "";
import {
    evaluateConfirm,
    makeFingerprint,
    shouldSkipDialog,
    recordCreditUse,
    getUserAvgCredits,
    type ConfirmReason,
} from "@/lib/credit-preferences";
import CreditConfirmDialog from "./CreditConfirmDialog";
import { computeRowDiff, type RowDiff } from "@/lib/table-row-diff";
import type { VerdictMode } from "@/lib/diffNormalize";

// pdfjs worker served as a static asset from /public (copied at build time
// by the "copy-pdf-worker" script).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// ─── Shared logic (preserved from previous version) ──────────────────────────
import { extractTokensWithMethod, type SourceMethod } from "@/lib/frontend-ocr";
import { pdfFileToImage } from "@/lib/pdf-to-image";
import { docxFileToImage } from "@/lib/docx-to-image";
import { excelFileToImage } from "@/lib/excel-to-image";
import { isExcelFile, parseExcel, findCellMatches, type ExcelSheet, type ExcelCellRef } from "@/lib/excel-parser";
import ExcelPreview from "./ExcelPreview";
import ConfirmDialog from "./ConfirmDialog";
import { exportCompareResult } from "@/lib/exportUtils";
import { matchValueToTokens, mergeTokenBoxes } from "@/lib/text-matcher";
import type { OCRToken } from "@/lib/types";

interface ExtractField { id: string; name: string; type: "text" | "number" | "currency" | "date" | "address" | "email" | "table" | "raw_text"; }
interface Template { id: string; name: string; fields_json: string; user_id?: string; }
interface HighlightBox { page: number; x: number; y: number; width: number; height: number; text?: string; confidence?: number; }
interface CompareField {
    key: string;
    is_diff: boolean;
    doc1?: string | null;
    doc2?: string | null;
    doc3?: string | null;
    doc1_diff?: string[];
    doc2_diff?: string[];
    doc3_diff?: string[];
    doc1_confidence?: number;
    doc2_confidence?: number;
    doc3_confidence?: number;
    locations?: { doc1?: HighlightBox[]; doc2?: HighlightBox[]; doc3?: HighlightBox[]; };
    // Table-specific extras populated by /api/compare when field type=table.
    rows?: { doc1: any[]; doc2: any[]; doc3?: any[] };
    match_key?: string;
}
interface CompareResult { summary: string[]; fields: CompareField[]; }
interface Props {
    user: User | null;
    /** Current credit balance — feeds the T4 low-balance confirm trigger. */
    balance?: number;
}

// Type color palette (matches OCR — keeps chip language consistent across views)
const TYPE_COLOR: Record<string, string> = {
    text:     "#6366f1",
    number:   "#f59e0b",
    currency: "#10b981",
    date:     "#3b82f6",
    address:  "#8b5cf6",
    email:    "#06b6d4",
    table:    "#ec4899",
    raw_text: "#dc2626",
};

// Multi-word type identifiers display as "RAW TEXT" instead of "RAW_TEXT".
const TYPE_LABEL: Record<string, string> = {
    raw_text: "RAW TEXT",
};

const ACCENT = "#f59e0b"; // Compare zone accent (amber per design tokens)

// ─── Diff / phrase helpers (used by C2 + B1 highlight fallbacks) ────────────
// Per-type normaliser — strips formatting noise so a comma or space doesn't
// register as a "difference" in the word-level diff.
const NORMALIZERS: Record<string, (s: string) => string> = {
    number:   s => s.replace(/[,\s_]/g, "").toLowerCase(),
    currency: s => s.replace(/[,\s_฿$€£¥]/g, "").toLowerCase(),
    date:     s => s.replace(/[\/\-\s,.]/g, "").toLowerCase(),
    address:  s => s.toLowerCase().replace(/[,\s]+/g, " ").trim(),
    email:    s => s.toLowerCase().trim(),
    text:     s => s.toLowerCase().replace(/\s+/g, " ").trim(),
    table:    s => s,   // unused — table fields skip client diff entirely
};
const normalizeFor = (s: string, type: string): string =>
    (NORMALIZERS[type] || NORMALIZERS.text)(s);

// LCS-based word diff. Returns the tokens unique to A and to B (after
// per-type normalisation has decided what counts as "equal"). Used to derive
// highlight fragments when the AI didn't supply useful diff_fragments.
function wordLevelDiff(a: string, b: string, normalize: (w: string) => string): { aFrags: string[]; bFrags: string[] } {
    const aWords = a.split(/\s+/).filter(Boolean);
    const bWords = b.split(/\s+/).filter(Boolean);
    const m = aWords.length, n = bWords.length;
    if (m === 0 || n === 0) return { aFrags: [...aWords], bFrags: [...bWords] };

    // Standard LCS table.
    const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            lcs[i][j] = normalize(aWords[i - 1]) === normalize(bWords[j - 1])
                ? lcs[i - 1][j - 1] + 1
                : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
        }
    }
    // Backtrack: anything not on the LCS path is a fragment unique to that side.
    const aFrags: string[] = [];
    const bFrags: string[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (normalize(aWords[i - 1]) === normalize(bWords[j - 1])) { i--; j--; }
        else if (lcs[i - 1][j] >= lcs[i][j - 1]) { aFrags.unshift(aWords[i - 1]); i--; }
        else { bFrags.unshift(bWords[j - 1]); j--; }
    }
    while (i > 0) { aFrags.unshift(aWords[i - 1]); i--; }
    while (j > 0) { bFrags.unshift(bWords[j - 1]); j--; }
    return { aFrags, bFrags };
}

// Split a long multi-line value into matchable phrases. Used by B1 so that
// long addresses (spread over 3–5 OCR rows) still get partial highlights when
// whole-value matching can't find a contiguous token sequence.
function splitIntoPhrases(s: string): string[] {
    return s
        .split(/[\n;,]+|\s{2,}/g)   // line breaks, semicolons, commas, or 2+ spaces
        .map(p => p.trim())
        .filter(p => p.length >= 4);
}

// ─── PRESERVED: helper to compute exact rendered rect of an image ignoring letterbox ───
function getImageRenderedRect(el: HTMLImageElement) {
    const { naturalWidth, naturalHeight, width, height } = el;
    const containerAspect = width / height;
    const imageAspect = naturalWidth / naturalHeight;

    let renderedW: number, renderedH: number, offsetX: number, offsetY: number;

    if (imageAspect > containerAspect) {
        renderedW = width;
        renderedH = width / imageAspect;
        offsetX = 0;
        offsetY = (height - renderedH) / 2;
    } else {
        renderedH = height;
        renderedW = height * imageAspect;
        offsetX = (width - renderedW) / 2;
        offsetY = 0;
    }

    return { renderedW, renderedH, offsetX, offsetY };
}

// ─── PRESERVED: Document preview component (highlight math, do not touch) ───
const DocumentPreviewWithHighlights = ({ file, url, idx, highlights = [], selectedFieldKey, showHighlights = true, excelOriginal = null, result = null, zoom = 1, onZoomChange, isProcessing = false, showOnlyDiff = false, highlightStyle = "box", onSaveReady }: any) => {
    // Pan + wheel-zoom + dbl-click reset. setZoom is wired through the parent so
    // the existing per-slot zoom state (zooms[idx]) stays the source of truth.
    const panZoom = usePanZoom({
        zoom,
        setZoom: (z: number) => onZoomChange?.(z),
    });
    // Preserve preview scroll across re-renders. Tracks the user's latest
    // scroll position via scroll listener; restored in a layout effect so the
    // snap-to-top from highlight-rect changes never paints.
    const lastPreviewScroll = useRef({ top: 0, left: 0 });
    useEffect(() => {
        const el = panZoom.containerRef.current;
        if (!el) return;
        const onScroll = () => {
            lastPreviewScroll.current.top = el.scrollTop;
            lastPreviewScroll.current.left = el.scrollLeft;
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, [panZoom.containerRef]);
    useLayoutEffect(() => {
        const el = panZoom.containerRef.current;
        if (!el) return;
        if (el.scrollTop !== lastPreviewScroll.current.top || el.scrollLeft !== lastPreviewScroll.current.left) {
            el.scrollTop = lastPreviewScroll.current.top;
            el.scrollLeft = lastPreviewScroll.current.left;
        }
    });

    // Tracker for the smart auto-scroll effect declared further down (after
    // activeHighlights is computed). Kept up here next to the related refs.
    const prevSelectedFieldKeyRef = useRef<string | null | undefined>(undefined);
    const [numPages, setNumPages] = useState<number>();
    const [pageNumber, setPageNumber] = useState<number>(1);
    const containerRef = useRef<HTMLDivElement>(null);
    const imgWrapRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const pdfPageRef = useRef<HTMLDivElement>(null);
    const [imageRects, setImageRects] = useState<React.CSSProperties[]>([]);
    const [pdfPageWidth, setPdfPageWidth] = useState<number>(0);
    // Zoom is passed in from the parent (per-slot state) so the controls
    // can live in the doc-card header. Applied via CSS `zoom` for PDF/Excel
    // and width-based scaling for images so highlight math stays consistent.

    // Parse Excel original once per file so the highlight matcher doesn't
    // re-parse on every render. Cleared when the slot's Excel file changes.
    const [excelSheets, setExcelSheets] = useState<ExcelSheet[]>([]);
    useEffect(() => {
        if (!excelOriginal) { setExcelSheets([]); return; }
        let cancelled = false;
        excelOriginal.arrayBuffer().then((buf: ArrayBuffer) => {
            if (!cancelled) setExcelSheets(parseExcel(buf));
        }).catch(() => { if (!cancelled) setExcelSheets([]); });
        return () => { cancelled = true; };
    }, [excelOriginal]);

    // Text-match the AI-extracted value(s) against every cell in the workbook.
    // No backend cell coords for Excel compare yet (Phase 6C-3b) — substring
    // matching after normalisation is the cheap visual proxy. When a field is
    // selected we highlight only its cells; otherwise every field's matches
    // light up so the user can see which cells fed the comparison.
    const excelHighlights = React.useMemo<ExcelCellRef[]>(() => {
        if (!excelOriginal || !excelSheets.length || !showHighlights || !result?.fields) return [];
        const docKey = `doc${idx + 1}` as const;
        const seen = new Set<string>();
        const out: ExcelCellRef[] = [];
        for (const f of result.fields as any[]) {
            if (selectedFieldKey && f.key !== selectedFieldKey) continue;
            // Respect the "show only diff" toggle so Excel matches PDF/image.
            if (showOnlyDiff && !f.is_diff) continue;
            const val = f[docKey];
            // Skip table-type values (arrays/objects) — too noisy to text-match.
            if (val == null || typeof val === "object") continue;
            for (const cell of findCellMatches(excelSheets, val)) {
                const k = `${cell.sheet}:${cell.row}:${cell.col}`;
                if (seen.has(k)) continue;
                seen.add(k);
                // Attach isDiff so ExcelPreview can pick green-match vs
                // red-diff per cell, matching PDF/image highlight colors.
                out.push({ ...cell, isDiff: !!f.is_diff });
            }
        }
        return out;
    }, [excelOriginal, excelSheets, result, selectedFieldKey, showHighlights, showOnlyDiff, idx]);

    // Phase 2 pipeline state. Declared before activeHighlights so the
    // computation below can reference effectiveHighlights without TDZ issues.
    // The actual pipeline runner lives in a useEffect further down — it
    // populates enrichedGroups asynchronously when flags are enabled.
    const [enrichedGroups, setEnrichedGroups] = useState<typeof highlights | null>(null);
    const effectiveHighlights = enrichedGroups ?? highlights;
    // Compute effective diff per group at render time — defensively covers
    // any path where the upstream isDiff didn't pick up row-level table diffs
    // (pipeline didn't run, AI returned is_diff=false for tables, etc.).
    // This is the single source of truth for highlight color so Doc 1 and
    // Doc 2 stay consistent regardless of which step produced the box.
    const groupIsDiff = (h: any): boolean => {
        if (!!h.isDiff) return true;
        const field = result?.fields?.find((f: any) => f.key === h.key);
        if (field?.rows) {
            try { return deriveTableDiffCells(field.rows, idx).length > 0; } catch { return false; }
        }
        return false;
    };
    const activeHighlights = !showHighlights ? [] : effectiveHighlights
        .filter((h: any) => !selectedFieldKey || h.key === selectedFieldKey)
        .filter((h: any) => !showOnlyDiff || groupIsDiff(h))
        .flatMap((h: any) => {
            const effDiff = groupIsDiff(h);
            return (h.boxes || []).map((b: any) => ({
                ...b,
                // box's own _isDiff (set by Step 3 table-inferred) wins;
                // otherwise inherit group's effective diff.
                _isDiff: b._isDiff === true ? true : effDiff,
                _confidenceLevel: b.confidenceLevel,
                _source: b.source,
            }));
        });

    useEffect(() => {
        if (selectedFieldKey && activeHighlights.length > 0) {
            const firstBox = activeHighlights[0];
            if (firstBox && firstBox.page) setPageNumber(firstBox.page);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedFieldKey, highlights]);

    // ─── Highlight Pipeline v2 — Phase 1: Foundation (text layer probe) ───
    // Pre-warm the cache for the current page so the Phase 2 pipeline below
    // doesn't pay extraction latency on its first run. No render impact.
    useEffect(() => {
        if (!ENABLE_HIGHLIGHT_PIPELINE_V2 || !ENABLE_TEXT_LAYER_EXTRACTION) return;
        if (!file || file.type !== "application/pdf") return;
        let cancelled = false;
        getPageTextLayer(file, pageNumber).then(layer => {
            if (cancelled) return;
            // eslint-disable-next-line no-console
            console.log("[hpv2] text layer", {
                doc: idx + 1, file: file.name, page: pageNumber,
                items: layer?.items.length ?? 0,
                sample: layer?.items.slice(0, 3).map(i => i.str),
            });
        });
        return () => { cancelled = true; };
    }, [file, idx, pageNumber]);

    // ─── Phase 2: Pipeline orchestration ───
    // Runs the validate → search cascade against the AI highlights and stores
    // an enriched copy in `enrichedGroups` (state declared above so the
    // render-time computation can read it). If the pipeline fails or is
    // disabled, enrichedGroups stays null → render uses the original
    // highlights prop unchanged. Rollback-safe by construction.
    useEffect(() => {
        if (!ENABLE_HIGHLIGHT_PIPELINE_V2) { setEnrichedGroups(null); return; }
        if (!file || file.type !== "application/pdf") { setEnrichedGroups(null); return; }
        if (!result?.fields) { setEnrichedGroups(null); return; }
        // Build pipeline input. Two passes:
        //   1. Take AI groups as-is.
        //   2. Compute the "effective isDiff" per group — for TABLE fields,
        //      AI sometimes flags is_diff=false even when individual rows
        //      differ. Without this override the box renders as green (match)
        //      and confuses the user (result panel says "ต่าง", document says
        //      "match"). Row-derived diff overrides AI's field-level flag.
        //   3. Seed any field that should produce highlights (is_diff true OR
        //      table with row diffs) but isn't already a group.
        const fieldByKey = new Map<string, any>();
        for (const f of result.fields as any[]) fieldByKey.set(f.key, f);
        const hasRowDiff = (f: any): boolean => {
            if (!f?.rows) return false;
            return deriveTableDiffCells(f.rows, idx).length > 0;
        };
        const seedGroups = (highlights as any[]).map(g => {
            const f = fieldByKey.get(g.key);
            const effectiveDiff = !!g.isDiff || hasRowDiff(f);
            return { ...g, isDiff: effectiveDiff };
        });
        const seenKeys = new Set(seedGroups.map((g: any) => g.key));
        for (const f of result.fields as any[]) {
            const isDiffField = !!f.is_diff || hasRowDiff(f);
            if (!isDiffField) continue;
            if (seenKeys.has(f.key)) continue;
            seedGroups.push({ key: f.key, isDiff: true, boxes: [] });
        }
        if (seedGroups.length === 0) { setEnrichedGroups(null); return; }
        let cancelled = false;
        runHighlightPipeline({
            file,
            paneIdx: idx,
            groups: seedGroups,
            fields: result.fields as any,
            flags: {
                bboxValidation: ENABLE_BBOX_VALIDATION,
                textSearch: ENABLE_TEXT_LAYER_SEARCH,
                tableInference: ENABLE_TABLE_INFERENCE,
                postprocess: ENABLE_HIGHLIGHT_POSTPROCESS,
            },
        }).then(({ groups, stats }) => {
            if (cancelled) return;
            logStats(stats);
            setEnrichedGroups(groups as any);
        }).catch(err => {
            console.error("[hpv2] pipeline error — falling back to raw highlights", err);
            if (!cancelled) setEnrichedGroups(null);
        });
        return () => { cancelled = true; };
    }, [file, idx, highlights, result]);

    // Smart auto-scroll: when a new field is selected and its first highlight
    // box is outside the visible viewport, smooth-scroll the preview to center
    // the box. If already on screen → do nothing (Option B). Runs after the
    // setPageNumber effect above so by the time the timeout fires, the PDF
    // page is the right one.
    useEffect(() => {
        const el = panZoom.containerRef.current;
        const prev = prevSelectedFieldKeyRef.current;
        prevSelectedFieldKeyRef.current = selectedFieldKey;
        if (!el || prev === selectedFieldKey) return;
        if (!selectedFieldKey || activeHighlights.length === 0) return;
        const box = activeHighlights[0];
        const tid = setTimeout(() => {
            const isPdf = file?.type === "application/pdf";
            const refEl = isPdf ? pdfPageRef.current : imgRef.current;
            const containerEl = panZoom.containerRef.current;
            if (!refEl || !containerEl) return;
            const cRect = containerEl.getBoundingClientRect();
            const rRect = refEl.getBoundingClientRect();
            // Box position in the scrollable content (page/image-relative
            // coords → container-relative pixel coords).
            const boxLeft = (rRect.left - cRect.left) + containerEl.scrollLeft + box.x * rRect.width;
            const boxTop = (rRect.top - cRect.top) + containerEl.scrollTop + box.y * rRect.height;
            const boxW = box.width * rRect.width;
            const boxH = box.height * rRect.height;
            // Already on screen? Bail — no disruption when user is already
            // looking at the right place.
            const visLeft = containerEl.scrollLeft;
            const visTop = containerEl.scrollTop;
            if (boxLeft >= visLeft && boxLeft + boxW <= visLeft + containerEl.clientWidth
                && boxTop >= visTop && boxTop + boxH <= visTop + containerEl.clientHeight) return;
            // Center the box. Update the preserved-scroll ref so the next
            // layout-effect cycle doesn't yank us back to the old position.
            const targetLeft = Math.max(0, boxLeft + boxW / 2 - containerEl.clientWidth / 2);
            const targetTop = Math.max(0, boxTop + boxH / 2 - containerEl.clientHeight / 2);
            lastPreviewScroll.current.left = targetLeft;
            lastPreviewScroll.current.top = targetTop;
            containerEl.scrollTo({ left: targetLeft, top: targetTop, behavior: "smooth" });
        }, 120);
        return () => clearTimeout(tid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedFieldKey, file?.type, activeHighlights]);

    const saveSnapshot = React.useCallback(async () => {
        // Capture the page/image element WITH the absolute-positioned highlight
        // overlays inside it, then download as PNG. Errors are surfaced via
        // console so we don't lose them silently like the previous version.
        if (excelOriginal) {
            console.warn("[saveSnapshot] Excel preview — skipped");
            return;
        }
        const isPdf = file?.type === "application/pdf";
        const target = isPdf ? pdfPageRef.current : imgWrapRef.current;
        if (!target) {
            console.error("[saveSnapshot] target ref is null", { isPdf });
            return;
        }
        try {
            const canvas = await html2canvas(target, {
                backgroundColor: "#ffffff",
                scale: 2,
                useCORS: true,
                logging: false,
            });
            const blob: Blob | null = await new Promise(res => canvas.toBlob(b => res(b), "image/png"));
            if (!blob) {
                console.error("[saveSnapshot] toBlob returned null");
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            const baseName = (file?.name || `doc${idx + 1}`).replace(/\.[^.]+$/, "");
            a.href = url;
            a.download = `${baseName}_highlighted.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error("[saveSnapshot] html2canvas / download failed", e);
        }
    }, [file, idx, excelOriginal]);
    // Publish the save callback to the parent so the Save button can live in
    // the pane header (outside the pan-zoom container which was intercepting
    // mousedown and racing the button click).
    useEffect(() => {
        if (!onSaveReady) return;
        onSaveReady(saveSnapshot);
        return () => onSaveReady(null);
    }, [onSaveReady, saveSnapshot]);

    const recalculateImageHighlights = React.useCallback(() => {
        if (!imgRef.current || !containerRef.current || file?.type === "application/pdf") return;
        const el = imgRef.current;
        const wrap = imgWrapRef.current;
        if (!wrap || !el.naturalWidth) return;

        const mediaRect = el.getBoundingClientRect();
        const containerRect = wrap.getBoundingClientRect();
        const relativeOffsetX = mediaRect.left - containerRect.left;
        const relativeOffsetY = mediaRect.top - containerRect.top;
        const { renderedW, renderedH, offsetX, offsetY } = getImageRenderedRect(el);

        const rects = activeHighlights.map((box: any) => {
            const conf = typeof box.confidence === "number" ? box.confidence : 1;
            const lowConf = conf < 0.6;
            const isDiff = !!box._isDiff;
            const lvl: "high" | "medium" | "low" | undefined = box._confidenceLevel;
            const useLvl = lvl !== undefined;
            const dashed = useLvl ? lvl === "low" : lowConf;
            const borderPx = useLvl ? (lvl === "high" ? 2.5 : lvl === "medium" ? 2 : 1.5) : 2;
            const bgAlpha = useLvl ? (lvl === "high" ? 0.32 : lvl === "medium" ? 0.20 : 0.12) : 0.18;
            const color = isDiff ? "rgba(239, 68, 68, 0.95)" : "rgba(16, 185, 129, 0.95)";
            const bg = isDiff ? `rgba(239, 68, 68, ${bgAlpha})` : `rgba(16, 185, 129, ${bgAlpha})`;
            const glow = isDiff ? "0 0 8px rgba(239,68,68,0.55)" : "0 0 8px rgba(16,185,129,0.55)";
            const isUnderline = highlightStyle === "underline";
            const base: React.CSSProperties = {
                position: 'absolute' as const,
                left: relativeOffsetX + offsetX + box.x * renderedW + "px",
                top: relativeOffsetY + offsetY + box.y * renderedH + "px",
                width: box.width * renderedW + "px",
                height: box.height * renderedH + "px",
                pointerEvents: 'none' as const,
                transition: 'all 0.15s ease',
                zIndex: 20,
            };
            return isUnderline
                ? {
                    ...base,
                    borderBottom: `${borderPx}px ${dashed ? "dashed" : "solid"} ${color}`,
                    background: "transparent",
                }
                : {
                    ...base,
                    border: `${borderPx}px ${dashed ? "dashed" : "solid"} ${color}`,
                    backgroundColor: bg,
                    boxShadow: useLvl && lvl !== "high" ? "none" : glow,
                    borderRadius: 2,
                };
        });
        setImageRects(rects);
    }, [activeHighlights, file?.type, highlightStyle]);

    useEffect(() => {
        recalculateImageHighlights();
        const container = containerRef.current;
        if (!container || file?.type === "application/pdf") return;
        const ro = new ResizeObserver(() => recalculateImageHighlights());
        ro.observe(container);
        return () => ro.disconnect();
    }, [recalculateImageHighlights, file?.type]);

    // CSS `zoom` doesn't trigger ResizeObserver on stable parents — rerun the
    // highlight math manually on the next paint after a zoom change.
    useEffect(() => {
        if (file?.type === "application/pdf") return;
        const t = setTimeout(recalculateImageHighlights, 30);
        return () => clearTimeout(t);
    }, [zoom, recalculateImageHighlights, file?.type]);

    useEffect(() => {
        const el = pdfPageRef.current;
        if (!el || file?.type !== "application/pdf") return;
        const ro = new ResizeObserver(() => { setPdfPageWidth(el.clientWidth); });
        ro.observe(el);
        return () => ro.disconnect();
    }, [file?.type]);

    if (!file) return null;

    const renderPdfHighlightBox = (box: any, i: number) => {
        const conf = typeof box.confidence === "number" ? box.confidence : 1;
        const lowConf = conf < 0.6;
        const isDiff = !!box._isDiff;
        // Pipeline v2 emits _confidenceLevel = "high" | "medium" | "low".
        // When present it OVERRIDES the legacy `conf < 0.6` heuristic so the
        // visual hierarchy reflects pipeline trust rather than raw AI score.
        const lvl: "high" | "medium" | "low" | undefined = box._confidenceLevel;
        const useLvl = lvl !== undefined;
        const dashed = useLvl ? lvl === "low" : lowConf;
        const borderPx = useLvl ? (lvl === "high" ? 2.5 : lvl === "medium" ? 2 : 1.5) : 2;
        const bgAlpha = useLvl ? (lvl === "high" ? 0.32 : lvl === "medium" ? 0.20 : 0.12) : 0.18;
        // Red = diff, Green = match. Low confidence ⇒ dashed border.
        const color = isDiff
            ? "rgba(239, 68, 68, 0.95)"
            : "rgba(16, 185, 129, 0.95)";
        const bg = isDiff
            ? `rgba(239, 68, 68, ${bgAlpha})`
            : `rgba(16, 185, 129, ${bgAlpha})`;
        const glow = isDiff
            ? "0 0 8px rgba(239,68,68,0.55)"
            : "0 0 8px rgba(16,185,129,0.55)";
        const isUnderline = highlightStyle === "underline";
        const inlineStyle: React.CSSProperties = isUnderline
            ? {
                position: "absolute",
                borderBottom: `${borderPx}px ${dashed ? "dashed" : "solid"} ${color}`,
                background: "transparent",
                boxShadow: "none",
                zIndex: 20,
                pointerEvents: "none",
            }
            : {
                position: "absolute",
                border: `${borderPx}px ${dashed ? "dashed" : "solid"} ${color}`,
                background: bg,
                boxShadow: useLvl && lvl === "high" ? glow : (useLvl ? "none" : glow),
                borderRadius: 2,
                zIndex: 20,
                pointerEvents: "none",
            };
        const titleParts: string[] = [];
        if (isDiff) titleParts.push("Diff");
        else titleParts.push("Match");
        if (lowConf) titleParts.push(`Low confidence (${(conf * 100).toFixed(0)}%)`);
        return (
            <div key={i}
                title={titleParts.join(" · ")}
                style={{
                    ...inlineStyle,
                    left: (box.x * 100).toFixed(4) + "%",
                    top: (box.y * 100).toFixed(4) + "%",
                    width: (box.width * 100).toFixed(4) + "%",
                    height: (box.height * 100).toFixed(4) + "%",
                }}
            />
        );
    };

    if (excelOriginal) {
        // Excel originals get the interactive grid (sheet tabs + scroll) instead
        // of the converted PNG which is hard to read. AI compare still uses the
        // image path; highlights are bbox-based and don't map back to cells.
        return (
            <div className="relative shadow-sm mx-auto w-full h-full min-h-[50vh] bg-slate-200/50 dark:bg-slate-900/50 p-1" ref={containerRef}>
                <div style={{ width: "100%", height: "100%", zoom: zoom as any }}>
                    <ExcelPreview file={excelOriginal} highlights={excelHighlights} />
                </div>
            </div>
        );
    }

    return (
        <div
            className="relative shadow-sm mx-auto w-full h-full min-h-[50vh] overflow-auto bg-slate-200/50 dark:bg-slate-900/50 flex p-4 custom-scrollbar"
            ref={(el) => {
                // Two refs share this node: existing one for highlight math, the
                // new one for pan/zoom scroll control.
                (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
                (panZoom.containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
            }}
            onMouseDown={panZoom.containerProps.onMouseDown}
            onMouseMove={panZoom.containerProps.onMouseMove}
            onMouseUp={panZoom.containerProps.onMouseUp}
            onMouseLeave={panZoom.containerProps.onMouseLeave}
            onDoubleClick={panZoom.containerProps.onDoubleClick}
            style={{
                // `safe center` keeps the doc centered when it fits but falls back
                // to `start` when zoomed past container width — otherwise plain
                // center clips the LEFT edge when scrolled all the way left.
                // Tailwind has no `safe` variant so the value is inline.
                justifyContent: "safe center",
                alignItems: "safe center",
                ...panZoom.containerProps.style,
            }}
        >
            {/* Scan-line overlay while AI compare is running. Same feature flag
                as OCR; falls back gracefully when flag is off. */}
            {ENABLE_OCR_SCAN_LINE && isProcessing && (
                <div className="docroom-scan-line" aria-hidden />
            )}
            {file.type === "application/pdf" ? (
                // PDF: CSS `zoom` scales the page + percentage-based highlight
                // overlays together — math stays consistent.
                <div style={{ zoom: zoom as any }}>
                <div className="relative inline-block bg-white shadow-xl" ref={pdfPageRef}>
                    <Document
                        file={file}
                        onLoadSuccess={({ numPages: np }) => setNumPages(np)}
                        loading={<div className="w-full h-64 flex items-center justify-center text-slate-400 text-xs font-bold">Loading PDF...</div>}
                    >
                        <Page
                            pageNumber={pageNumber}
                            renderTextLayer={false}
                            renderAnnotationLayer={false}
                            width={pdfPageWidth || undefined}
                            className="shadow-md transition-all relative"
                            onRenderSuccess={() => { if (pdfPageRef.current) setPdfPageWidth(pdfPageRef.current.clientWidth); }}
                        >
                            {activeHighlights.filter((h: any) => h.page === pageNumber).map(renderPdfHighlightBox)}
                        </Page>
                    </Document>
                    {numPages && numPages > 1 && (
                        <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 bg-slate-800 text-white px-4 py-1.5 rounded-full text-xs font-bold flex items-center gap-4 shadow-lg z-30">
                            <button disabled={pageNumber <= 1} onClick={() => setPageNumber(p => p - 1)} className="hover:text-blue-400 disabled:opacity-30 transition-colors">&lt; Prev</button>
                            <span>{pageNumber} / {numPages}</span>
                            <button disabled={pageNumber >= numPages} onClick={() => setPageNumber(p => p + 1)} className="hover:text-blue-400 disabled:opacity-30 transition-colors">Next &gt;</button>
                        </div>
                    )}
                </div>
                </div>
            ) : (
                // Image branch: zoom is applied as a real width on the wrap
                // so the existing highlight math (renderedW from
                // getBoundingClientRect) recomputes correctly. Outer container
                // is overflow-auto, so the wider image scrolls.
                <div ref={imgWrapRef} className="relative inline-block" style={{ width: `${100 * zoom}%`, flexShrink: 0, maxWidth: "none" }}>
                    <img ref={imgRef} src={url} alt={"Doc " + (idx + 1)} onLoad={recalculateImageHighlights} className="w-full h-auto pointer-events-none rounded-sm border border-slate-200 dark:border-slate-800 shadow-md block relative" />
                    {imageRects.map((style, i) => (<div key={i} style={style} />))}
                </div>
            )}
        </div>
    );
};

// Compact zoom button styling for the doc-card header (lighter than the
// floating overlay variant — sits inline with filename/replace/remove).
const headerZoomBtnStyle = (disabled: boolean): React.CSSProperties => ({
    background: "transparent",
    border: "1px solid var(--color-border)",
    color: "var(--color-text-2)",
    padding: "1px 6px",
    borderRadius: 4,
    fontSize: 11, fontWeight: 700, lineHeight: 1.4,
    minWidth: 20,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
});

const zoomBtnStyle = (disabled: boolean): React.CSSProperties => ({
    background: disabled ? "transparent" : "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "#fff",
    padding: "3px 8px",
    borderRadius: 5,
    fontSize: 12, fontWeight: 700,
    minWidth: 24,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transition: "background 0.15s",
});

// ─── Template list group (reused pattern from OCR) ──────────────────────────
interface TemplateGroupProps {
    title: string;
    items: Template[];
    activeId: string | null;
    onPick: (t: Template) => void;
    onBookmark: (id: string, e: React.MouseEvent) => void;
    bookmarkedIds: string[];
    accent: string;
    onDelete?: (id: string, e: React.MouseEvent) => Promise<void>;
    defaultId?: string | null;
    onSetDefault?: (id: string | null, e: React.MouseEvent) => void;
    pinLabel?: string;
    pinnedLabel?: string;
}

function TemplateGroup({ title, items, activeId, onPick, onBookmark, bookmarkedIds, accent, onDelete, defaultId, onSetDefault, pinLabel = "Set as default", pinnedLabel = "Default" }: TemplateGroupProps) {
    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.1, color: "var(--color-text-4)", textTransform: "uppercase", padding: "4px 6px 6px" }}>
                {title}
            </div>
            {items.map(tpl => {
                const active = activeId === tpl.id;
                const bookmarked = bookmarkedIds.includes(tpl.id);
                const isDefault = defaultId === tpl.id;
                return (
                    <div key={tpl.id} style={{ position: "relative" }}>
                        <button onClick={() => onPick(tpl)}
                            className={`ocr-template-item${active ? " is-active" : ""}`}
                            style={{
                                width: "100%", textAlign: "left",
                                padding: onSetDefault ? "7px 64px 7px 10px" : "7px 44px 7px 10px",
                                borderRadius: 6,
                                border: "none", cursor: "pointer",
                                background: active ? `${accent}22` : "transparent",
                                color: active ? accent : "var(--color-text-2)",
                                fontSize: 12.5, fontWeight: active ? 600 : 400,
                                display: "flex", alignItems: "center", gap: 7,
                                ["--ocr-template-accent" as any]: accent,
                            }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: active ? accent : "var(--color-text-4)", flexShrink: 0 }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {tpl.name.split(" (")[0]}
                            </span>
                            {isDefault && (
                                <span style={{ fontSize: 8.5, fontWeight: 700, background: `${accent}22`, color: accent, padding: "1px 5px", borderRadius: 8, letterSpacing: 0.5, textTransform: "uppercase", flexShrink: 0 }}>
                                    {pinnedLabel}
                                </span>
                            )}
                        </button>
                        <div style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", display: "flex", gap: 0 }}>
                            {onSetDefault && (
                                <button onClick={(e) => onSetDefault(isDefault ? null : tpl.id, e)}
                                    title={isDefault ? `${pinnedLabel} (คลิกเพื่อยกเลิก)` : pinLabel}
                                    style={{ background: "none", border: "none", color: isDefault ? accent : "var(--color-text-4)", cursor: "pointer", padding: 3, display: "inline-flex" }}>
                                    <Icon.Pin width={11} height={11} />
                                </button>
                            )}
                            <button onClick={(e) => onBookmark(tpl.id, e)} title="Bookmark"
                                style={{ background: "none", border: "none", color: bookmarked ? "#f59e0b" : "var(--color-text-4)", cursor: "pointer", padding: 3, display: "inline-flex" }}>
                                <Icon.Star width={11} height={11} />
                            </button>
                            {onDelete && (
                                <button onClick={(e) => onDelete(tpl.id, e)} title="Delete"
                                    style={{ background: "none", border: "none", color: "var(--color-text-4)", cursor: "pointer", padding: 3, display: "inline-flex" }}>
                                    <Icon.X width={11} height={11} />
                                </button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ─── Main ───────────────────────────────────────────────────────────────────
export default function CompareWorkspace({ user, balance = 0 }: Props) {
    const { t } = useTranslation();

    // File state
    const [files, setFiles] = useState<(File | null)[]>([null, null]);
    const [previews, setPreviews] = useState<(string | null)[]>([null, null]);
    // Excel originals kept alongside so we can render with <ExcelPreview>
    // (sheet tabs + scrollable grid) instead of the cramped converted PNG.
    // AI still gets the PNG path; this is preview-only.
    const [excelOriginals, setExcelOriginals] = useState<(File | null)[]>([null, null]);
    const [converting, setConverting] = useState<boolean[]>([]);
    // Parallel to `converting` — records the source format so the spinner can
    // show the right label (PDF vs Word).
    const [convertingKind, setConvertingKind] = useState<("pdf" | "docx" | "xlsx" | null)[]>([]);

    // Processing
    const [loading, setLoading] = useState(false);
    const [processStep, setProcessStep] = useState<string>("");
    const [result, setResult] = useState<CompareResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isExpandedView, setIsExpandedView] = useState(false);
    // Right-hand result panel collapsed → preview takes the full row.
    // Decoupled from `isExpandedView` (which is the fullscreen-result mode).
    const [resultCollapsed, setResultCollapsed] = useState(false);
    // Phase D: rules the server injected into this Compare run. Keyed by
    // field target so the result panel can render a small badge per field.
    const [appliedRules, setAppliedRules] = useState<Array<{ id: string; type: string; naturalLang: string; target: string | null }>>([]);
    // Phase A-E: open/close the rule browser modal.
    const [rulesModalOpen, setRulesModalOpen] = useState(false);
    // Per-pane Save snapshot callbacks — child publishes its save function so
    // the button can live in the pane header (outside the pan-zoom container).
    const saveSnapshotRefs = useRef<Map<number, (() => Promise<void>) | null>>(new Map());
    const [savingPane, setSavingPane] = useState<number | null>(null);
    const triggerSaveSnapshot = async (paneIdx: number) => {
        const fn = saveSnapshotRefs.current.get(paneIdx);
        if (!fn) { console.warn("[saveSnapshot] no callback registered for pane", paneIdx); return; }
        setSavingPane(paneIdx);
        try { await fn(); } finally { setSavingPane(null); }
    };
    // Scroll preservation for the result list. Without this, clicking a field
    // (which updates selectedFieldKey + activeHighlights + highlight rects)
    // sometimes makes the panel snap back to top because React's commit phase
    // changes layout-affecting properties. The ref tracks the user's latest
    // scrollTop continuously; after every relevant state change we restore it.
    const resultScrollRef = useRef<HTMLDivElement | null>(null);
    const lastResultScroll = useRef(0);
    useEffect(() => {
        const el = resultScrollRef.current;
        if (!el) return;
        const onScroll = () => { lastResultScroll.current = el.scrollTop; };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, [result]);
    // Highlight display preferences — persisted so users don't reset on reload.
    // Default `showOnlyDiff = true` (Phase 4 / D5 decision) so the workspace
    // opens in "scan and spot" mode by default. Returning users keep whatever
    // they had stored.
    const [showOnlyDiff, setShowOnlyDiff] = useState(true);
    const [highlightStyle, setHighlightStyle] = useState<"box" | "underline">("box");
    const [diffOnlyHintSeen, setDiffOnlyHintSeen] = useState(true);
    useEffect(() => {
        try {
            const d = localStorage.getItem("compare_show_only_diff");
            if (d != null) setShowOnlyDiff(d === "1");
            const s = localStorage.getItem("compare_highlight_style");
            if (s === "box" || s === "underline") setHighlightStyle(s);
            // First-time hint: shown once when DIFF-only is the default.
            const seen = localStorage.getItem("compare_diff_only_hint_seen");
            setDiffOnlyHintSeen(seen === "1");
        } catch {}
    }, []);
    useEffect(() => {
        try { localStorage.setItem("compare_show_only_diff", showOnlyDiff ? "1" : "0"); } catch {}
    }, [showOnlyDiff]);
    useEffect(() => {
        try { localStorage.setItem("compare_highlight_style", highlightStyle); } catch {}
    }, [highlightStyle]);
    // Restore result panel scroll after any state that causes a re-render of
    // the result list — runs in the layout phase so the snap-to-top never
    // paints. (Field selection, diff-only toggle, style toggle.)
    useLayoutEffect(() => {
        const el = resultScrollRef.current;
        if (!el) return;
        if (lastResultScroll.current && el.scrollTop !== lastResultScroll.current) {
            el.scrollTop = lastResultScroll.current;
        }
    });
    const [ocrSourceMethods, setOcrSourceMethods] = useState<SourceMethod[]>([]);

    // Verdict mode — controls how the server decides is_diff (and how the
    // client-side row-diff treats table cells). Persisted to localStorage so
    // the user's last choice survives reload.
    const [verdictMode, setVerdictMode] = useState<VerdictMode>(() => {
        if (typeof window === "undefined") return "smart";
        const saved = window.localStorage.getItem("compare_verdict_mode");
        return saved === "strict" || saved === "smart" ? saved : "smart";
    });
    useEffect(() => {
        try { window.localStorage.setItem("compare_verdict_mode", verdictMode); } catch {}
    }, [verdictMode]);

    // Templates
    const [templates, setTemplates] = useState<Template[]>([]);
    const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
    // Phase B: "Mark wrong" target. When set, the CorrectionModal opens for
    // this field — value is captured from result.fields and persisted via
    // /api/templates/corrections so future phases can turn it into a rule.
    const [correctionTarget, setCorrectionTarget] = useState<{
        fieldKey: string;
        fieldLabel: string;
        currentValue?: string;
        paneIdx?: number;
    } | null>(null);
    const [templateName, setTemplateName] = useState("");
    const [templateSearch, setTemplateSearch] = useState("");
    const [bookmarkedIds, setBookmarkedIds] = useState<string[]>([]);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [templateRailOpen, setTemplateRailOpen] = useState(true);
    const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
    const [defaultApplied, setDefaultApplied] = useState(false);

    // Fields
    const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);
    const [highlightsEnabled, setHighlightsEnabled] = useState(true);
    // Per-slot zoom — lifted from DocumentPreviewWithHighlights so the +/-/reset
    // controls can live in the doc-card header row alongside the filename.
    const [zooms, setZooms] = useState<number[]>([1, 1]);
    const setZoomAt = (idx: number, next: number) => {
        const v = Math.max(0.5, Math.min(3, +next.toFixed(2)));
        setZooms(prev => { const n = [...prev]; n[idx] = v; return n; });
    };
    // Drag-to-reorder state for the field chips below. Browser threshold
    // distinguishes click (= remove) from drag (= reorder) automatically.
    const [draggingFieldId, setDraggingFieldId] = useState<string | null>(null);
    const [dropTargetFieldId, setDropTargetFieldId] = useState<string | null>(null);
    const reorderField = (fromId: string, toId: string) => {
        if (fromId === toId) return;
        setExtractFields(prev => {
            const fromIdx = prev.findIndex(x => x.id === fromId);
            const toIdx = prev.findIndex(x => x.id === toId);
            if (fromIdx < 0 || toIdx < 0) return prev;
            const arr = [...prev];
            const [moved] = arr.splice(fromIdx, 1);
            arr.splice(toIdx, 0, moved);
            return arr;
        });
    };
    const [extractFields, setExtractFields] = useState<ExtractField[]>([
        { id: "1", name: "ประเภทเอกสาร", type: "text" },
        { id: "2", name: "เลขที่เอกสาร", type: "number" },
        { id: "3", name: "วันที่", type: "date" },
        { id: "4", name: "ชื่อผู้ออก", type: "text" },
        { id: "5", name: "เลขผู้เสียภาษี", type: "number" },
        { id: "6", name: "เงื่อนไขชำระเงิน", type: "text" },
        { id: "7", name: "ยอดรวม", type: "currency" },
        { id: "8", name: "รายการสินค้า", type: "table" },
    ]);
    const [newFieldName, setNewFieldName] = useState("");
    const [newFieldType, setNewFieldType] = useState<ExtractField["type"]>("text");
    const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);

    // ─── Credit confirm dialog ───
    const [confirmDialog, setConfirmDialog] = useState<{
        reasons: ConfirmReason[];
        fingerprint: string;
    } | null>(null);

    // ── Bookmarks ──
    useEffect(() => {
        const saved = localStorage.getItem("ocr_bookmarked_templates");
        if (saved) setBookmarkedIds(JSON.parse(saved));
    }, []);

    const toggleBookmark = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setBookmarkedIds(prev => {
            const next = prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id];
            localStorage.setItem("ocr_bookmarked_templates", JSON.stringify(next));
            return next;
        });
    };

    // ── Fetch templates + user default template prefs ──
    useEffect(() => {
        if (!user) return;
        fetch(`/api/templates?userId=${user.id}`)
            .then(r => r.json())
            .then((d: any) => { if (Array.isArray(d)) setTemplates(d); })
            .catch(console.error);
        fetchJson<{ defaultCompareTemplateId: string | null }>(`/api/user-prefs?userId=${user.id}`)
            .then(r => { if (r.ok) setDefaultTemplateId(r.defaultCompareTemplateId); })
            .catch(() => { /* prefs are best-effort */ });
    }, [user]);

    // Auto-apply once both templates + prefs are loaded; user-driven changes
    // (pinning, manual template pick) flip `defaultApplied` to true so this
    // doesn't keep overwriting their selection within the same session.
    useEffect(() => {
        if (defaultApplied || !defaultTemplateId || templates.length === 0) return;
        const tpl = templates.find(x => x.id === defaultTemplateId);
        if (!tpl) { setDefaultApplied(true); return; }
        try {
            setExtractFields(JSON.parse(tpl.fields_json));
            setActiveTemplateId(tpl.id);
        } catch { /* malformed template — skip */ }
        setDefaultApplied(true);
    }, [defaultTemplateId, templates, defaultApplied]);

    // ── Template actions ──
    const applyTemplate = (tpl: Template) => {
        setExtractFields(JSON.parse(tpl.fields_json));
        setActiveTemplateId(tpl.id);
    };

    const setAsDefault = async (id: string | null, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!user) return;
        const prev = defaultTemplateId;
        setDefaultTemplateId(id);
        setDefaultApplied(true);
        const res = await fetchJson("/api/user-prefs", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: user.id, kind: "compare", templateId: id }),
        });
        if (!res.ok) {
            setDefaultTemplateId(prev);
            setError(apiError(res.code, res.vars, t));
        }
    };

    const saveTemplate = async (overrideId?: string) => {
        if (!user) return;
        const isOverwrite = !!overrideId;
        const tpl = isOverwrite ? templates.find(t => t.id === overrideId) : null;
        const name = isOverwrite ? (tpl?.name || "") : templateName.trim();
        if (!name) return;
        setSavingTemplate(true);
        try {
            const res = await fetch("/api/templates", {
                method: "POST",
                body: JSON.stringify({ userId: user.id, name, fields: extractFields, ...(overrideId ? { id: overrideId } : {}) }),
            });
            const d = await res.json() as { success: boolean };
            if (d.success) {
                if (!isOverwrite) setTemplateName("");
                const r = await fetch(`/api/templates?userId=${user.id}`);
                const data = await r.json() as any[];
                if (Array.isArray(data)) setTemplates(data);
            }
        } finally {
            setSavingTemplate(false);
        }
    };

    // Modal-driven delete (replaces window.confirm).
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
    const pendingDeleteName = pendingDeleteId
        ? templates.find(tpl => tpl.id === pendingDeleteId)?.name || ""
        : "";
    const deleteTemplate = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!user) return;
        setPendingDeleteId(id);
    };
    const confirmDelete = async () => {
        const id = pendingDeleteId;
        setPendingDeleteId(null);
        if (!id || !user) return;
        await fetch(`/api/templates?id=${id}&userId=${user.id}`, { method: "DELETE" });
        setTemplates(prev => prev.filter(x => x.id !== id));
        if (activeTemplateId === id) setActiveTemplateId(null);
    };

    // ── Field add ──
    const addField = () => {
        if (!newFieldName.trim()) return;
        setExtractFields(prev => [...prev, { id: crypto.randomUUID(), name: newFieldName, type: newFieldType }]);
        setNewFieldName("");
    };

    // ── File handling (PRESERVED: PDF → image up front) ──
    const handleFileInput = async (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
        const picked = e.target.files?.[0];
        if (!picked) return;
        e.target.value = "";

        // Always clear the slot's Excel original up front — only the Excel
        // branch below will set it again. Without this, swapping an Excel
        // file for a PDF/Word/image leaves the previous workbook's
        // <ExcelPreview> stuck on screen.
        setExcelOriginals(prev => { const n = [...prev]; n[index] = null; return n; });

        let file = picked;
        // .docx only — legacy .doc binary is handled in Phase 6C-2c (text-only path).
        const lowerName = picked.name.toLowerCase();
        const isDocx = lowerName.endsWith(".docx")
            || picked.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const markConverting = (kind: "pdf" | "docx" | "xlsx" | null) => {
            setConverting(c => { const n = [...c]; n[index] = kind != null; return n; });
            setConvertingKind(k => { const n = [...k]; n[index] = kind; return n; });
        };
        if (picked.type === "application/pdf") {
            markConverting("pdf");
            try {
                file = await pdfFileToImage(picked);
            } catch (err) {
                console.error("PDF→image conversion failed", err);
                setError(t("compare.convertFailed", { msg: (err as any)?.message || "unknown" }));
                markConverting(null);
                return;
            }
            markConverting(null);
        } else if (isDocx) {
            markConverting("docx");
            try {
                file = await docxFileToImage(picked);
            } catch (err) {
                console.error("DOCX→image conversion failed", err);
                setError(t("compare.convertDocxFailed", { msg: (err as any)?.message || "unknown" }));
                markConverting(null);
                return;
            }
            markConverting(null);
        } else if (isExcelFile(picked)) {
            markConverting("xlsx");
            try {
                file = await excelFileToImage(picked);
                setExcelOriginals(prev => { const n = [...prev]; n[index] = picked; return n; });
            } catch (err) {
                console.error("Excel→image conversion failed", err);
                setError(t("compare.convertFailed", { msg: (err as any)?.message || "unknown" }));
                markConverting(null);
                return;
            }
            markConverting(null);
        }

        setFiles(prev => { const n = [...prev]; n[index] = file; return n; });
        setPreviews(prev => {
            const n = [...prev];
            if (n[index]) URL.revokeObjectURL(n[index] as string);
            n[index] = URL.createObjectURL(file);
            return n;
        });
        setResult(null);
        setSelectedFieldKey(null);
        setIsExpandedView(false);
    };

    const addFileSlot = () => {
        if (files.length < 3) {
            setFiles([...files, null]);
            setPreviews([...previews, null]);
            setExcelOriginals(prev => [...prev, null]);
            setZooms(prev => [...prev, 1]);
            setIsExpandedView(false);
        }
    };

    const removeFileSlot = (index: number) => {
        const newFiles = [...files];
        const newPreviews = [...previews];
        if (newPreviews[index]) URL.revokeObjectURL(newPreviews[index] as string);
        newFiles.splice(index, 1);
        newPreviews.splice(index, 1);
        setFiles(newFiles);
        setPreviews(newPreviews);
        setExcelOriginals(prev => { const n = [...prev]; n.splice(index, 1); return n; });
        setZooms(prev => { const n = [...prev]; n.splice(index, 1); return n; });
        setResult(null);
        setIsExpandedView(false);
    };

    // ── Compare run (PRESERVED — full match logic) ──
    // Intercept the Run click to evaluate the confirm dialog. Skips the
    // dialog when the user has previously ticked "Don't ask again" for this
    // fingerprint, or when no trigger fires.
    const tryRunCompare = () => {
        if (validFilesCount < 2 || extractFields.length === 0 || loading) return;
        const fp = makeFingerprint({
            operation: "compare",
            templateId: activeTemplateId,
            fieldCount: extractFields.length,
            docCount: validFilesCount,
        });
        if (shouldSkipDialog(fp)) { runComparison(); return; }
        const hasTableField = extractFields.some(f => f.type === "table");
        const ev = evaluateConfirm({
            estimate: estimate.credits,
            balance,
            hasTableField,
        });
        if (!ev.needsConfirm) { runComparison(); return; }
        setConfirmDialog({ reasons: ev.reasons, fingerprint: fp });
    };

    const runComparison = async () => {
        const validFiles = files.filter(f => f !== null) as File[];
        if (validFiles.length < 2) return;

        setLoading(true);
        setProcessStep(t("compare.stepOcr"));
        setError(null);
        setResult(null);
        setSelectedFieldKey(null);

        const formData = new FormData();
        if (user) formData.append("userId", user.id);
        const stringifiedFields = extractFields.map(f => f.type !== "text" ? `${f.name} (${f.type})` : f.name).join(", ");
        if (stringifiedFields) formData.append("fields", stringifiedFields);
        formData.append("verdictMode", verdictMode);
        // Phase D — anchor rules to the active template so the backend can
        // inject them into the AI prompt. Optional: legacy compares without
        // a chosen template still work, the server short-circuits the helper.
        if (activeTemplateId) formData.append("templateId", activeTemplateId);

        const extractResults = await Promise.all(validFiles.map(f => extractTokensWithMethod(f)));
        const allTokens: OCRToken[][] = extractResults.map(r => r.tokens);
        const sourceMethods: SourceMethod[] = extractResults.map(r => r.sourceMethod);
        setOcrSourceMethods(sourceMethods);

        validFiles.forEach((file, idx) => { formData.append(`file${idx + 1}`, file); });

        try {
            setProcessStep(t("compare.stepAi"));
            const data = await fetchJson<any>("/api/compare", { method: "POST", body: formData });
            if (!data.ok) {
                throw Object.assign(new Error(data.code), { code: data.code, vars: data.vars });
            }

            const aiResult = data.extracted_data && Array.isArray(data.extracted_data.fields)
                ? data.extracted_data : { summary: [], fields: [] };

            setProcessStep(t("compare.stepMatch"));
            const fieldTypeMap: Record<string, string> = {};
            for (const f of extractFields) fieldTypeMap[f.name.trim().toLowerCase()] = f.type;

            const debugEnabled = (() => {
                try {
                    if (typeof window === "undefined") return false;
                    if (new URL(window.location.href).searchParams.get("debug") === "1") {
                        localStorage.setItem("ocr_debug", "1");
                    }
                    return localStorage.getItem("ocr_debug") === "1";
                } catch { return false; }
            })();

            const enrichedFields = aiResult.fields.map((field: any) => {
                const isTable = fieldTypeMap[String(field.key || "").trim().toLowerCase()] === "table";
                const docVals = [field.doc1, field.doc2, field.doc3];
                const docDiffs = [field.doc1_diff, field.doc2_diff, field.doc3_diff];
                const locations: any = {};
                const matchSummary: any[] = [];
                const whyAll: any[] = [];

                // Table fields ALSO get document highlights now — the AI prompt
                // emits docN_diff as an array of the actual changed cell values
                // (e.g. ["12","144.00"]), and the AI-frags + short-num branches
                // below handle those just like scalar diff fragments. The whole-
                // value / phrase-split fallbacks further down are skipped for
                // tables because `val` is a row-object array there (stringifying
                // it gives "[object Object],..." which would mis-match).

                const boxesFromMatch = (r: { tokens: OCRToken[]; confidence: number }) => {
                    if (r.tokens.length === 0) return [];
                    // Trust the matcher. The old size+shape filters were tuned
                    // against false-positive whole-page boxes from a buggy
                    // matcher path that no longer exists. With the current
                    // matcher's densestRow/densestCluster guards, a confident
                    // box from r.tokens is almost always a real hit — even when
                    // it's a tiny Thai vowel (width < 0.003) or a vowel-stacked
                    // line that exceeds 0.15 height. Stop dropping those.
                    const raw = mergeTokenBoxes(r.tokens);
                    // Only reject the one degenerate shape: a near-full-page box
                    // (matcher leak that swallowed the whole page).
                    const sane = raw.filter(b =>
                        b.width > 0 && b.height > 0 && !(b.width > 0.98 && b.height > 0.5),
                    );
                    if (sane.length === 0) return [];
                    // Soft height cap derived from this match's own tokens —
                    // shrinks gracefully so single-line matches always pass
                    // and multi-line over-merges still get the trim.
                    const heights = r.tokens.map(t => t.height).filter(h => h > 0).sort((a, b) => a - b);
                    const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
                    const heightCap = medianH > 0 ? Math.max(0.2, medianH * 6) : 0.2;
                    const trimmed = sane.filter(b => b.height <= heightCap);
                    // Last-resort: every sane box exceeded the cap. Keep the
                    // shortest rather than silently rendering no highlight.
                    const out = trimmed.length > 0
                        ? trimmed
                        : [sane.slice().sort((a, b) => a.height - b.height)[0]];
                    const cap = isTable ? 40 : 6;
                    return out.slice(0, cap).map(b => ({ ...b, confidence: r.confidence }));
                };

                for (let i = 0; i < validFiles.length; i++) {
                    const val = docVals[i];
                    const tokens = allTokens[i];
                    const diffFrags: string[] = Array.isArray(docDiffs[i]) ? docDiffs[i] : [];
                    if (!val || !tokens || tokens.length === 0) {
                        locations[`doc${i + 1}`] = [];
                        matchSummary.push({ doc: i + 1, val, skipped: true, reason: !val ? "no-value" : "no-tokens" });
                        continue;
                    }

                    const counterparts: string[] = [];
                    for (let j = 0; j < validFiles.length; j++) {
                        if (j === i) continue;
                        if (Array.isArray(docDiffs[j])) counterparts.push(...docDiffs[j]);
                        if (docVals[j] != null) counterparts.push(String(docVals[j]));
                    }

                    const usableFrags = diffFrags.filter(s => s && s.trim().length >= 3);
                    let allBoxes: any[] = [];
                    let confSum = 0, confN = 0;
                    const fragDebug: any[] = [];
                    const pushWhy = (src: string, r: { tokens: OCRToken[]; confidence: number; trace?: any }, boxes: any[]) => {
                        const tr = r.trace || {};
                        boxes.forEach((b, n) => whyAll.push({
                            doc: i + 1,
                            for: src.length > 28 ? src.slice(0, 28) + "…" : src,
                            box: `#${n + 1} p${b.page} x=${b.x.toFixed(3)} y=${b.y.toFixed(3)} w=${b.width.toFixed(3)} h=${b.height.toFixed(3)}`,
                            why: tr.path || "?",
                            matched: tr.matchedText ? (tr.matchedText.length > 24 ? tr.matchedText.slice(0, 24) + "…" : tr.matchedText) : undefined,
                            inRow: tr.rowText ? (tr.rowText.length > 40 ? tr.rowText.slice(0, 40) + "…" : tr.rowText) : undefined,
                            conf: +r.confidence.toFixed(3),
                            cov: tr.coverage,
                            droppedYleak: tr.rowDropped || 0,
                            droppedXout: tr.clusterDropped || 0,
                            nearCounter: tr.nearCounter || false,
                            metrics: tr.metrics ? `yTol=${tr.metrics.yTol.toFixed(4)} wordGap=${tr.metrics.wordGap.toFixed(4)} clusterGap=${tr.metrics.clusterGap.toFixed(4)}` : undefined,
                            note: tr.note,
                        }));
                    };

                    if (usableFrags.length > 0) {
                        for (const frag of usableFrags) {
                            const fr = matchValueToTokens(frag, tokens, false, counterparts);
                            if (fr.tokens.length === 0) {
                                fragDebug.push({ frag, matched: 0, confidence: 0, why: fr.trace?.path });
                                continue;
                            }
                            const bx = boxesFromMatch(fr);
                            allBoxes.push(...bx);
                            confSum += fr.confidence; confN++;
                            fragDebug.push({ frag, matched: fr.tokens.length, confidence: +fr.confidence.toFixed(3), why: fr.trace?.path, boxes: bx.length });
                            pushWhy(frag, fr, bx);
                        }
                    }

                    const shortNumFrags = diffFrags.filter(s => {
                        const t = String(s ?? "").trim();
                        return t.length > 0 && t.length <= 2 && /^\d{1,2}$/.test(t);
                    });
                    if (shortNumFrags.length > 0 && allBoxes.length > 0) {
                        const rowBands = allBoxes.map(b => ({ cy: b.y + b.height / 2, h: b.height, page: b.page }));
                        for (const sf of shortNumFrags) {
                            const d = String(sf).trim();
                            let chosen: OCRToken | null = null;
                            let bestDist = Infinity;
                            for (const tk of tokens) {
                                if (/[^\d]/.test(tk.text.trim())) continue;
                                if (tk.text.trim() !== d) continue;
                                for (const rb of rowBands) {
                                    if (rb.page !== tk.page) continue;
                                    const tol = Math.max(rb.h, tk.height) * 1.3;
                                    const dist = Math.abs((tk.y + tk.height / 2) - rb.cy);
                                    if (dist <= tol && dist < bestDist) { bestDist = dist; chosen = tk; }
                                }
                            }
                            if (chosen) {
                                const b = { page: chosen.page, x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height, text: chosen.text, confidence: 0.9 };
                                allBoxes.push(b);
                                pushWhy(d, { tokens: [chosen], confidence: 0.9, trace: { path: "short-cell", matchedText: chosen.text } }, [b]);
                                fragDebug.push({ frag: sf, matched: 1, confidence: 0.9, why: "short-cell", boxes: 1 });
                            } else {
                                fragDebug.push({ frag: sf, matched: 0, confidence: 0, why: "short-cell-miss" });
                            }
                        }
                    }

                    // ─ C2: client-side diff fallback ─
                    // If AI flagged this field as different but gave us no usable
                    // diff_fragments (or its fragments didn't match any tokens), derive
                    // fragments ourselves by diffing this doc's value against every other
                    // doc's value. Highlights anchor on the tokens that are genuinely
                    // unique to this doc.
                    const fieldType = fieldTypeMap[String(field.key || "").trim().toLowerCase()] || "text";
                    if (allBoxes.length === 0 && field.is_diff && fieldType !== "table") {
                        const myVal = String(val);
                        const otherVals: string[] = [];
                        for (let j = 0; j < validFiles.length; j++) {
                            if (j === i || docVals[j] == null) continue;
                            otherVals.push(String(docVals[j]));
                        }
                        if (otherVals.length > 0) {
                            const myFrags = new Set<string>();
                            for (const other of otherVals) {
                                const { aFrags } = wordLevelDiff(myVal, other, w => normalizeFor(w, fieldType));
                                aFrags.forEach(f => myFrags.add(f));
                            }
                            const clientFrags = Array.from(myFrags).filter(s => s.length >= 2);
                            for (const cf of clientFrags) {
                                const cr = matchValueToTokens(cf, tokens, false, counterparts);
                                if (cr.tokens.length === 0) continue;
                                const cb = boxesFromMatch(cr);
                                allBoxes.push(...cb);
                                confSum += cr.confidence; confN++;
                                pushWhy(cf, cr, cb);
                            }
                            if (allBoxes.length > 0) {
                                matchSummary.push({ doc: i + 1, mode: "client-diff", fragments: clientFrags.length, boxes: allBoxes.length });
                            }
                        }
                    }

                    // Last-resort fallback for TABLE fields where the AI-frags
                    // branch produced nothing. Two ways we can land here:
                    //   (a) AI sent docN_diff with short cell values like "10"/"12"
                    //       that the trigram matcher couldn't lock onto.
                    //   (b) AI didn't return docN_diff at all for the table (common
                    //       enough that we can't rely on it), so we derive the diff
                    //       cells ourselves from field.rows via computeRowDiff.
                    // Either way, we scan every token for exact text matches of
                    // each diff cell. Without row context we can't disambiguate
                    // which "10" is the diff one, so we highlight all instances
                    // up to a cap — over-highlighting beats no highlight.
                    if (isTable && allBoxes.length === 0 && field.rows) {
                        // Build the list of cell values to look for. Prefer
                        // AI-provided diff frags when they exist; otherwise
                        // derive from row diff.
                        const cellsToHighlight: string[] = [...diffFrags];
                        const derivedFromRows = cellsToHighlight.length === 0;
                        if (derivedFromRows) {
                            try {
                                const rowDiffs = computeRowDiff({
                                    rows: {
                                        doc1: field.rows.doc1 || [],
                                        doc2: field.rows.doc2 || [],
                                        doc3: field.rows.doc3,
                                    },
                                    matchKey: field.match_key,
                                    mode: verdictMode,
                                });
                                const docKey = `doc${i + 1}` as "doc1" | "doc2" | "doc3";
                                const otherDocKeys = (["doc1", "doc2", "doc3"] as const).filter(k => k !== docKey);
                                for (const rd of rowDiffs) {
                                    if (rd.status !== "diff" || !rd.diff_columns) continue;
                                    const cells = rd.cells[docKey];
                                    if (!cells) continue;
                                    for (const col of rd.diff_columns) {
                                        const myV = cells[col];
                                        if (myV == null || !String(myV).trim()) continue;
                                        const myStr = String(myV).trim();

                                        // Word-level diff against the other docs' cell so we highlight
                                        // ONLY the part that actually changed — e.g. for
                                        //   "Wireless Mouse Logitech M330" vs "Wireless Mouse Logitech M330s"
                                        // we want to flag "M330" / "M330s", not the entire phrase.
                                        const otherVals: string[] = [];
                                        for (const dk of otherDocKeys) {
                                            const ov = rd.cells[dk]?.[col];
                                            if (ov != null && String(ov).trim()) otherVals.push(String(ov).trim());
                                        }
                                        const wordFrags = new Set<string>();
                                        for (const other of otherVals) {
                                            const { aFrags } = wordLevelDiff(myStr, other, w => w.toLowerCase());
                                            for (const f of aFrags) {
                                                const t = f.trim();
                                                if (t) wordFrags.add(t);
                                            }
                                        }
                                        if (wordFrags.size > 0) {
                                            wordFrags.forEach(f => cellsToHighlight.push(f));
                                        } else {
                                            // Either no other-doc cell to diff against (missing/orphan
                                            // row) or the diff produced nothing useful — fall back to
                                            // the full cell value.
                                            cellsToHighlight.push(myStr);
                                        }
                                    }
                                }
                            } catch { /* row diff failed — fall back to empty */ }
                        }

                        const PER_FRAG_CAP = 8;
                        const norm = (s: string) => s.toLowerCase().replace(/[,\s_]/g, "");
                        const seenBoxes = new Set<string>();
                        const markSeen = (box: { page: number; x: number; y: number }) =>
                            seenBoxes.add(`${box.page}:${box.x.toFixed(4)}:${box.y.toFixed(4)}`);
                        const isSeen = (box: { page: number; x: number; y: number }) =>
                            seenBoxes.has(`${box.page}:${box.x.toFixed(4)}:${box.y.toFixed(4)}`);

                        for (const frag of cellsToHighlight) {
                            const target = String(frag ?? "").trim();
                            if (!target) continue;
                            const nt = norm(target);
                            if (nt.length === 0) continue;
                            const scanPath = derivedFromRows ? "row-derived-scan" : "table-scan";

                            // Pass 1: exact normalized text match against single
                            // tokens. Fast and precise for cleanly-tokenized OCR.
                            let added = 0;
                            for (const tk of tokens) {
                                if (norm(tk.text ?? "") !== nt) continue;
                                if (isSeen(tk)) continue;
                                markSeen(tk);
                                allBoxes.push({
                                    page: tk.page, x: tk.x, y: tk.y,
                                    width: tk.width, height: tk.height,
                                    text: tk.text, confidence: 0.6,
                                });
                                added++;
                                if (added >= PER_FRAG_CAP) break;
                            }

                            // Pass 2: if no exact match, hand the frag to the full
                            // matcher — it assembles row text from adjacent tokens
                            // so values that the OCR split (e.g. "M330" tokenised
                            // as "M" + "330") still get a hit.
                            if (added === 0) {
                                const fr = matchValueToTokens(target, tokens, false, counterparts);
                                if (fr.tokens.length > 0) {
                                    const fbBoxes = boxesFromMatch(fr);
                                    for (const b of fbBoxes) {
                                        if (isSeen(b)) continue;
                                        markSeen(b);
                                        allBoxes.push(b);
                                        added++;
                                        if (added >= PER_FRAG_CAP) break;
                                    }
                                    if (added > 0) {
                                        pushWhy(target, fr, allBoxes.slice(-added));
                                    }
                                }
                            } else {
                                pushWhy(target, {
                                    tokens: [], confidence: 0.6,
                                    trace: { path: scanPath, matchedText: target },
                                }, allBoxes.slice(-added));
                            }
                        }
                        matchSummary.push({
                            doc: i + 1,
                            mode: derivedFromRows ? "row-derived-scan" : "table-scan",
                            frags: cellsToHighlight.length,
                            boxes: allBoxes.length,
                        });
                    }

                    if (allBoxes.length === 0 && !isTable) {
                        // Whole-value + phrase-split fallbacks only apply to scalar
                        // fields. For tables, `val` is an array of row objects —
                        // String(val) is meaningless and would mis-match. If the
                        // AI-frags + short-num branches above didn't produce boxes
                        // for a table, we accept "no highlight" rather than guess.
                        const stripLabel = (raw: string, key: string): string => {
                            const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "");
                            const nk = norm(key);
                            if (nk.length < 2) return raw;
                            let acc = "";
                            for (let p = 0; p < raw.length; p++) {
                                acc += norm(raw[p]);
                                if (acc.length >= nk.length) {
                                    if (acc === nk) {
                                        return raw.slice(p + 1).replace(/^[\s:：\-–—.)\]]+/, "").trim() || raw;
                                    }
                                    break;
                                }
                            }
                            return raw;
                        };
                        const cleanedVal = stripLabel(String(val), String(field.key || ""));
                        const r = matchValueToTokens(cleanedVal, tokens, isTable, counterparts);
                        allBoxes = boxesFromMatch(r);
                        confSum = r.confidence; confN = 1;
                        pushWhy(cleanedVal, r, allBoxes);
                        matchSummary.push({ doc: i + 1, mode: "whole-value", val, cleanedVal, matched: r.tokens.length, confidence: +r.confidence.toFixed(3), boxes: allBoxes.length, why: r.trace?.path, note: r.trace?.note });

                        // ─ B1: phrase-split fallback ─
                        // Long multi-line values (full addresses, paragraph remarks) rarely
                        // exist as a single contiguous token run. Break the cleaned value
                        // into phrases at line / comma / 2-space boundaries and match each
                        // piece independently, then aggregate the boxes.
                        if (allBoxes.length === 0 && !isTable) {
                            const phrases = splitIntoPhrases(cleanedVal);
                            for (const phrase of phrases) {
                                const pr = matchValueToTokens(phrase, tokens, false, counterparts);
                                if (pr.tokens.length === 0) continue;
                                const pb = boxesFromMatch(pr);
                                allBoxes.push(...pb);
                                confSum += pr.confidence; confN++;
                                pushWhy(phrase, pr, pb);
                            }
                            if (allBoxes.length > 0) {
                                matchSummary.push({ doc: i + 1, mode: "phrase-split", phrases: phrases.length, boxes: allBoxes.length });
                            }
                        }
                    } else {
                        // Only mark "ai-diff" success if we actually got boxes from AI's
                        // fragments — client-diff and phrase-split both push their own
                        // summary entries, so this branch stays AI-only.
                        if (!matchSummary.some(m => m.doc === i + 1 && m.mode === "client-diff")) {
                            matchSummary.push({ doc: i + 1, mode: "ai-diff", frags: usableFrags.length, boxes: allBoxes.length, fragDebug });
                        }
                    }

                    const cap = isTable ? 40 : 8;
                    locations[`doc${i + 1}`] = allBoxes.slice(0, cap);
                }

                if (debugEnabled) {
                    console.groupCollapsed(`[match] "${field.key}" isTable=${isTable}`);
                    console.table(matchSummary);
                    if (whyAll.length > 0) {
                        console.log(`%c[highlight why] ${field.key} — ${whyAll.length} box(es)`, "font-weight:bold");
                        console.table(whyAll);
                    }
                    console.groupEnd();
                }
                return { ...field, locations };
            });

            setResult({ ...aiResult, fields: enrichedFields });
            setAppliedRules(Array.isArray((data as any).rules_applied) ? (data as any).rules_applied : []);
            setIsExpandedView(true);
            // Feed the rolling avg used by T2 (relative spike) trigger.
            // Use the credits the server actually charged when available.
            const charged = typeof (data as any).credits_used === "number"
                ? (data as any).credits_used
                : estimate.credits;
            if (charged > 0) recordCreditUse(charged);
        } catch (err: any) {
            setError(apiError(err?.code || ErrorCode.AI_FAILED, err?.vars, t));
        } finally {
            setLoading(false);
            setProcessStep("");
        }
    };

    const validFilesCount = files.filter(f => f !== null).length;
    const canRun = validFilesCount >= 2 && extractFields.length > 0 && !loading;

    // Credit estimate — live as fields/docs change. Pre-AI estimate ignores
    // table row factor (we don't know rows until AI returns). Receipt panel
    // shows the actual after run via `result.credits_used` (when wired).
    const estimate = estimateCredits({
        operation: "compare",
        fields: extractFields.length,
        numDocs: Math.max(2, validFilesCount),
    });
    const tone = creditTone(estimate.credits);
    const ESTIMATE_COLORS: Record<string, string> = {
        green: "var(--color-success)", amber: "var(--color-warning)", orange: "#f97316", red: "var(--color-danger)",
    };
    const estimateColor = ESTIMATE_COLORS[tone];

    const getHighlightsForDoc = (docIndex: number) => {
        if (!result || !result.fields) return [];
        return result.fields.map(field => {
            const docKey = `doc${docIndex + 1}` as keyof NonNullable<CompareField['locations']>;
            const boxes = field.locations && field.locations[docKey] ? field.locations[docKey] : [];
            // isDiff travels with the highlight group so the per-box renderer
            // can pick green-match vs red-diff colors without re-looking up
            // the field record.
            return { key: field.key, isDiff: !!field.is_diff, boxes };
        }).filter(h => h.boxes && h.boxes.length > 0);
    };

    // ── Templates filter ──
    const filteredTemplates = templates.filter(tpl => tpl.name.toLowerCase().includes(templateSearch.toLowerCase()));
    const systemTemplates = filteredTemplates.filter(tpl => (tpl as any).user_id === "system");
    const myTemplates = filteredTemplates.filter(tpl => (tpl as any).user_id !== "system");
    const bookmarkedTemplates = templates.filter(tpl => bookmarkedIds.includes(tpl.id));

    const diffCount = result?.fields?.filter(f => f.is_diff).length || 0;
    const sameCount = (result?.fields?.length || 0) - diffCount;

    // Per-slot source names for the Excel/CSV export headers. Prefer the
    // original Excel filename (when the slot holds a converted PNG) so users
    // see "SI BK 035FX59349.xlsx" instead of the autogenerated PNG name.
    const exportDocNames = files.map((f, i) => excelOriginals[i]?.name || f?.name || "");

    // ─── Documents grid + result panel (shared between normal + expanded view) ───
    const DocsAndResult = ({ inExpanded }: { inExpanded: boolean }) => (
        <div style={{
            display: "flex", gap: 10, padding: 10,
            flex: 1, minHeight: 0, overflow: "hidden",
        }}>
            {/* Documents grid */}
            <div style={{
                flex: (result && !resultCollapsed) ? "1 1 60%" : "1 1 100%",
                display: "grid",
                gridTemplateColumns: `repeat(${files.length}, 1fr)`,
                gap: 8, minWidth: 0,
            }}>
                {files.map((file, idx) => (
                    <div key={idx} style={{
                        display: "flex", flexDirection: "column", minWidth: 0,
                        background: "var(--color-bg-card)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 10, overflow: "hidden",
                    }}>
                        <div style={{
                            display: "flex", alignItems: "center", gap: 8,
                            padding: "7px 10px", borderBottom: "1px solid var(--color-border)",
                            background: "var(--color-bg-elevated)", flexShrink: 0,
                        }}>
                            <Icon.FileText width={13} height={13} color={ACCENT} />
                            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-2)", textTransform: "uppercase", letterSpacing: 0.8 }}>
                                {t("compare.docLabel", { n: idx + 1 })}
                            </span>
                            <span style={{ fontSize: 11, color: "var(--color-text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                                {file?.name || ""}
                            </span>
                            {file && !converting[idx] && (
                                <div style={{ display: "inline-flex", alignItems: "center", gap: 2, marginRight: 2 }}>
                                    <button
                                        onClick={() => setZoomAt(idx, (zooms[idx] ?? 1) - 0.25)}
                                        disabled={(zooms[idx] ?? 1) <= 0.5}
                                        style={headerZoomBtnStyle((zooms[idx] ?? 1) <= 0.5)}
                                        title="Zoom out"
                                    >−</button>
                                    <button
                                        onClick={() => setZoomAt(idx, 1)}
                                        style={{ ...headerZoomBtnStyle(false), minWidth: 42, fontFamily: "ui-monospace, monospace" }}
                                        title="Reset zoom"
                                    >
                                        {Math.round((zooms[idx] ?? 1) * 100)}%
                                    </button>
                                    <button
                                        onClick={() => setZoomAt(idx, (zooms[idx] ?? 1) + 0.25)}
                                        disabled={(zooms[idx] ?? 1) >= 3}
                                        style={headerZoomBtnStyle((zooms[idx] ?? 1) >= 3)}
                                        title="Zoom in"
                                    >+</button>
                                    <button
                                        onClick={() => triggerSaveSnapshot(idx)}
                                        disabled={savingPane === idx}
                                        style={{
                                            ...headerZoomBtnStyle(savingPane === idx),
                                            marginLeft: 4,
                                            display: "inline-flex", alignItems: "center", gap: 3,
                                        }}
                                        title={t("compare.saveSnapshot")}
                                    >
                                        <Icon.Download width={10} height={10} />
                                        {savingPane === idx ? "..." : "PNG"}
                                    </button>
                                </div>
                            )}
                            <label style={{
                                fontSize: 10, fontWeight: 600, color: "var(--color-info)",
                                background: "rgba(59,130,246,0.13)", padding: "2px 7px",
                                borderRadius: 4, cursor: "pointer",
                            }}>
                                {file ? t("compare.replace") : t("compare.browse")}
                                <input type="file" style={{ display: "none" }} accept="image/*,application/pdf,.docx,.xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(e) => handleFileInput(idx, e)} />
                            </label>
                            {idx > 1 && (
                                <button onClick={() => removeFileSlot(idx)}
                                    style={{ background: "transparent", border: "none", color: "var(--color-danger)", fontSize: 10, fontWeight: 600, cursor: "pointer", padding: "2px 5px" }}>
                                    {t("compare.removeDoc")}
                                </button>
                            )}
                        </div>
                        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
                            {converting[idx] ? (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12 }}>
                                    <div style={{ width: 28, height: 28, border: `3px solid ${ACCENT}33`, borderTopColor: ACCENT, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-2)" }}>
                                        {convertingKind[idx] === "docx" ? t("compare.convertingDocx")
                                            : convertingKind[idx] === "xlsx" ? t("compare.convertingExcel")
                                                : t("compare.convertingPdf")}
                                    </span>
                                </div>
                            ) : !file ? (
                                <label
                                    className="cmp-dropzone"
                                    style={{
                                        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                                        height: "100%", gap: 14, cursor: "pointer", padding: 20,
                                        border: `2px dashed var(--color-border-strong)`, margin: 10, borderRadius: 10,
                                        transition: "all 0.3s ease",
                                    }}>
                                    <div
                                        className="cmp-dropzone-icon"
                                        style={{
                                            width: 80, height: 80, borderRadius: 20,
                                            background: `${ACCENT}14`,
                                            border: `2px dashed ${ACCENT}55`,
                                            display: "flex", alignItems: "center", justifyContent: "center",
                                            transition: "transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.3s, border-color 0.3s",
                                        }}>
                                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9" />
                                            <path d="M15 13l-3-3m0 0l-3 3m3-3v12" />
                                        </svg>
                                    </div>
                                    <div style={{ textAlign: "center" }}>
                                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-1)" }}>
                                            {t("compare.docPlaceholder", { n: idx + 1 })}
                                        </div>
                                        <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 4 }}>
                                            {t("compare.docUploadHintWithDocx")}
                                        </div>
                                    </div>
                                    <input type="file" style={{ display: "none" }} accept="image/*,application/pdf,.docx,.xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(e) => handleFileInput(idx, e)} />
                                </label>
                            ) : (
                                <DocumentPreviewWithHighlights
                                    file={files[idx]}
                                    url={previews[idx]}
                                    idx={idx}
                                    highlights={getHighlightsForDoc(idx)}
                                    selectedFieldKey={selectedFieldKey}
                                    showHighlights={highlightsEnabled}
                                    excelOriginal={excelOriginals[idx]}
                                    result={result}
                                    zoom={zooms[idx] ?? 1}
                                    onZoomChange={(z: number) => setZoomAt(idx, z)}
                                    isProcessing={loading}
                                    showOnlyDiff={showOnlyDiff}
                                    highlightStyle={highlightStyle}
                                    onSaveReady={(fn: any) => { saveSnapshotRefs.current.set(idx, fn); }}
                                />
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* Result panel — collapsed: slim strip with expand button. */}
            {result && resultCollapsed && (
                <div style={{
                    flex: "0 0 36px", display: "flex", flexDirection: "column",
                    alignItems: "center", gap: 8, padding: "8px 4px",
                    background: "var(--color-bg-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 10,
                }}>
                    <button
                        onClick={() => setResultCollapsed(false)}
                        title={t("compare.showResultPanel")}
                        style={{
                            ...iconActionStyle(ACCENT),
                            background: `${ACCENT}22`,
                            borderColor: `${ACCENT}55`,
                            padding: "6px 5px",
                        }}
                    >
                        <Icon.ChevronLeft width={12} height={12} />
                    </button>
                    <div style={{
                        writingMode: "vertical-rl", transform: "rotate(180deg)",
                        fontSize: 11, fontWeight: 700, color: "var(--color-text-2)",
                        letterSpacing: 1.2, textTransform: "uppercase",
                        userSelect: "none",
                    }}>
                        {t("compare.resultTitle")} · {t("compare.resultDiffs", { count: diffCount })}
                    </div>
                </div>
            )}
            {result && !resultCollapsed && (
                <div style={{
                    flex: "1 1 40%", minWidth: 320, maxWidth: 480,
                    display: "flex", flexDirection: "column", minHeight: 0,
                    background: "var(--color-bg-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 10, overflow: "hidden",
                }}>
                    <div style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "8px 12px", borderBottom: "1px solid var(--color-border)",
                        flexShrink: 0, flexWrap: "wrap",
                    }}>
                        <Icon.Compare width={14} height={14} color={ACCENT} />
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-1)" }}>
                            {t("compare.resultTitle")}
                        </span>
                        <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 20, background: "rgba(239,68,68,0.15)", color: "var(--color-danger)", fontWeight: 600 }}>
                            {t("compare.resultDiffs", { count: diffCount })}
                        </span>
                        <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 20, background: "rgba(16,185,129,0.13)", color: "var(--color-success)", fontWeight: 600 }}>
                            {t("compare.resultSames", { count: sameCount })}
                        </span>
                        <div style={{ flex: 1 }} />
                        <button onClick={() => exportCompareResult(result, "compare-result", "excel", exportDocNames, verdictMode)}
                            style={iconActionStyle("var(--color-success)")}>
                            <Icon.Download width={11} height={11} /> {t("compare.exportExcel")}
                        </button>
                        <button onClick={() => exportCompareResult(result, "compare-result", "csv", exportDocNames, verdictMode)}
                            style={iconActionStyle("var(--color-info)")}>
                            <Icon.Download width={11} height={11} /> {t("compare.exportCsv")}
                        </button>
                        <button onClick={() => setHighlightsEnabled(v => !v)}
                            title={highlightsEnabled ? t("compare.hideHighlights") : t("compare.showHighlights")}
                            style={{
                                ...iconActionStyle("var(--color-text-2)"),
                                background: highlightsEnabled ? `${ACCENT}22` : "transparent",
                                color: highlightsEnabled ? ACCENT : "var(--color-text-2)",
                                borderColor: highlightsEnabled ? `${ACCENT}55` : "var(--color-border)",
                            }}>
                            <Icon.Eye width={11} height={11} />
                        </button>
                        <button onClick={() => setShowOnlyDiff(v => !v)}
                            title={showOnlyDiff ? t("compare.showAllHighlights") : t("compare.showOnlyDiff")}
                            style={{
                                ...iconActionStyle("var(--color-text-2)"),
                                background: showOnlyDiff ? "rgba(239,68,68,0.18)" : "transparent",
                                color: showOnlyDiff ? "var(--color-danger)" : "var(--color-text-2)",
                                borderColor: showOnlyDiff ? "rgba(239,68,68,0.5)" : "var(--color-border)",
                                fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                            }}>
                            {showOnlyDiff ? t("compare.diffOnlyShort") : t("compare.allShort")}
                        </button>
                        <button onClick={() => setHighlightStyle(s => s === "box" ? "underline" : "box")}
                            title={highlightStyle === "box" ? t("compare.useUnderline") : t("compare.useBox")}
                            style={{
                                ...iconActionStyle("var(--color-text-2)"),
                                fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                            }}>
                            {highlightStyle === "box" ? "▭" : "_"}
                        </button>
                        {/* Phase A-E: Rule browser button — visible only when a
                            template is active so the panel has something to scope. */}
                        {ENABLE_TEMPLATE_RULEBASE && activeTemplateId && (
                            <button
                                onClick={() => setRulesModalOpen(true)}
                                title={t("compare.openRules")}
                                style={{
                                    ...iconActionStyle("var(--color-text-2)"),
                                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                                    display: "inline-flex", alignItems: "center", gap: 3,
                                }}>
                                📋 Rules
                            </button>
                        )}
                        <button onClick={() => setResultCollapsed(true)}
                            title={t("compare.hideResultPanel")}
                            style={iconActionStyle("var(--color-text-2)")}>
                            <Icon.ChevronRight width={11} height={11} />
                        </button>
                        {inExpanded && (
                            <button onClick={() => setIsExpandedView(false)}
                                title={t("compare.closeExpanded")}
                                style={{
                                    ...iconActionStyle("var(--color-danger)"),
                                    background: "rgba(239,68,68,0.18)",
                                    borderColor: "rgba(239,68,68,0.4)",
                                }}>
                                <Icon.X width={11} height={11} />
                            </button>
                        )}
                    </div>

                    <div ref={resultScrollRef} className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: 10 }}>
                        {/* First-time hint: explains why Match fields look hidden.
                            Once dismissed (per localStorage), never shows again. */}
                        {showOnlyDiff && !diffOnlyHintSeen && (
                            <div style={{
                                padding: "10px 12px", marginBottom: 10,
                                borderRadius: 8, border: `1px solid ${ACCENT}55`,
                                background: `${ACCENT}13`, display: "flex",
                                alignItems: "flex-start", gap: 8,
                            }}>
                                <Icon.Eye width={13} height={13} color={ACCENT} style={{ flexShrink: 0, marginTop: 2 }} />
                                <div style={{ flex: 1, fontSize: 11.5, color: "var(--color-text-1)", lineHeight: 1.4 }}>
                                    {t("compare.diffOnlyHint")}
                                </div>
                                <button
                                    onClick={() => {
                                        setDiffOnlyHintSeen(true);
                                        try { localStorage.setItem("compare_diff_only_hint_seen", "1"); } catch {}
                                    }}
                                    style={{
                                        flexShrink: 0, background: "transparent",
                                        border: "none", cursor: "pointer",
                                        color: "var(--color-text-3)", padding: 2,
                                    }}
                                    title={t("common.close")}
                                >
                                    <Icon.X width={11} height={11} />
                                </button>
                            </div>
                        )}
                        {ocrSourceMethods.length > 0 && ocrSourceMethods.some(m => m === "none") && (
                            <div style={{ padding: 10, borderRadius: 8, background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.3)", marginBottom: 10 }}>
                                <p style={{ fontSize: 11.5, fontWeight: 700, color: ACCENT, marginBottom: 4 }}>{t("compare.ocrFailed")}</p>
                                <p style={{ fontSize: 11, color: "var(--color-text-2)" }}>
                                    {ocrSourceMethods.map((m, i) => m === "none" ? t("compare.ocrFailedDetail", { n: i + 1 }) : null).filter(Boolean).join(" · ")}
                                    {" "}{t("compare.ocrFailedNote")}
                                </p>
                            </div>
                        )}
                        {ocrSourceMethods.length > 0 && ocrSourceMethods.some(m => m === "ocr-image" || m === "ocr-pdf-scan") && !ocrSourceMethods.some(m => m === "none") && (
                            <div style={{ padding: 9, borderRadius: 8, background: "rgba(6,182,212,0.10)", border: "1px solid rgba(6,182,212,0.3)", marginBottom: 10 }}>
                                <p style={{ fontSize: 11, color: "var(--color-info)" }}>ℹ️ {t("compare.ocrScanNote")}</p>
                            </div>
                        )}
                        {result.summary && result.summary.length > 0 && (
                            <div style={{ padding: 10, borderRadius: 8, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", marginBottom: 12 }}>
                                <h4 style={{ fontSize: 12, fontWeight: 700, color: "var(--color-info)", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                                    <Icon.AlertCircle width={12} height={12} /> {t("compare.resultSummary")}
                                </h4>
                                <ul style={{ listStyle: "disc", paddingLeft: 18, fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.5 }}>
                                    {result.summary.map((s, i) => (<li key={i}>{s}</li>))}
                                </ul>
                            </div>
                        )}

                        {(!result.fields || result.fields.length === 0) ? (
                            <div style={{ textAlign: "center", padding: 30, color: "var(--color-text-3)" }}>
                                <Icon.CheckCircle width={32} height={32} color="var(--color-success)" />
                                <p style={{ fontSize: 14, fontWeight: 600, marginTop: 8, color: "var(--color-text-1)" }}>{t("compare.resultIdentical")}</p>
                                <p style={{ fontSize: 12, marginTop: 4 }}>{t("compare.resultIdenticalSub")}</p>
                            </div>
                        ) : (
                            result.fields.map((field, i) => {
                                const isSelected = selectedFieldKey === field.key;
                                // All field cards use the same full layout so
                                // matching fields also show full values + the
                                // WRONG button (rules can be created off matches
                                // too, e.g. to lock in an alignment that worked).
                                return (
                                    <div key={field.key || i}
                                        className={FIELD_POP_CLASS}
                                        onClick={() => setSelectedFieldKey(isSelected ? null : field.key)}
                                        style={{
                                            padding: 10, marginBottom: 8, cursor: "pointer",
                                            background: isSelected ? `${ACCENT}13` : "var(--color-bg-elevated)",
                                            border: `1px solid ${isSelected ? `${ACCENT}55` : "var(--color-border)"}`,
                                            borderRadius: 8,
                                            ...fieldPopStyle(i),
                                        }}>
                                        <div style={{
                                            fontSize: 11, fontWeight: 700, color: isSelected ? ACCENT : "var(--color-text-2)",
                                            textTransform: "uppercase", letterSpacing: 0.8,
                                            display: "flex", justifyContent: "space-between", alignItems: "center",
                                            paddingBottom: 6, marginBottom: 6, borderBottom: "1px solid var(--color-border)",
                                        }}>
                                            <span>{field.key}</span>
                                            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                                {/* Warn when AI flagged diff but the matcher couldn't draw any
                                                    highlight boxes — typically a long phrase that doesn't sit
                                                    as a contiguous token run. User still gets the value, but
                                                    no visual anchor on the document. */}
                                                {field.is_diff && !field.rows && (() => {
                                                    const noHighlight = (["doc1", "doc2", "doc3"] as const).every(k => {
                                                        const boxes = field.locations?.[k];
                                                        return !boxes || boxes.length === 0;
                                                    });
                                                    return noHighlight ? (
                                                        <span title={t("compare.noHighlightHint")} style={{ fontSize: 9, background: "rgba(245,158,11,0.18)", color: "#b45309", padding: "2px 6px", borderRadius: 10, fontWeight: 700 }}>
                                                            {t("compare.noHighlight")}
                                                        </span>
                                                    ) : null;
                                                })()}
                                                {isSelected && (
                                                    <span style={{ fontSize: 9, background: `${ACCENT}22`, color: ACCENT, padding: "2px 6px", borderRadius: 10, fontWeight: 700 }}>
                                                        {t("compare.viewingHighlights")}
                                                    </span>
                                                )}
                                                {/* Phase D: badge if any rule applied to this field. */}
                                                {(() => {
                                                    const fired = appliedRules.find(r => r.target && (r.target === field.key || r.target.toLowerCase() === String(field.key).toLowerCase()));
                                                    return fired ? (
                                                        <span
                                                            title={fired.naturalLang}
                                                            style={{
                                                                fontSize: 9, background: "rgba(139,92,246,0.15)",
                                                                color: "#8b5cf6", padding: "2px 6px",
                                                                borderRadius: 10, fontWeight: 700,
                                                                display: "inline-flex", alignItems: "center", gap: 3,
                                                            }}
                                                        >💡 RULE</span>
                                                    ) : null;
                                                })()}
                                                {/* Phase B mark-wrong trigger. Requires an active template
                                                    (rules are template-scoped per D1) and the rulebase flag. */}
                                                {ENABLE_TEMPLATE_RULEBASE && activeTemplateId && (
                                                    <button
                                                        onClick={(ev) => {
                                                            ev.stopPropagation();
                                                            setCorrectionTarget({
                                                                fieldKey: field.key,
                                                                fieldLabel: field.key,
                                                                currentValue: field.doc1 ?? field.doc2 ?? "",
                                                                paneIdx: 0,
                                                            });
                                                        }}
                                                        title={t("correction.title")}
                                                        style={{
                                                            background: "transparent",
                                                            border: "1px solid var(--color-border)",
                                                            color: "var(--color-warning)",
                                                            fontSize: 9, fontWeight: 700,
                                                            padding: "2px 6px", borderRadius: 10,
                                                            cursor: "pointer", display: "inline-flex",
                                                            alignItems: "center", gap: 3,
                                                        }}
                                                    >
                                                        <Icon.X width={9} height={9} />
                                                        WRONG
                                                    </button>
                                                )}
                                            </span>
                                        </div>
                                        {field.rows ? (
                                            <TableDiffPanel field={field} t={t} hasDoc3={files.length === 3} verdictMode={verdictMode} />
                                        ) : (
                                            <>
                                                {(() => {
                                                    // Pre-compute prefix/suffix split so each DocRow can
                                                    // highlight just its differing slice. Only when the
                                                    // field is flagged as a diff — match fields shouldn't
                                                    // get the highlight at all.
                                                    const parts = field.is_diff
                                                        ? computeDocDiffParts(files.length === 3 ? [field.doc1, field.doc2, (field as any).doc3] : [field.doc1, field.doc2])
                                                        : null;
                                                    return (
                                                        <>
                                                            <DocRow label={t("compare.docLabel", { n: 1 })} value={field.doc1} color="var(--color-danger)" t={t} confidence={field.doc1_confidence} diffParts={parts?.[0] ?? null} />
                                                            <DocRow label={t("compare.docLabel", { n: 2 })} value={field.doc2} color="var(--color-success)" t={t} confidence={field.doc2_confidence} diffParts={parts?.[1] ?? null} />
                                                            {files.length === 3 && (
                                                                <DocRow label={t("compare.docLabel", { n: 3 })} value={field.doc3} color={ACCENT} t={t} confidence={field.doc3_confidence} diffParts={parts?.[2] ?? null} />
                                                            )}
                                                        </>
                                                    );
                                                })()}
                                                {/* Difference summary — shows ONLY the fragment(s) that
                                                    actually differ between the documents, so the user
                                                    doesn't have to spot the change manually. Uses AI's
                                                    docN_diff when available, otherwise derives via a
                                                    cheap prefix/suffix trim so the user always gets a
                                                    DIFF row when a field is flagged as different. */}
                                                {(() => {
                                                    if (!field.is_diff) return null;
                                                    const aiD1 = field.doc1_diff?.length ? field.doc1_diff.join(" / ") : null;
                                                    const aiD2 = field.doc2_diff?.length ? field.doc2_diff.join(" / ") : null;
                                                    const aiD3 = (field as any).doc3_diff?.length ? (field as any).doc3_diff.join(" / ") : null;
                                                    let d1 = aiD1, d2 = aiD2, d3 = aiD3;
                                                    // Fallback: cheap char-level diff (common prefix +
                                                    // common suffix trimmed). Good enough for typos,
                                                    // trailing chars, short substring changes.
                                                    if (!aiD1 && !aiD2 && field.doc1 != null && field.doc2 != null) {
                                                        const a = String(field.doc1), b = String(field.doc2);
                                                        if (a !== b) {
                                                            let s = 0;
                                                            while (s < a.length && s < b.length && a[s] === b[s]) s++;
                                                            let eA = a.length - 1, eB = b.length - 1;
                                                            while (eA >= s && eB >= s && a[eA] === b[eB]) { eA--; eB--; }
                                                            d1 = a.substring(s, eA + 1).trim() || null;
                                                            d2 = b.substring(s, eB + 1).trim() || null;
                                                        }
                                                    }
                                                    if (files.length === 3 && !aiD3 && field.doc1 != null && (field as any).doc3 != null) {
                                                        const a = String(field.doc1), c = String((field as any).doc3);
                                                        if (a !== c) {
                                                            let s = 0;
                                                            while (s < a.length && s < c.length && a[s] === c[s]) s++;
                                                            let eA = a.length - 1, eC = c.length - 1;
                                                            while (eA >= s && eC >= s && a[eA] === c[eC]) { eA--; eC--; }
                                                            d3 = c.substring(s, eC + 1).trim() || null;
                                                        }
                                                    }
                                                    if (!d1 && !d2 && !d3) return null;
                                                    return (
                                                        <div style={{
                                                            marginTop: 6, paddingTop: 6,
                                                            borderTop: "1px dashed var(--color-border-strong)",
                                                            display: "flex", flexWrap: "wrap", alignItems: "baseline",
                                                            gap: 6, fontSize: 11.5,
                                                        }}>
                                                            <span style={{
                                                                fontSize: 9.5, fontWeight: 700,
                                                                letterSpacing: 0.8, textTransform: "uppercase",
                                                                color: "var(--color-text-3)",
                                                            }}>
                                                                {t("compare.differenceLabel")}
                                                            </span>
                                                            <span style={{ color: "var(--color-danger)", fontWeight: 600, whiteSpace: "pre" }}>
                                                                {d1 ? `"${d1}"` : `(${t("compare.diffMissing")})`}
                                                            </span>
                                                            <span style={{ color: "var(--color-text-4)" }}>:</span>
                                                            <span style={{ color: "var(--color-success)", fontWeight: 600, whiteSpace: "pre" }}>
                                                                {d2 ? `"${d2}"` : `(${t("compare.diffMissing")})`}
                                                            </span>
                                                            {files.length === 3 && (
                                                                <>
                                                                    <span style={{ color: "var(--color-text-4)" }}>:</span>
                                                                    <span style={{ color: ACCENT, fontWeight: 600, whiteSpace: "pre" }}>
                                                                        {d3 ? `"${d3}"` : `(${t("compare.diffMissing")})`}
                                                                    </span>
                                                                </>
                                                            )}
                                                        </div>
                                                    );
                                                })()}
                                            </>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );

    // ─── RENDER ─────────────────────────────────────────────
    const showExpanded = Boolean(result) && isExpandedView;

    return (
        <>
            {/* Hover styles for template items + chips (reuses OCR classes from globals) */}
            <style>{`
                .ocr-template-item { transition: background 0.15s, color 0.15s, transform 0.15s, padding-left 0.15s; position: relative; }
                .ocr-template-item:hover { background: rgba(255, 255, 255, 0.04); color: var(--color-text-1) !important; padding-left: 14px !important; }
                .ocr-template-item:hover::before, .ocr-template-item.is-active::before {
                    content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px;
                    background: var(--ocr-template-accent, ${ACCENT}); border-radius: 0 2px 2px 0;
                }
                .compare-chip { transition: background 0.15s, border-color 0.15s, transform 0.15s, box-shadow 0.15s; }
                .compare-chip:hover {
                    background: color-mix(in srgb, var(--chip-color) 28%, transparent);
                    border-color: var(--chip-color);
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px color-mix(in srgb, var(--chip-color) 20%, transparent);
                }
                @keyframes spin { to { transform: rotate(360deg); } }
                .cmp-dropzone:hover { border-color: ${ACCENT}88; background: ${ACCENT}08; }
                .cmp-dropzone:hover .cmp-dropzone-icon {
                    transform: scale(1.1) rotate(3deg);
                    background: ${ACCENT}22;
                    border-color: ${ACCENT};
                }
            `}</style>

            <div style={{
                display: "flex",
                height: "calc(100vh - 92px)",
                overflow: "hidden",
                background: "var(--color-bg-body)",
                color: "var(--color-text-1)",
                borderRadius: 10,
                border: "1px solid var(--color-border)",
            }}>
                {/* ─ Template rail ─ */}
                {templateRailOpen ? (
                    <div style={{
                        width: 220, minWidth: 220, background: "var(--color-bg-panel)",
                        borderRight: "1px solid var(--color-border)",
                        display: "flex", flexDirection: "column", overflow: "hidden",
                    }}>
                        <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--color-border)" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--color-text-3)" }}>
                                    {t("ocr.templates")}
                                </span>
                                <button onClick={() => setTemplateRailOpen(false)} title={t("ocr.closeTemplates")}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-3)", padding: 2 }}>
                                    <Icon.ChevronLeft width={14} height={14} />
                                </button>
                            </div>
                            <div style={{ position: "relative" }}>
                                <span style={{ position: "absolute", left: 9, top: 8, color: "var(--color-text-3)", pointerEvents: "none" }}>
                                    <Icon.Search width={13} height={13} />
                                </span>
                                <input value={templateSearch} onChange={e => setTemplateSearch(e.target.value)}
                                    placeholder={t("ocr.templatesSearch")}
                                    style={{
                                        width: "100%", padding: "7px 8px 7px 28px",
                                        background: "var(--color-bg-elevated)",
                                        border: "1px solid var(--color-border)",
                                        borderRadius: 7, color: "var(--color-text-1)",
                                        fontSize: 12, outline: "none", boxSizing: "border-box",
                                    }} />
                            </div>
                        </div>
                        <div className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: 8 }}>
                            {bookmarkedTemplates.length > 0 && (
                                <TemplateGroup title={t("ocr.templateSectionFavorites")} items={bookmarkedTemplates}
                                    activeId={activeTemplateId} onPick={applyTemplate} onBookmark={toggleBookmark}
                                    bookmarkedIds={bookmarkedIds} accent="#f59e0b"
                                    defaultId={defaultTemplateId} onSetDefault={setAsDefault}
                                    pinLabel={t("ocr.templateSetDefault")} pinnedLabel={t("ocr.templateDefault")} />
                            )}
                            {systemTemplates.length > 0 && (
                                <TemplateGroup title={t("ocr.templateSectionStandard")} items={systemTemplates}
                                    activeId={activeTemplateId} onPick={applyTemplate} onBookmark={toggleBookmark}
                                    bookmarkedIds={bookmarkedIds} accent={ACCENT}
                                    defaultId={defaultTemplateId} onSetDefault={setAsDefault}
                                    pinLabel={t("ocr.templateSetDefault")} pinnedLabel={t("ocr.templateDefault")} />
                            )}
                            {myTemplates.length > 0 && (
                                <TemplateGroup title={t("ocr.templateSectionMine")} items={myTemplates}
                                    activeId={activeTemplateId} onPick={applyTemplate} onBookmark={toggleBookmark}
                                    bookmarkedIds={bookmarkedIds} accent={ACCENT} onDelete={deleteTemplate}
                                    defaultId={defaultTemplateId} onSetDefault={setAsDefault}
                                    pinLabel={t("ocr.templateSetDefault")} pinnedLabel={t("ocr.templateDefault")} />
                            )}
                            {filteredTemplates.length === 0 && (
                                <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-3)", fontSize: 11.5 }}>
                                    {t("ocr.templatesEmpty")}
                                </div>
                            )}
                        </div>
                        <div style={{ padding: "10px 8px", borderTop: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 6 }}>
                            <input value={templateName} onChange={e => setTemplateName(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && saveTemplate()}
                                placeholder={t("ocr.templateName")}
                                style={{
                                    width: "100%", padding: "7px 9px",
                                    background: "var(--color-bg-elevated)", border: "1px solid var(--color-border)",
                                    borderRadius: 7, color: "var(--color-text-1)", fontSize: 12, outline: "none", boxSizing: "border-box",
                                }} />
                            <button onClick={() => saveTemplate()} disabled={savingTemplate || !templateName.trim()}
                                style={{
                                    width: "100%", padding: 8, borderRadius: 7,
                                    border: `1px dashed ${ACCENT}66`, background: "transparent", color: ACCENT,
                                    fontSize: 12, fontWeight: 600,
                                    cursor: savingTemplate || !templateName.trim() ? "not-allowed" : "pointer",
                                    opacity: savingTemplate || !templateName.trim() ? 0.5 : 1,
                                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                }}>
                                <Icon.Plus width={13} height={13} />
                                {savingTemplate ? t("common.processing") : t("ocr.templatesNew")}
                            </button>
                            {activeTemplateId && (
                                <button onClick={() => saveTemplate(activeTemplateId)} disabled={savingTemplate}
                                    title={templates.find(tpl => tpl.id === activeTemplateId)?.name || ""}
                                    style={{
                                        width: "100%", padding: 8, borderRadius: 7,
                                        border: `1px solid ${ACCENT}88`, background: `${ACCENT}14`, color: ACCENT,
                                        fontSize: 12, fontWeight: 600,
                                        cursor: savingTemplate ? "not-allowed" : "pointer",
                                        opacity: savingTemplate ? 0.5 : 1,
                                        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                    }}>
                                    <Icon.RefreshCw width={12} height={12} />
                                    {t("ocr.templatesOverwrite")}
                                </button>
                            )}
                        </div>
                    </div>
                ) : (
                    <div style={{
                        width: 48, minWidth: 48, background: "var(--color-bg-panel)",
                        borderRight: "1px solid var(--color-border)",
                        display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 0", gap: 8,
                    }}>
                        <button onClick={() => setTemplateRailOpen(true)} title={t("ocr.openTemplates")}
                            style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", padding: 6 }}>
                            <Icon.Layers width={18} height={18} />
                        </button>
                        <div style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", fontSize: 9, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: "var(--color-text-3)", padding: "8px 0" }}>
                            {t("ocr.templates")}
                        </div>
                        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, paddingTop: 6, overflowY: "auto" }}>
                            {bookmarkedTemplates.slice(0, 10).map(tpl => (
                                <button key={tpl.id} onClick={() => { applyTemplate(tpl); setTemplateRailOpen(true); }} title={tpl.name}
                                    style={{
                                        width: 8, height: 8, borderRadius: "50%",
                                        background: activeTemplateId === tpl.id ? ACCENT : "#f59e0b",
                                        border: "none", cursor: "pointer", padding: 0,
                                    }} />
                            ))}
                        </div>
                        <button onClick={() => setTemplateRailOpen(true)} title={t("ocr.templatesNew")}
                            style={{ background: `${ACCENT}22`, border: `1px dashed ${ACCENT}55`, color: ACCENT, cursor: "pointer", padding: 6, borderRadius: 6 }}>
                            <Icon.Plus width={13} height={13} />
                        </button>
                    </div>
                )}

                {/* ─ Main column ─ */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
                    {/* Fields chip row */}
                    <div style={{
                        padding: "10px 16px",
                        borderBottom: "1px solid var(--color-border)",
                        flexShrink: 0, background: "var(--color-bg-surface)",
                    }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--color-text-3)" }}>
                                {t("compare.fieldsLabel")}
                            </span>
                            <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                                {t("compare.fieldsActiveCount", { count: extractFields.length })}
                            </span>
                            {extractFields.length > 0 && validFilesCount >= 2 && (
                                <span
                                    title={estimate.steps.map(s => `${s.label}: ${s.value}`).join("\n")}
                                    style={{
                                        fontSize: 11, fontWeight: 600,
                                        color: estimateColor,
                                        background: `color-mix(in srgb, ${estimateColor} 14%, transparent)`,
                                        border: `1px solid color-mix(in srgb, ${estimateColor} 40%, transparent)`,
                                        padding: "2px 7px", borderRadius: 10,
                                    }}
                                >
                                    {t("credits.estimate", { n: estimate.credits })}
                                </span>
                            )}
                            {extractFields.length > 0 && (
                                <button onClick={() => setExtractFields([])}
                                    style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--color-danger)", fontSize: 11, cursor: "pointer" }}>
                                    {t("compare.fieldClearAll")}
                                </button>
                            )}
                            <div style={{ flex: 1 }} />
                            {/* Run + extra controls */}
                            {files.length < 3 && !showExpanded && (
                                <button onClick={addFileSlot}
                                    style={{
                                        background: "transparent",
                                        border: `1px dashed var(--color-border-strong)`,
                                        color: "var(--color-text-2)", borderRadius: 6,
                                        padding: "5px 10px", fontSize: 11.5, cursor: "pointer",
                                        display: "inline-flex", alignItems: "center", gap: 5,
                                    }}>
                                    <Icon.Plus width={11} height={11} /> {t("compare.addThirdDoc")}
                                </button>
                            )}
                            {result && !showExpanded && (
                                <button onClick={() => setIsExpandedView(true)}
                                    title={t("compare.expandView")}
                                    style={{
                                        background: "var(--color-bg-elevated)",
                                        border: "1px solid var(--color-border)",
                                        color: "var(--color-text-2)", borderRadius: 6,
                                        padding: "5px 10px", fontSize: 11.5, cursor: "pointer",
                                        display: "inline-flex", alignItems: "center", gap: 5,
                                    }}>
                                    <Icon.Layers width={11} height={11} /> {t("compare.expandView")}
                                </button>
                            )}
                            {/* Verdict-mode segmented control. Two-state inline pill — sits
                                next to the Run button so the user picks intent before submitting. */}
                            <div
                                role="radiogroup"
                                aria-label={t("compare.verdictMode.tooltip")}
                                title={t("compare.verdictMode.tooltip")}
                                style={{
                                    display: "inline-flex",
                                    padding: 3,
                                    background: "var(--color-bg-elevated)",
                                    border: "1px solid var(--color-border)",
                                    borderRadius: 8,
                                    gap: 2,
                                    opacity: loading ? 0.55 : 1,
                                    pointerEvents: loading ? "none" : "auto",
                                    transition: "opacity 0.15s",
                                }}
                            >
                                {(["smart", "strict"] as const).map((m) => {
                                    const active = verdictMode === m;
                                    const icon = m === "smart"
                                        ? <Icon.Sliders width={12} height={12} />
                                        : <Icon.Shield width={12} height={12} />;
                                    const accent = m === "smart" ? "#6366f1" : "#f59e0b";
                                    return (
                                        <button
                                            key={m}
                                            type="button"
                                            role="radio"
                                            aria-checked={active}
                                            onClick={() => setVerdictMode(m)}
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: 5,
                                                padding: "5px 11px",
                                                borderRadius: 6,
                                                border: "none",
                                                background: active ? accent : "transparent",
                                                color: active ? "#fff" : "var(--color-text-3)",
                                                fontSize: 11.5,
                                                fontWeight: 700,
                                                letterSpacing: 0.2,
                                                cursor: "pointer",
                                                transition: "background 0.15s, color 0.15s, box-shadow 0.15s",
                                                boxShadow: active ? `0 1px 4px ${accent}55` : "none",
                                            }}
                                        >
                                            {icon}
                                            {t(`compare.verdictMode.${m}`)}
                                        </button>
                                    );
                                })}
                            </div>
                            <button onClick={tryRunCompare} disabled={!canRun}
                                style={{
                                    background: canRun ? ACCENT : "var(--color-bg-elevated)",
                                    color: canRun ? "#000" : "var(--color-text-3)",
                                    border: "none", borderRadius: 7,
                                    padding: "6px 16px", fontSize: 12.5, fontWeight: 700,
                                    cursor: canRun ? "pointer" : "not-allowed",
                                    display: "inline-flex", alignItems: "center", gap: 6,
                                }}>
                                {loading ? (
                                    <>
                                        <div style={{ width: 12, height: 12, border: "2px solid rgba(0,0,0,0.3)", borderTopColor: "currentColor", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                                        {processStep || t("compare.running")}
                                    </>
                                ) : (
                                    <><Icon.Zap width={13} height={13} /> {t("compare.runComparison")} · {estimate.credits} {t("credits.label")}</>
                                )}
                            </button>
                        </div>
                        <div className="custom-scrollbar" style={{
                            display: "flex", flexWrap: "wrap", gap: 6,
                            minHeight: 32, maxHeight: 100,
                            overflowY: "auto", alignContent: "flex-start", paddingRight: 4,
                        }}>
                            {extractFields.map(f => {
                                const c = TYPE_COLOR[f.type] || ACCENT;
                                const isDragging = draggingFieldId === f.id;
                                const isDropTarget = dropTargetFieldId === f.id && draggingFieldId && draggingFieldId !== f.id;
                                return (
                                    <button key={f.id} className="compare-chip"
                                        draggable
                                        onDragStart={(e) => {
                                            setDraggingFieldId(f.id);
                                            e.dataTransfer.effectAllowed = "move";
                                            e.dataTransfer.setData("text/plain", f.id);
                                        }}
                                        onDragEnter={() => setDropTargetFieldId(f.id)}
                                        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            if (draggingFieldId) reorderField(draggingFieldId, f.id);
                                            setDraggingFieldId(null);
                                            setDropTargetFieldId(null);
                                        }}
                                        onDragEnd={() => { setDraggingFieldId(null); setDropTargetFieldId(null); }}
                                        onClick={() => setExtractFields(prev => prev.filter(x => x.id !== f.id))}
                                        style={{
                                            display: "inline-flex", alignItems: "center", gap: 5,
                                            padding: "5px 10px", borderRadius: 6,
                                            cursor: isDragging ? "grabbing" : "grab",
                                            border: `1px solid ${isDropTarget ? c : `${c}55`}`,
                                            background: `${c}18`,
                                            color: c, fontSize: 12.5, fontWeight: 600,
                                            opacity: isDragging ? 0.35 : 1,
                                            boxShadow: isDropTarget ? `0 0 0 2px ${c}66` : "none",
                                            transition: "background 0.15s, border-color 0.15s, opacity 0.15s, box-shadow 0.15s",
                                            ["--chip-color" as any]: c,
                                        }} title="Click to remove · Drag to reorder">
                                        <span style={{ fontSize: 9, opacity: 0.8, textTransform: "uppercase" }}>{TYPE_LABEL[f.type] || f.type}</span>
                                        {f.name}
                                        <Icon.X width={10} height={10} />
                                    </button>
                                );
                            })}
                            {extractFields.length === 0 && (
                                <span style={{ fontSize: 11.5, color: "var(--color-text-3)", fontStyle: "italic", padding: "5px 0" }}>
                                    {t("compare.fieldEmptyHint")}
                                </span>
                            )}
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
                            <input value={newFieldName} onChange={e => setNewFieldName(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && addField()}
                                placeholder={t("compare.fieldNew")}
                                style={{
                                    flex: 1, padding: "6px 10px",
                                    background: "var(--color-bg-elevated)", border: "1px solid var(--color-border)",
                                    borderRadius: 6, color: "var(--color-text-1)", fontSize: 12.5, outline: "none", minWidth: 0,
                                }} />
                            <div style={{ position: "relative" }}>
                                <button onClick={() => setIsTypeDropdownOpen(o => !o)}
                                    style={{
                                        padding: "6px 10px",
                                        background: `${TYPE_COLOR[newFieldType]}18`,
                                        border: `1px solid ${TYPE_COLOR[newFieldType]}55`,
                                        color: TYPE_COLOR[newFieldType], borderRadius: 6,
                                        fontSize: 11, fontWeight: 600, cursor: "pointer", textTransform: "uppercase",
                                        display: "inline-flex", alignItems: "center", gap: 5, minWidth: 90, justifyContent: "space-between",
                                    }}>
                                    {TYPE_LABEL[newFieldType] || newFieldType} <Icon.ChevronDown width={10} height={10} />
                                </button>
                                {isTypeDropdownOpen && (
                                    <>
                                        <div style={{ position: "fixed", inset: 0, zIndex: 60 }} onClick={() => setIsTypeDropdownOpen(false)} />
                                        <div style={{
                                            position: "absolute", top: "100%", right: 0, marginTop: 4,
                                            background: "var(--color-bg-elevated)", border: "1px solid var(--color-border-strong)",
                                            borderRadius: 8, zIndex: 70, padding: 4, minWidth: 140,
                                            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                                        }}>
                                            {Object.keys(TYPE_COLOR).map(typ => (
                                                <button key={typ}
                                                    onClick={() => { setNewFieldType(typ as ExtractField["type"]); setIsTypeDropdownOpen(false); }}
                                                    style={{
                                                        display: "flex", alignItems: "center", gap: 8,
                                                        padding: "6px 10px", borderRadius: 5, border: "none",
                                                        background: newFieldType === typ ? `${TYPE_COLOR[typ]}22` : "transparent",
                                                        color: TYPE_COLOR[typ], fontSize: 11.5, fontWeight: 600,
                                                        textTransform: "uppercase", cursor: "pointer",
                                                        width: "100%", textAlign: "left",
                                                    }}>
                                                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: TYPE_COLOR[typ] }} />
                                                    {TYPE_LABEL[typ] || typ}
                                                </button>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>
                            <button onClick={addField} title={t("common.add")}
                                style={{
                                    padding: "6px 10px", background: ACCENT, border: "none",
                                    borderRadius: 6, color: "#000", cursor: "pointer",
                                    display: "inline-flex", alignItems: "center", gap: 4,
                                    fontSize: 12, fontWeight: 600,
                                }}>
                                <Icon.Plus width={12} height={12} /> {t("common.add")}
                            </button>
                        </div>
                    </div>

                    {error && (
                        <div style={{ padding: "10px 16px", background: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.25)", color: "var(--color-danger)", fontSize: 12 }}>
                            {error}
                        </div>
                    )}

                    {/* Normal in-flow docs + result */}
                    {!showExpanded && <DocsAndResult inExpanded={false} />}
                </div>
            </div>

            {/* Fullscreen expanded overlay (PRESERVED behavior — auto-shows when result ready) */}
            {showExpanded && (
                <div style={{
                    position: "fixed", inset: 0, zIndex: 100,
                    background: "var(--color-bg-body)",
                    display: "flex", flexDirection: "column",
                    animation: "fadeIn 0.18s ease",
                }}>
                    {/* Slim header */}
                    <div style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "10px 16px",
                        borderBottom: "1px solid var(--color-border)",
                        background: "var(--color-bg-panel)", flexShrink: 0,
                    }}>
                        <div style={{ width: 28, height: 28, borderRadius: 7, background: `${ACCENT}22`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Icon.Compare width={14} height={14} color={ACCENT} />
                        </div>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-1)" }}>
                            {t("compare.title")}
                        </span>
                        <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 20, background: "rgba(239,68,68,0.15)", color: "var(--color-danger)", fontWeight: 600 }}>
                            {t("compare.resultDiffs", { count: diffCount })}
                        </span>
                        <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 20, background: "rgba(16,185,129,0.13)", color: "var(--color-success)", fontWeight: 600 }}>
                            {t("compare.resultSames", { count: sameCount })}
                        </span>
                        <div style={{ flex: 1 }} />
                        <button onClick={() => setIsExpandedView(false)}
                            style={{
                                display: "inline-flex", alignItems: "center", gap: 6,
                                background: "rgba(239,68,68,0.18)", border: "1px solid rgba(239,68,68,0.4)",
                                color: "var(--color-danger)", borderRadius: 7, padding: "6px 12px",
                                fontSize: 12, fontWeight: 600, cursor: "pointer",
                            }}>
                            <Icon.X width={12} height={12} /> {t("compare.closeExpanded")}
                        </button>
                    </div>
                    <DocsAndResult inExpanded={true} />
                </div>
            )}

            {/* Smart credit confirmation dialog */}
            {confirmDialog && (
                <CreditConfirmDialog
                    open
                    credits={estimate.credits}
                    balance={balance}
                    reasons={confirmDialog.reasons}
                    steps={estimate.steps}
                    fingerprint={confirmDialog.fingerprint}
                    userAvg={getUserAvgCredits()}
                    onCancel={() => setConfirmDialog(null)}
                    onConfirm={() => { setConfirmDialog(null); runComparison(); }}
                />
            )}

            <ConfirmDialog
                open={pendingDeleteId !== null}
                title={t("ocr.templateDeleteTitle")}
                message={t("ocr.templateDeleteMsg", { name: pendingDeleteName })}
                confirmLabel={t("common.delete")}
                cancelLabel={t("common.cancel")}
                tone="danger"
                onCancel={() => setPendingDeleteId(null)}
                onConfirm={confirmDelete}
            />

            {/* Phase A-E: Rule browser modal — also as right-side panel so it
                sits above the fullscreen result view and keeps the compare
                visible on the left for reference. */}
            {rulesModalOpen && activeTemplateId && (
                <>
                    <div
                        onClick={() => setRulesModalOpen(false)}
                        style={{
                            position: "fixed", inset: 0, zIndex: 100,
                            background: "rgba(0,0,0,0.25)", cursor: "pointer",
                        }}
                    />
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{
                            position: "fixed", top: 16, right: 16, bottom: 16,
                            width: "min(560px, 92vw)",
                            zIndex: 101,
                            animation: "slide-in-right 0.18s ease-out",
                        }}
                    >
                        <TemplateRulesPanel
                            templateId={activeTemplateId}
                            onClose={() => setRulesModalOpen(false)}
                        />
                    </div>
                </>
            )}

            {/* Phase B: Mark-wrong correction modal */}
            {correctionTarget && activeTemplateId && (
                <CorrectionModal
                    open={true}
                    onClose={() => setCorrectionTarget(null)}
                    templateId={activeTemplateId}
                    fieldKey={correctionTarget.fieldKey}
                    fieldLabel={correctionTarget.fieldLabel}
                    currentValue={correctionTarget.currentValue}
                    paneIdx={correctionTarget.paneIdx}
                    availableFieldKeys={result?.fields?.map(f => f.key) || []}
                    currentResultFields={result?.fields || []}
                />
            )}
        </>
    );
}

// ─── Small helpers ────────────────────────────────────────────────────────
function iconActionStyle(color: string): React.CSSProperties {
    return {
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "5px 9px",
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: 6, color,
        fontSize: 11, fontWeight: 600, cursor: "pointer",
    };
}

function DocRow({ label, value, color, t, confidence, diffParts }: { label: string; value?: string | null; color: string; t: any; confidence?: number; diffParts?: { prefix: string; middle: string; suffix: string } | null }) {
    // When `diffParts` is provided, wrap the middle (differing) segment in a
    // styled mark inline so the user spots the change without having to
    // cross-reference the DIFF row. Falls back to the plain value otherwise.
    const renderValue = () => {
        if (!value) return <em style={{ opacity: 0.5, textDecoration: "line-through", fontStyle: "italic" }}>{t("compare.noValue")}</em>;
        if (!diffParts || !diffParts.middle) return value;
        return (
            <>
                {diffParts.prefix}
                <mark style={{
                    background: `${color}33`,
                    color,
                    padding: "0 3px",
                    borderRadius: 3,
                    border: `1.5px solid ${color}`,
                    fontWeight: 700,
                    whiteSpace: "pre",
                }}>{diffParts.middle}</mark>
                {diffParts.suffix}
            </>
        );
    };
    return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", paddingTop: 5, paddingBottom: 5, borderTop: "1px solid var(--color-border)" }}>
            <span style={{
                flexShrink: 0, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8,
                padding: "2px 6px", borderRadius: 3,
                background: `${color}22`, color,
                minWidth: 40, textAlign: "center",
            }}>
                {label}
            </span>
            <span style={{ fontSize: 12, color, fontWeight: 500, whiteSpace: "pre-line", wordBreak: "break-word", flex: 1 }}>
                {renderValue()}
            </span>
            {typeof confidence === "number" && (
                <ConfidenceBadge value={confidence} />
            )}
        </div>
    );
}

// Cross-doc diff: split each value into common prefix + middle (differing) +
// common suffix, computed across ALL provided values. Used by DocRow above
// to highlight only the differing slice inside the full original string.
function computeDocDiffParts(values: (string | null | undefined)[]): { prefix: string; middle: string; suffix: string }[] {
    const strs = values.map(v => v == null ? "" : String(v));
    if (strs.length === 0 || strs.every(s => s === strs[0])) {
        return strs.map(s => ({ prefix: s, middle: "", suffix: "" }));
    }
    const minLen = Math.min(...strs.map(s => s.length));
    let p = 0;
    while (p < minLen && strs.every(s => s[p] === strs[0][p])) p++;
    let suf = 0;
    while (suf < minLen - p && strs.every(s => s[s.length - 1 - suf] === strs[0][strs[0].length - 1 - suf])) suf++;
    return strs.map(s => ({
        prefix: s.substring(0, p),
        middle: s.substring(p, s.length - suf),
        suffix: s.substring(s.length - suf),
    }));
}

// Compact pill showing AI extraction confidence (0-100). Tone tracks the
// confidence band so users can scan a long field list for low-trust rows.
function ConfidenceBadge({ value }: { value: number }) {
    const tone = value >= 85 ? "emerald" : value >= 65 ? "amber" : "rose";
    const palette: Record<string, { bg: string; fg: string }> = {
        emerald: { bg: "rgba(16,185,129,0.15)", fg: "#059669" },
        amber: { bg: "rgba(245,158,11,0.18)", fg: "#b45309" },
        rose: { bg: "rgba(244,63,94,0.15)", fg: "#be123c" },
    };
    const c = palette[tone];
    return (
        <span
            title={`AI confidence: ${value}%`}
            style={{
                flexShrink: 0, fontSize: 10, fontWeight: 700,
                padding: "2px 6px", borderRadius: 10,
                background: c.bg, color: c.fg,
                fontFamily: "ui-monospace, monospace",
                alignSelf: "flex-start",
            }}
        >
            {value}%
        </span>
    );
}

// ─── Table-field row-by-row diff panel ───────────────────────────────────
// Renders each row across docs with cell-level highlights. Pairs rows via
// computeRowDiff (uses field.match_key when present, falls back to position).
function TableDiffPanel({
    field,
    t,
    hasDoc3,
    verdictMode,
}: {
    field: CompareField;
    t: any;
    hasDoc3: boolean;
    verdictMode: VerdictMode;
}) {
    if (!field.rows) return null;
    const rowDiffs: RowDiff[] = computeRowDiff({
        rows: { doc1: field.rows.doc1 || [], doc2: field.rows.doc2 || [], doc3: field.rows.doc3 },
        matchKey: field.match_key,
        mode: verdictMode,
    });

    // Aggregate columns across all rows for stable header order.
    const cols = new Set<string>();
    for (const rd of rowDiffs) {
        if (rd.cells.doc1) Object.keys(rd.cells.doc1).forEach(k => cols.add(k));
        if (rd.cells.doc2) Object.keys(rd.cells.doc2).forEach(k => cols.add(k));
        if (rd.cells.doc3) Object.keys(rd.cells.doc3).forEach(k => cols.add(k));
    }
    const columns = Array.from(cols);

    const diffCount = rowDiffs.filter(r => r.status === "diff").length;
    const missCount = rowDiffs.filter(r => r.status.startsWith("missing")).length;
    const matchCount = rowDiffs.filter(r => r.status === "match").length;

    // Table confidence — show the worst per-doc value so a single weak side
    // surfaces. Falls back gracefully when AI omits the field.
    const tableConfs = [field.doc1_confidence, field.doc2_confidence, field.doc3_confidence]
        .filter((v): v is number => typeof v === "number");
    const minConf = tableConfs.length ? Math.min(...tableConfs) : undefined;

    return (
        <div style={{ marginTop: 4 }}>
            {/* Header summary chips */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8, fontSize: 10.5, alignItems: "center" }}>
                {field.match_key && (
                    <span style={{ padding: "2px 7px", borderRadius: 4, background: "var(--color-bg-elevated)", color: "var(--color-text-3)", fontFamily: "monospace" }}>
                        match: {field.match_key}
                    </span>
                )}
                <span style={{ padding: "2px 7px", borderRadius: 4, background: "rgba(16,185,129,0.13)", color: "var(--color-success)", fontWeight: 600 }}>
                    {matchCount} ตรง
                </span>
                <span style={{ padding: "2px 7px", borderRadius: 4, background: "rgba(239,68,68,0.13)", color: "var(--color-danger)", fontWeight: 600 }}>
                    {diffCount} ต่าง
                </span>
                {missCount > 0 && (
                    <span style={{ padding: "2px 7px", borderRadius: 4, background: "rgba(245,158,11,0.13)", color: "var(--color-warning)", fontWeight: 600 }}>
                        {missCount} ขาด
                    </span>
                )}
                {typeof minConf === "number" && (
                    <span style={{ marginLeft: "auto" }}>
                        <ConfidenceBadge value={minConf} />
                    </span>
                )}
            </div>

            {/* Side-by-side per row */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }} className="custom-scrollbar">
                {rowDiffs.map(rd => (
                    <RowDiffCard key={rd.key} rd={rd} columns={columns} hasDoc3={hasDoc3} />
                ))}
            </div>
        </div>
    );
}

function RowDiffCard({ rd, columns, hasDoc3 }: { rd: RowDiff; columns: string[]; hasDoc3: boolean }) {
    const statusColor: Record<string, string> = {
        match: "var(--color-success)",
        diff: "var(--color-danger)",
        missing_in_doc1: "var(--color-warning)",
        missing_in_doc2: "var(--color-warning)",
        missing_in_doc3: "var(--color-warning)",
    };
    const statusLabel: Record<string, string> = {
        match: "ตรง",
        diff: "ต่าง",
        missing_in_doc1: "ขาดใน Doc 1",
        missing_in_doc2: "ขาดใน Doc 2",
        missing_in_doc3: "ขาดใน Doc 3",
    };
    const sc = statusColor[rd.status];
    const diffCols = new Set(rd.diff_columns || []);

    const renderCell = (row: Record<string, any> | undefined, col: string) => {
        if (!row) return <span style={{ color: "var(--color-text-4)" }}>—</span>;
        const v = row[col];
        if (v == null || v === "") return <span style={{ color: "var(--color-text-4)" }}>—</span>;
        return <span>{String(v)}</span>;
    };

    return (
        <div style={{
            background: rd.status === "diff" ? "rgba(239,68,68,0.05)"
                : rd.status === "match" ? "var(--color-bg-elevated)"
                : "rgba(245,158,11,0.05)",
            border: `1px solid ${rd.status === "diff" ? "rgba(239,68,68,0.25)" : "var(--color-border)"}`,
            borderRadius: 6, padding: "6px 8px",
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "var(--color-text-3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {rd.key}
                </span>
                <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: `${sc}22`, color: sc, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {statusLabel[rd.status]}
                </span>
            </div>
            <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                    <thead>
                        <tr>
                            <th style={{ padding: "3px 6px", textAlign: "left", color: "var(--color-text-3)", fontSize: 9, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid var(--color-border)" }}>col</th>
                            {[1, 2, ...(hasDoc3 ? [3] : [])].map(n => (
                                <th key={n} style={{ padding: "3px 6px", textAlign: "left", color: "var(--color-text-3)", fontSize: 9, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid var(--color-border)" }}>doc {n}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {columns.map(col => {
                            const isDiffCol = diffCols.has(col);
                            // Per-cell tint: only the changed cells light up red/green,
                            // not the whole column. For match rows nothing tints —
                            // user sees the row contents flat so they can verify.
                            const cellBg = isDiffCol ? "rgba(239,68,68,0.10)" : "transparent";
                            return (
                                <tr key={col} style={{ background: isDiffCol ? "rgba(239,68,68,0.05)" : "transparent" }}>
                                    <td style={{ padding: "3px 6px", color: isDiffCol ? "var(--color-danger)" : "var(--color-text-3)", fontWeight: isDiffCol ? 700 : 500, fontFamily: "monospace", fontSize: 10 }}>{col}</td>
                                    <td style={{ padding: "3px 6px", color: isDiffCol ? "var(--color-danger)" : "var(--color-text-2)", background: cellBg, fontWeight: isDiffCol ? 600 : 400 }}>{renderCell(rd.cells.doc1, col)}</td>
                                    <td style={{ padding: "3px 6px", color: isDiffCol ? "var(--color-success)" : "var(--color-text-2)", background: cellBg, fontWeight: isDiffCol ? 600 : 400 }}>{renderCell(rd.cells.doc2, col)}</td>
                                    {hasDoc3 && (
                                        <td style={{ padding: "3px 6px", color: isDiffCol ? "var(--color-warning)" : "var(--color-text-2)", background: cellBg, fontWeight: isDiffCol ? 600 : 400 }}>{renderCell(rd.cells.doc3, col)}</td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
