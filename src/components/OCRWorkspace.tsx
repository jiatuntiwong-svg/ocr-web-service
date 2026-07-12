"use client";
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { exportOCRResult } from "@/lib/exportUtils";
import { User } from "@/lib/types";
import { Icon } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { apiError } from "@/lib/friendlyError";
import { fetchJson } from "@/lib/fetchJson";
import { ErrorCode } from "@/lib/errorCodes";
import { isExcelFile, type ExcelCellRef } from "@/lib/excel-parser";
import { docxFileToImage } from "@/lib/docx-to-image";
import { pdfFileToImageDetailed, type StackedPageRect, type PdfRasterResult } from "@/lib/pdf-to-image";
import { buildFieldCrops } from "@/lib/field-crops";
import { exportOCRBatch, type BatchResult } from "@/lib/exportUtils";
import {
    MAX_BATCH_FILES,
    OCR_BATCH_CONCURRENCY,
    PER_FILE_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    BATCH_UI_THRESHOLD,
    PAGE_SELECTION_MAX,
} from "@/lib/ocrBatchConfig";
import ExcelPreview from "./ExcelPreview";
import ConfirmDialog from "./ConfirmDialog";
import { estimateCredits, creditTone } from "@/lib/pricing";
import {
    evaluateConfirm,
    makeFingerprint,
    shouldSkipDialog,
    recordCreditUse,
    getUserAvgCredits,
    type ConfirmReason,
} from "@/lib/credit-preferences";
import CreditConfirmDialog from "./CreditConfirmDialog";
import { useApp } from "@/lib/contexts/AppContext";
import type { BatchItem } from "@/lib/types/batch";
import { usePanZoom } from "@/lib/hooks/usePanZoom";
import { ENABLE_OCR_SCAN_LINE, ENABLE_FIELD_POP, ENABLE_LOADING_STORY } from "@/lib/featureFlags";

// Map progress (0..100) to a 5-step mini-story. The bands roughly mirror the
// actual order in the upload flow: file prep → request sent → AI OCR phase →
// AI extraction phase → response packaging. Step state is derived purely from
// `progress` so we don't need backend changes — when /api/upload reports more
// granular phases in the future, just expand this list.
const LOADING_STORY_STEPS = [
    { key: "stepUpload",  endAt: 30  },
    { key: "stepPrepare", endAt: 50  },
    { key: "stepReading", endAt: 70  },
    { key: "stepExtract", endAt: 92  },
    { key: "stepFormat",  endAt: 100 },
] as const;

// ─── Local Types ──────────────────────────────────────────────────────────────
/** Approximate location of a field's value inside the document, expressed as
 *  relative 0-1 rectangle so it survives resize/zoom. Used as a spatial hint
 *  to the AI when the same template is applied to similar-layout documents
 *  (e.g. batch upload of identical forms). Optional — templates without
 *  hints fall back to semantic-only extraction. */
interface FieldBboxHint {
    x: number; y: number; width: number; height: number;
    /** 1-based page for multi-page PDFs; defaults to 1 when omitted. */
    page?: number;
    /** Coordinate space marker (OCR-6c migration). Hints saved before the
     *  iframe→canvas preview swap were measured against the wrapper rect
     *  (portrait 210:297); anything landscape without this marker is
     *  wrapper-space and needs redrawing. New hints always set "page". */
    space?: "page";
}
interface ExtractField {
    id: string;
    name: string;
    type: "text" | "number" | "currency" | "date" | "address" | "email" | "table" | "raw_text";
    bbox_hint?: FieldBboxHint;
}
interface Template { id: string; name: string; fields_json: string; user_id?: string; }
interface OCRResult { [key: string]: any; }

interface Props {
    user: User | null;
    onDocumentProcessed?: () => void;
    onNavigateToBilling?: () => void;
    /** User's current credit balance — drives the T4 low-balance confirm trigger. */
    balance?: number;
}

// Color per field type — drives chip + result row badges.
const TYPE_COLOR: Record<string, string> = {
    text:     "#6366f1",
    number:   "#f59e0b",
    currency: "#10b981",
    date:     "#3b82f6",
    address:  "#8b5cf6",
    email:    "#06b6d4",
    table:    "#ec4899",
    // raw_text = "copy exactly as-seen" — used for ref numbers / mixed labels
    // where field-name semantic prior makes AI drop leading/trailing words.
    raw_text: "#dc2626",
};

// Human-readable labels for the type dropdown/chip. Keys omitted here fall
// back to the type identifier (upper-cased) — most types read the same either
// way, so only the multi-word ones need a mapping.
const TYPE_LABEL: Record<string, string> = {
    raw_text: "RAW TEXT",
};

const ACCENT = "#6366f1"; // OCR zone accent

// ─── Component ────────────────────────────────────────────────────────────────
export default function OCRWorkspace({ user, onDocumentProcessed, onNavigateToBilling, balance = 0 }: Props) {
    const { t } = useTranslation();

    // ─── File & Preview ───
    const [file, setFile] = useState<File | null>(null);
    const [previews, setPreviews] = useState<string[]>([]);
    // .docx files are flattened into a PNG before upload (mammoth → html2canvas);
    // the flag lets us show a "converting…" hint over the drop zone while it
    // happens — large docs can take a couple of seconds.
    const [converting, setConverting] = useState<"docx" | null>(null);
    // Preview zoom (per-document, not persisted). Clamped 0.5x..3x with the
    // same step as Compare's per-slot zoom so the two workspaces feel the same.
    const [zoom, setZoom] = useState(1);
    const setZoomClamped = (next: number) =>
        setZoom(Math.max(0.5, Math.min(3, +next.toFixed(2))));
    // Click-drag pan + Ctrl+wheel zoom + double-click reset + spacebar pan hint.
    const panZoom = usePanZoom({ zoom, setZoom: setZoomClamped });
    const [previewPage, setPreviewPage] = useState(0);
    const dropRef = useRef<HTMLDivElement>(null);
    // OCR-6c: cached pdfjs raster (stacked upload PNG + per-page PNGs + rects).
    // Produced eagerly on PDF file select so the hint-drawing preview shows
    // the SAME pixels the crop path will read — one coordinate space end to
    // end, no wrapper-vs-page-rect mismatch on landscape/letterboxed pages.
    // Reused at upload time so PDFs are rasterised exactly once per file.
    const [pdfRaster, setPdfRaster] = useState<{
        sourceFile: File;
        result: PdfRasterResult;
    } | null>(null);
    // Per-page rendered pixel dimensions (mirrors pageRects width/height) — the
    // preview wrapper sets aspectRatio from this so landscape pages render at
    // their true aspect (no letterbox). Kept as a plain array so the mapping
    // by index is trivial.
    const previewPageAspect = pdfRaster
        ? pdfRaster.result.pageRects.map(pr => `${pr.width} / ${pr.height}`)
        : null;

    // UI-1: page-picker state — 1-based ORIGINAL PDF page numbers the user
    // wants to include in this OCR run. Initialised from `pdfRaster` when a
    // multi-page PDF loads (default = first PAGE_SELECTION_MAX pages, or all
    // pages when the doc is under the cap). Reset whenever the source file
    // changes so a new upload doesn't inherit the previous selection.
    //
    // Empty for non-PDF files and single-page PDFs — those skip the picker
    // and hit the server without `pages`/`total_pages` parts (server treats
    // that as "no selection", identical to today's contract).
    const [selectedPages, setSelectedPages] = useState<number[]>([]);
    // Warn banner + inline cap-hint state (transient — cleared on next select).
    const [pickerHint, setPickerHint] = useState<string | null>(null);
    useEffect(() => {
        if (!pdfRaster) { setSelectedPages([]); return; }
        const total = pdfRaster.result.pagePngs.length;
        if (total <= 1) { setSelectedPages([]); return; }
        // Default = first N pages capped at PAGE_SELECTION_MAX. When
        // total > cap, user must acknowledge which pages to keep.
        const n = Math.min(total, PAGE_SELECTION_MAX);
        setSelectedPages(Array.from({ length: n }, (_, i) => i + 1));
        setPickerHint(null);
    }, [pdfRaster]);

    // ─── Processing ───
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [processingStep, setProcessingStep] = useState("");
    const [result, setResult] = useState<OCRResult | null>(null);
    // Field-key signature at the time `result` was produced. When the current
    // extractFields diverges from this snapshot, the result becomes stale
    // (contains ghosts of removed fields or lacks newly added ones) and gets
    // cleared automatically — see effect below.
    const [resultFieldsSig, setResultFieldsSig] = useState<string>("");
    const [error, setError] = useState<string | null>(null);

    // Flatten `cells` arrays from every extracted field — ExcelPreview tints
    // every one of these so the user can see at a glance which cells fed the
    // result. Only meaningful when the source file is Excel.
    const excelHighlights = useMemo<ExcelCellRef[]>(() => {
        if (!result || !file || !isExcelFile(file)) return [];
        const out: ExcelCellRef[] = [];
        for (const v of Object.values(result as Record<string, any>)) {
            if (v && Array.isArray(v.cells)) {
                for (const c of v.cells) {
                    if (typeof c?.sheet === "number" && typeof c?.row === "number" && typeof c?.col === "number") {
                        out.push({ sheet: c.sheet, row: c.row, col: c.col });
                    }
                }
            }
        }
        return out;
    }, [result, file]);

    // ─── Templates ───
    const [templates, setTemplates] = useState<Template[]>([]);
    const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
    const [templateName, setTemplateName] = useState("");
    const [templateSearch, setTemplateSearch] = useState("");
    const [bookmarkedIds, setBookmarkedIds] = useState<string[]>([]);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [templateRailOpen, setTemplateRailOpen] = useState(true);
    // User's auto-load default template id (null = use built-in starter fields).
    // Auto-applied once on mount when templates load; user can pin/unpin via
    // the Pin icon next to each template name.
    const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
    const [defaultApplied, setDefaultApplied] = useState(false);

    // ─── Fields ───
    const [extractFields, setExtractFields] = useState<ExtractField[]>([
        { id: "1", name: t("ocr.defaultCompany"), type: "text" },
        { id: "2", name: t("ocr.defaultTaxId"), type: "number" },
        { id: "3", name: t("ocr.defaultAddress"), type: "address" },
        { id: "4", name: t("ocr.defaultTotal"), type: "currency" },
        { id: "5", name: t("ocr.defaultDate"), type: "date" },
    ]);
    const [newFieldName, setNewFieldName] = useState("");
    const [newFieldType, setNewFieldType] = useState<ExtractField["type"]>("text");
    // When set, the document preview shows a draw-mode overlay so the user
    // can drag a rectangle → sets the field's bbox_hint. Escape / clicking
    // "Clear hint" resets. Auto-clears when OCR runs so it doesn't leak.
    const [hintEditingFieldId, setHintEditingFieldId] = useState<string | null>(null);
    // Transient drag state during a bbox-hint draw. Coords are 0-1 relative
    // to the preview wrapper; cleared on mouseup regardless of outcome.
    const [hintDraw, setHintDraw] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

    // Commit the draw rectangle to the target field's bbox_hint + persist to
    // the active template. Skips if either coord dimension is trivially small
    // (accidental click) — needs at least 2% x 2% area to count.
    const commitHintDraw = useCallback((fid: string, r: { x0: number; y0: number; x1: number; y1: number }) => {
        const x = Math.min(r.x0, r.x1);
        const y = Math.min(r.y0, r.y1);
        const width = Math.abs(r.x1 - r.x0);
        const height = Math.abs(r.y1 - r.y0);
        if (width < 0.02 || height < 0.02) return;
        const bbox_hint: FieldBboxHint = {
            x: Math.max(0, Math.min(1, x)),
            y: Math.max(0, Math.min(1, y)),
            width: Math.max(0, Math.min(1, width)),
            height: Math.max(0, Math.min(1, height)),
            page: previewPage + 1,
            space: "page",
        };
        const next = extractFields.map(f => f.id === fid ? { ...f, bbox_hint } : f);
        setExtractFields(next);
        // OCR-6c dev-only observability: log the raw wrapper fractions plus
        // the resolved page rect (from pdfRaster.pageRects) so a future
        // coordinate-space regression is diagnosable in one console line.
        if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
            const pr = pdfRaster?.result.pageRects[previewPage];
            // eslint-disable-next-line no-console
            console.debug("[OCR-6c] hint draw", {
                fieldId: fid,
                page: previewPage + 1,
                bbox_hint,
                pageRectPx: pr ? { width: pr.width, height: pr.height, isLandscape: pr.width > pr.height } : null,
            });
        }
        // Persist to template silently if active.
        if (activeTemplateId && user) {
            const tpl = templates.find(t => t.id === activeTemplateId);
            if (tpl) {
                fetch("/api/templates", {
                    method: "POST",
                    body: JSON.stringify({ userId: user.id, name: tpl.name, fields: next, id: activeTemplateId }),
                }).catch(err => console.warn("[bbox_hint] template save failed", err));
            }
        }
    }, [extractFields, activeTemplateId, user, templates, previewPage, pdfRaster]);

    // Escape key exits draw mode without committing.
    useEffect(() => {
        if (!hintEditingFieldId) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { setHintEditingFieldId(null); setHintDraw(null); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [hintEditingFieldId]);
    const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);

    // Auto-invalidate stale result: when the user adds/removes/renames a field
    // after a run, the displayed result would keep ghosts of the old field set
    // (or lack the new ones). Clearing forces a fresh OCR run against the
    // current field list so the response can't be confused with "AI cache".
    useEffect(() => {
        if (!result) return;
        const currentSig = extractFields.map(f => f.name).join("|");
        if (currentSig !== resultFieldsSig) {
            setResult(null);
            setResultFieldsSig("");
        }
    }, [extractFields, result, resultFieldsSig]);

    // Drag-to-reorder. Native HTML5 drag — chip stays clickable for remove,
    // browser fires dragstart only past its movement threshold so a plain
    // click still works.
    const [draggingFieldId, setDraggingFieldId] = useState<string | null>(null);
    const [dropTargetFieldId, setDropTargetFieldId] = useState<string | null>(null);
    const reorderField = useCallback((fromId: string, toId: string) => {
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
    }, []);

    // ─── Session ───
    const [docId, setDocId] = useState<string | null>(null);

    // ─── Credit confirm dialog ───
    const [confirmDialog, setConfirmDialog] = useState<{
        reasons: ConfirmReason[];
        fingerprint: string;
    } | null>(null);

    // ─── Batch (multi-file OCR) ───
    // The batch path runs in parallel with the existing single-file flow.
    // When `batchItems` is non-empty the UI switches to a per-file list view
    // and the runner orchestrates a series of /api/upload + /api/status calls
    // capped at OCR_BATCH_CONCURRENCY in flight. Each item carries its own
    // status so a single failure (credit out, AI error) doesn't stall the rest.
    //
    // State is hoisted to AppContext (in (app)/layout) so navigating to
    // /documents and back to /ocr preserves an in-flight or finished batch.
    const { batchItems, setBatchItems, batchRunning, setBatchRunning } = useApp();
    const isBatchMode = batchItems.length >= BATCH_UI_THRESHOLD;
    const updateBatchItem = useCallback((id: string, patch: Partial<BatchItem>) => {
        setBatchItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
    }, []);

    // ─── Fullscreen result view ───
    // Auto-flips ON when a result lands (mirrors Compare's behavior) and the
    // user can close it with the X button or Esc. Closing returns to the
    // normal in-flow layout — extracted fields stay visible there too.
    const [isExpandedView, setIsExpandedView] = useState(false);
    useEffect(() => {
        if (!isExpandedView) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIsExpandedView(false); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [isExpandedView]);

    // ── Bookmarks (localStorage) ──
    useEffect(() => {
        const saved = localStorage.getItem("ocr_bookmarked_templates");
        if (saved) setBookmarkedIds(JSON.parse(saved));
    }, []);

    const toggleBookmark = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setBookmarkedIds((prev: string[]) => {
            const next = prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id];
            localStorage.setItem("ocr_bookmarked_templates", JSON.stringify(next));
            return next;
        });
    };

    // ── Fetch templates + user prefs (default template) in parallel ──
    useEffect(() => {
        if (!user) return;
        fetch(`/api/templates?userId=${user.id}`)
            .then(r => r.json())
            .then((d: any) => { if (Array.isArray(d)) setTemplates(d); })
            .catch(console.error);
        fetchJson<{ defaultOcrTemplateId: string | null }>(`/api/user-prefs?userId=${user.id}`)
            .then(r => { if (r.ok) setDefaultTemplateId(r.defaultOcrTemplateId); })
            .catch(() => { /* prefs are best-effort */ });
    }, [user]);

    // Auto-apply the default template once both templates list AND prefs have
    // arrived. `defaultApplied` guards against re-applying when the user
    // intentionally clears the workspace within the same session.
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

    // ── Drag & Drop ──
    useEffect(() => {
        const el = dropRef.current;
        if (!el) return;
        const prevent = (e: DragEvent) => e.preventDefault();
        const onDrop = (e: DragEvent) => {
            e.preventDefault();
            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) return;
            processFiles(Array.from(files));
        };
        el.addEventListener("dragover", prevent);
        el.addEventListener("drop", onDrop);
        return () => { el.removeEventListener("dragover", prevent); el.removeEventListener("drop", onDrop); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Entry point for both drag-drop and the file input. 1 file → existing
    // single-doc flow; 2+ files → batch flow (file list + per-file status +
    // summary export). Files past MAX_BATCH_FILES are dropped with a toast.
    const processFiles = useCallback((files: File[]) => {
        if (files.length === 0) return;
        if (files.length === 1) {
            // Reset batch state so a previous batch run doesn't ghost the UI
            // when the user comes back to drop a single file.
            setBatchItems([]);
            processFile(files[0]);
            return;
        }
        const accepted = files.slice(0, MAX_BATCH_FILES);
        const dropped = files.length - accepted.length;
        if (dropped > 0) {
            setError(t("ocr.batchTooManyFiles", { max: MAX_BATCH_FILES, dropped }));
        } else {
            setError(null);
        }
        // Clear the single-file slot so the batch UI takes over cleanly.
        setFile(null);
        previews.forEach(p => URL.revokeObjectURL(p));
        setPreviews([]);
        setResult(null);
        setBatchItems(accepted.map(f => ({
            id: crypto.randomUUID(),
            file: f,
            status: "queued",
        })));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [t, previews]);

    // ── File processing (PDF → per-page previews via pdfjs raster) ──
    // OCR-6c: PDFs no longer use `<iframe src=…pdf#view=FitH>` for preview.
    // The iframe letterboxes landscape pages inside a fixed-aspect wrapper,
    // so hints drawn on-screen resolved into wrapper-space fractions that
    // did NOT match the page-space fractions the crop code assumes. We
    // now rasterise the PDF up front via pdfjs (the same call the upload
    // path already uses) and preview each page as a plain `<img>` with
    // its true aspect ratio. Preview pixels == upload pixels == crop pixels.
    const processFile = useCallback(async (f: File) => {
        setResult(null);
        setError(null);
        previews.forEach(p => URL.revokeObjectURL(p));
        setPreviews([]);
        setPreviewPage(0);
        setZoom(1);
        setPdfRaster(null);

        // .docx — flatten to a single PNG via mammoth + html2canvas BEFORE
        // we set `file`. The downstream upload pipeline treats it as an image,
        // and the preview path renders it the same way.
        const isDocx = f.name.toLowerCase().endsWith(".docx")
            || f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (isDocx) {
            setFile(null);
            setConverting("docx");
            try {
                const imgFile = await docxFileToImage(f);
                setFile(imgFile);
                setPreviews([URL.createObjectURL(imgFile)]);
            } catch (err: any) {
                console.error("DOCX→image conversion failed", err);
                setError(t("ocr.convertDocxFailed"));
            } finally {
                setConverting(null);
            }
            return;
        }

        setFile(f);

        if (isExcelFile(f)) {
            // ExcelPreview parses the file directly — no blob URL needed.
            setPreviews([]);
            return;
        }

        if (f.type === "application/pdf") {
            try {
                // Rasterise once, up front. pagePngs[i] are the per-page bitmaps
                // that get shown in the preview; result.file is the stacked PNG
                // that will be uploaded verbatim. Same source pixels for both
                // sides of the hint contract.
                const detailed = await pdfFileToImageDetailed(f);
                const pages = detailed.pagePngs.map(b => URL.createObjectURL(b));
                setPreviews(pages);
                setPdfRaster({ sourceFile: f, result: detailed });

                // OCR-6c migration policy: hints saved BEFORE this fix were
                // measured against the iframe wrapper (fixed 210:297). Hints
                // on landscape pages (rendered rect wider than tall) were in
                // wrapper-space, not page-space — the on-screen position and
                // the crop rect no longer agree. Invalidate them silently and
                // let the user redraw. Portrait pages match wrapper aspect
                // closely enough that existing hints stay valid.
                const landscapePages = new Set(
                    detailed.pageRects
                        .map((pr, i) => (pr.width > pr.height ? i + 1 : -1))
                        .filter(p => p > 0),
                );
                if (landscapePages.size > 0) {
                    let invalidated = 0;
                    const cleaned = extractFields.map(fld => {
                        const h = fld.bbox_hint;
                        if (!h) return fld;
                        const p = h.page ?? 1;
                        if (!landscapePages.has(p)) return fld;
                        // Only invalidate hints from BEFORE the OCR-6c coordinate
                        // fix (no `space` marker = old wrapper-space). New hints
                        // drawn on landscape pages carry `space: "page"` and are
                        // valid — leaving them alone means users don't have to
                        // redraw every load.
                        if (h.space === "page") return fld;
                        invalidated++;
                        const { bbox_hint: _drop, ...rest } = fld;
                        return rest as ExtractField;
                    });
                    if (invalidated > 0) {
                        setExtractFields(cleaned);
                        setError(t("ocr.landscapeHintsInvalidated", { count: invalidated }));
                        // Persist the invalidation to the active template so
                        // the wrapper-space hints don't come back on next apply.
                        if (activeTemplateId && user) {
                            const tpl = templates.find(x => x.id === activeTemplateId);
                            if (tpl) {
                                fetch("/api/templates", {
                                    method: "POST",
                                    body: JSON.stringify({ userId: user.id, name: tpl.name, fields: cleaned, id: activeTemplateId }),
                                }).catch(err => console.warn("[bbox_hint] template save failed", err));
                            }
                        }
                    }
                }
            } catch (err) {
                // Rasterisation failed — fall back to a single-page image
                // preview using the source PDF blob directly. Hints won't work
                // on this fallback but the app doesn't crash. Log for triage.
                console.warn("[OCR-6c] pdf raster for preview failed; using raw PDF blob", err);
                setPreviews([URL.createObjectURL(f)]);
            }
        } else {
            setPreviews([URL.createObjectURL(f)]);
        }
    }, [previews, t, extractFields, activeTemplateId, user, templates]);

    const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        const fl = e.target.files;
        if (!fl || fl.length === 0) return;
        processFiles(Array.from(fl));
        // Allow the same files to be picked again later (e.g. after reset).
        e.target.value = "";
    };

    // ── Template actions ──
    const applyTemplate = (tpl: Template) => {
        setExtractFields(JSON.parse(tpl.fields_json));
        setActiveTemplateId(tpl.id);
    };

    // Capture bboxes from an OCR response and — if a template is active —
    // persist them silently so subsequent runs on the same template send
    // spatial hints to the AI. Existing hints are preserved (user's manual
    // tweaks win over auto-capture). Runs synchronously against local state
    // and fires a template save in the background.
    const captureBboxHints = useCallback((resultData: any) => {
        // Only auto-capture when the AI is confident. Below this, the returned
        // bbox may be a mis-read (e.g. on-line portion of a value that extends
        // below the line) and persisting it would lock future runs to the wrong
        // region. Tune here.
        const BBOX_CAPTURE_CONFIDENCE = 80; // 0-100 scale, matches prompt spec
        if (!resultData || !activeTemplateId || !user) return;
        let anyChange = false;
        const next = extractFields.map(f => {
            // Never overwrite an existing hint. User's manual drawing (or a
            // prior high-confidence capture) is authoritative; auto-capture
            // only fills empty slots.
            if (f.bbox_hint) return f;
            const entry = resultData[f.name];
            if (!entry || typeof entry !== "object") return f;
            const bbox = entry.bbox;
            const conf = Number(entry.confidence ?? 0);
            if (!bbox || typeof bbox.x !== "number" || conf < BBOX_CAPTURE_CONFIDENCE) return f;
            anyChange = true;
            return {
                ...f,
                bbox_hint: {
                    x: Math.max(0, Math.min(1, bbox.x)),
                    y: Math.max(0, Math.min(1, bbox.y)),
                    width: Math.max(0, Math.min(1, bbox.width)),
                    height: Math.max(0, Math.min(1, bbox.height)),
                    page: bbox.page && bbox.page > 0 ? bbox.page : 1,
                    space: "page" as const,
                },
            };
        });
        if (!anyChange) return;
        setExtractFields(next);
        // Persist to template silently — errors are OK, next run just re-captures.
        const tpl = templates.find(t => t.id === activeTemplateId);
        if (tpl) {
            fetch("/api/templates", {
                method: "POST",
                body: JSON.stringify({ userId: user.id, name: tpl.name, fields: next, id: activeTemplateId }),
            }).catch(err => console.warn("[bbox_hint] template save failed", err));
        }
    }, [activeTemplateId, extractFields, templates, user]);

    const saveTemplate = async (overrideId?: string) => {
        if (!user) return;
        // Overwrite mode (id provided): keep the existing template's name.
        // New mode: require user-typed name.
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

    // Pin/unpin a template as the user's auto-load default for OCR.
    // Optimistic UI: flip immediately, only revert on API failure.
    const setAsDefault = async (id: string | null, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!user) return;
        const prev = defaultTemplateId;
        setDefaultTemplateId(id);
        setDefaultApplied(true); // user-driven change — don't re-apply on next render
        const res = await fetchJson("/api/user-prefs", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: user.id, kind: "ocr", templateId: id }),
        });
        if (!res.ok) {
            setDefaultTemplateId(prev);
            setError(apiError(res.code, res.vars, t));
        }
    };

    // Modal-driven delete (replaces window.confirm). Pending id is set when
    // the user clicks delete on a template row; the modal calls confirmDelete
    // to actually issue the DELETE.
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

    // ── UI-1: page-picker interactions ─────────────────────────────────────
    const totalPagesInDoc = pdfRaster ? pdfRaster.result.pagePngs.length : 0;
    const showPagePicker = !!pdfRaster && totalPagesInDoc > 1;
    // "Selection equals the full document, in order" → skip the re-raster on
    // upload (cheap short-circuit; also communicates "no server-side subset"
    // to prepareUploadWithCrops).
    const selectionIsFullDoc = useMemo(() => {
        if (!showPagePicker) return true;
        if (selectedPages.length !== totalPagesInDoc) return false;
        for (let i = 0; i < selectedPages.length; i++) {
            if (selectedPages[i] !== i + 1) return false;
        }
        return true;
    }, [selectedPages, showPagePicker, totalPagesInDoc]);
    const togglePageSelection = useCallback((page: number) => {
        setPickerHint(null);
        setSelectedPages(prev => {
            if (prev.includes(page)) return prev.filter(p => p !== page);
            if (prev.length >= PAGE_SELECTION_MAX) {
                setPickerHint(t("ocr.pagePicker.capReached", { max: PAGE_SELECTION_MAX }));
                return prev;
            }
            // Keep selection in ascending page order — matches how the stacked
            // upload PNG will be assembled by the rasteriser (page 1 on top).
            return [...prev, page].sort((a, b) => a - b);
        });
    }, [t]);
    const selectAllPages = useCallback(() => {
        setPickerHint(null);
        const n = Math.min(totalPagesInDoc, PAGE_SELECTION_MAX);
        if (n < totalPagesInDoc) {
            setPickerHint(t("ocr.pagePicker.capReached", { max: PAGE_SELECTION_MAX }));
        }
        setSelectedPages(Array.from({ length: n }, (_, i) => i + 1));
    }, [t, totalPagesInDoc]);
    const selectNonePages = useCallback(() => {
        setPickerHint(null);
        setSelectedPages([]);
    }, []);

    // ── Run (with optional confirm dialog) ──
    const tryRun = () => {
        if (!file || extractFields.length === 0) return;
        const fp = makeFingerprint({
            operation: "ocr",
            templateId: activeTemplateId,
            fieldCount: extractFields.length,
            docCount: 1,
        });
        if (shouldSkipDialog(fp)) { handleUpload(); return; }

        const hasTableField = extractFields.some(f => f.type === "table");
        const ev = evaluateConfirm({
            estimate: estimateCredits({ operation: "ocr", fields: extractFields.length }).credits,
            balance,
            hasTableField,
        });
        if (!ev.needsConfirm) { handleUpload(); return; }
        setConfirmDialog({ reasons: ev.reasons, fingerprint: fp });
    };

    // ─── OCR-6: crop-based extraction for hinted fields ──────────────────────
    // Shared by handleUpload (single-file) and runBatchItem (batch) so the
    // two paths never diverge (see OCR_TESTING_LOG §2.4 — batch/single-file
    // symmetry has bitten us before). For a source File, produces the exact
    // File to upload PLUS a list of per-field crop Blobs generated from the
    // same rendered pixels. Non-hinted fields contribute nothing → crops[] empty.
    const prepareUploadWithCrops = useCallback(async (
        source: File,
        /** UI-1: 1-based ORIGINAL PDF page numbers to include. Empty / omitted
         *  = "send the whole document" (no re-raster, no `pages` part). When
         *  non-empty AND the selection differs from "all pages in order", we
         *  re-run the pdfjs raster with `opts.pages` so the uploaded stacked
         *  PNG only contains those tiles — that's how issue 1.3 actually
         *  shrinks (server just enforces the cap; the client owns the cut). */
        selection?: number[],
    ): Promise<{
        uploadFile: File;
        crops: Awaited<ReturnType<typeof buildFieldCrops>>;
        /** Effective 1-based ORIGINAL page numbers ACTUALLY rendered into
         *  `uploadFile`. `[]` when no PDF subset was applied. Callers use this
         *  as the `pages` FormData part (Path A metadata for the server). */
        renderedPages: number[];
        /** Source PDF's real page count when available (from pdfRaster).
         *  `null` for non-PDF files. */
        totalPages: number | null;
    }> => {
        let uploadFile: File = source;
        let pageRects: StackedPageRect[] | null = null;
        let renderedPages: number[] = [];
        let totalPages: number | null = null;
        if (source.type === "application/pdf") {
            try {
                const cachedFull = pdfRaster && pdfRaster.sourceFile === source
                    ? pdfRaster.result
                    : null;
                totalPages = cachedFull ? cachedFull.pageNumbers.length : null;
                // Decide whether the caller's selection actually differs from
                // "render every page in order". If it doesn't, reuse the
                // cached full raster (batch mode + single-page cases both hit
                // this fast path).
                const wantsSubset = Array.isArray(selection)
                    && selection.length > 0
                    && cachedFull
                    && !(selection.length === cachedFull.pageNumbers.length
                         && selection.every((p, i) => p === cachedFull.pageNumbers[i]));
                let detailed;
                if (wantsSubset) {
                    // Re-raster with the picked pages only. Preview stays on
                    // the full raster (thumbnails still show every page), so
                    // this second call is upload-only.
                    detailed = await pdfFileToImageDetailed(source, { pages: selection! });
                } else if (cachedFull) {
                    detailed = cachedFull;
                } else {
                    detailed = await pdfFileToImageDetailed(source);
                }
                uploadFile = detailed.file;
                pageRects = detailed.pageRects;
                renderedPages = detailed.pageNumbers.slice();
                if (totalPages === null) totalPages = detailed.pageNumbers.length;
            } catch (err) {
                console.error("[ocr] pdf→image conversion failed, sending raw PDF", err);
            }
        }
        const anyHint = extractFields.some(f => f.bbox_hint);
        let crops: Awaited<ReturnType<typeof buildFieldCrops>> = [];
        if (anyHint) {
            try {
                // API-1 Path A: pass the ORIGINAL page selection so
                // buildFieldCrops can translate `bbox_hint.page` → rendered
                // index. Hints whose page was deselected are silently dropped
                // (crop pass reflects what's actually in the upload).
                crops = await buildFieldCrops(uploadFile, extractFields, pageRects, renderedPages);
            } catch (err) {
                // Crop generation is a best-effort augmentation — if it fails,
                // fall back to the whole-image-only path (unchanged behavior).
                console.warn("[ocr-6] crop generation failed, continuing without crops", err);
                crops = [];
            }
        }
        return { uploadFile, crops, renderedPages, totalPages };
    }, [extractFields, pdfRaster]);

    /** Append crop blobs + field_crops JSON to a FormData already containing
     *  the whole-image `file` + `fields_json`. Safe to call with an empty
     *  crops array — no parts added, server behavior is unchanged (backward compat).
     */
    const appendCropsToFormData = useCallback((
        fd: FormData,
        crops: Awaited<ReturnType<typeof buildFieldCrops>>,
    ) => {
        if (crops.length === 0) return;
        const meta = crops.map((c, i) => ({ index: i, fieldName: c.fieldName, page: c.page }));
        fd.append("field_crops", JSON.stringify(meta));
        crops.forEach((c, i) => {
            fd.append(`crop_${i}`, new File([c.blob], `crop_${i}.png`, { type: "image/png" }));
        });
    }, []);

    /** UI-1 / API-1: append `pages` (JSON) + `total_pages` (int) to a
     *  multipart body when a PDF subset was applied. No-op for non-PDF and
     *  full-doc uploads so the server keeps today's contract byte-for-byte
     *  when nothing was picked. */
    const appendPagesToFormData = useCallback((
        fd: FormData,
        renderedPages: number[],
        totalPages: number | null,
    ) => {
        if (totalPages !== null && totalPages > 0) {
            fd.append("total_pages", String(totalPages));
        }
        // Only send `pages` when a subset (not the whole doc) was actually
        // rendered — matches server semantics (`pages` present = "this is a
        // filtered selection"). Full-doc uploads omit it and rely solely on
        // `total_pages` for the cap check.
        if (
            renderedPages.length > 0
            && totalPages !== null
            && !(renderedPages.length === totalPages
                 && renderedPages.every((p, i) => p === i + 1))
        ) {
            fd.append("pages", JSON.stringify(renderedPages));
        }
    }, []);

    // ── Upload + Poll ──
    const handleUpload = async () => {
        if (!file) return;
        setLoading(true);
        setResult(null);
        setError(null);
        setProgress(10);
        setProcessingStep(t("ocr.extracting"));

        // Convert PDFs to a hi-DPI PNG before upload so Gemini gets sharper
        // Thai text (server-side PDF rendering was too low-res and caused
        // misreads like "ช็อคบอล" → "คอบอล"). Image / docx / xlsx paths are
        // unchanged; docx was already flattened earlier in processFile.
        // OCR-6: also generate per-field crops from the same rendered pixels
        // so the server can run a focused second AI call on hinted fields.
        setProcessingStep(t("ocr.extracting"));
        // UI-1: honour the page-picker selection (single-file path). Empty
        // selection is only reachable for non-PDF and single-page PDFs;
        // multi-page PDFs default-select and the Extract button is disabled
        // when the user manually clears everything.
        const { uploadFile, crops, renderedPages, totalPages } = await prepareUploadWithCrops(file, selectedPages);

        const formData = new FormData();
        formData.append("file", uploadFile);
        if (user) formData.append("userId", user.id);
        formData.append("fields", extractFields.map(f => f.type !== "text" ? `${f.name} (${f.type})` : f.name).join(", "));
        // Full field spec including bbox hints — server prefers this when present
        // and falls back to the string above so old templates keep working.
        formData.append("fields_json", JSON.stringify(extractFields));
        appendCropsToFormData(formData, crops);
        appendPagesToFormData(formData, renderedPages, totalPages);

        try {
            setProgress(30);
            const data = await fetchJson<{ documentId?: string }>("/api/upload", {
                method: "POST", body: formData,
            });
            if (!data.ok) {
                if (data.code === ErrorCode.INSUFFICIENT_CREDITS && onNavigateToBilling) {
                    onNavigateToBilling();
                    return;
                }
                throw Object.assign(new Error(data.code), { code: data.code, vars: data.vars });
            }
            if (!data.documentId) {
                setError(apiError(ErrorCode.UPLOAD_FAILED, undefined, t));
                setLoading(false);
                setProgress(0);
                return;
            }
            setDocId(data.documentId);
            setProgress(50);
            poll(data.documentId);
        } catch (err: any) {
            setError(apiError(err?.code || ErrorCode.UPLOAD_FAILED, err?.vars, t));
            setLoading(false);
            setProgress(0);
        }
    };

    const poll = (id: string) => {
        let ticks = 0;
        const interval = setInterval(async () => {
            ticks++;
            setProgress(Math.min(50 + ticks * 5, 92));
            try {
                const res = await fetch(`/api/status?id=${id}`);
                const data = await res.json() as { status: string; data: any };
                if (data.status === "completed") {
                    clearInterval(interval);
                    setResult(data.data);
                    setResultFieldsSig(extractFields.map(f => f.name).join("|"));
                    setIsExpandedView(true);
                    setProgress(100);
                    // Auto-capture bbox hints from this run so the next OCR on
                    // the same template can use them as spatial anchors. Only
                    // fields with confidence ≥ 80 + a valid bbox get captured,
                    // and only when the template doesn't already carry a hint
                    // (user tweaks aren't overwritten).
                    captureBboxHints(data.data);
                    // Personalised "average credits per run" — feeds the T2
                    // (relative spike) confirm trigger on subsequent runs.
                    recordCreditUse(estimateCredits({ operation: "ocr", fields: extractFields.length }).credits);
                    if (onDocumentProcessed) onDocumentProcessed();
                    setTimeout(() => { setLoading(false); setProgress(0); }, 600);
                } else if (data.status === "error") {
                    clearInterval(interval);
                    setError(apiError(ErrorCode.AI_FAILED, undefined, t));
                    setLoading(false);
                    setProgress(0);
                }
            } catch { /* keep polling */ }
        }, 2000);
    };

    // ── Batch runner (multi-file OCR) ──
    // For each queued item: convert .docx if needed, POST /api/upload, then
    // poll /api/status until `completed` or `error`. Concurrency capped at
    // OCR_BATCH_CONCURRENCY so we don't trip Gemini's rate limit. Each item
    // succeeds or fails independently — a single error never aborts the
    // batch. INSUFFICIENT_CREDITS marks the item `skipped` (rest still run).
    const runBatchItem = useCallback(async (item: BatchItem): Promise<void> => {
        const fieldList = extractFields.map(f => f.type !== "text" ? `${f.name} (${f.type})` : f.name).join(", ");
        try {
            updateBatchItem(item.id, { status: "processing", error: undefined });

            // .docx flatten to PNG before upload, same as single-file path.
            // For PDFs, prepareUploadWithCrops handles the pdfjs render internally.
            let toUpload = item.file;
            const isDocx = item.file.name.toLowerCase().endsWith(".docx")
                || item.file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            if (isDocx) {
                try {
                    toUpload = await docxFileToImage(item.file);
                } catch (e: any) {
                    console.error("[batch] DOCX→image conversion failed", e);
                    updateBatchItem(item.id, { status: "error", error: t("ocr.convertDocxFailed") });
                    return;
                }
            }
            // Shared prep with single-file path (PDF→PNG + per-field crops).
            // OCR-6: batch MUST behave symmetrically — divergent batch/single
            // paths have regressed us before (see OCR_TESTING_LOG §2.4).
            // UI-1: batch does NOT expose a per-file page picker in v1 —
            // the spec explicitly asks for the same selection to flow through
            // both paths, not a fresh UI for each batch row. Reuse whatever
            // the single-file picker most recently chose. Files with fewer
            // pages than the selection are safe because pdfFileToImageDetailed
            // silently drops out-of-range entries (see selection cleanup in
            // that helper). Files where NONE of the picked pages exist fall
            // through to a full-doc render (matches today's batch behaviour).
            const batchSelection = selectedPages;
            const { uploadFile: prepared, crops, renderedPages, totalPages } = await prepareUploadWithCrops(toUpload, batchSelection);

            const fd = new FormData();
            fd.append("file", prepared);
            if (user) fd.append("userId", user.id);
            fd.append("fields", fieldList);
            fd.append("fields_json", JSON.stringify(extractFields));
            appendCropsToFormData(fd, crops);
            appendPagesToFormData(fd, renderedPages, totalPages);

            const uploadResp = await fetchJson<{ documentId?: string }>("/api/upload", { method: "POST", body: fd });
            if (!uploadResp.ok) {
                if (uploadResp.code === ErrorCode.INSUFFICIENT_CREDITS) {
                    updateBatchItem(item.id, { status: "skipped", error: t("ocr.batchSkippedNoCredit") });
                } else {
                    updateBatchItem(item.id, { status: "error", error: apiError(uploadResp.code, uploadResp.vars, t) });
                }
                return;
            }
            if (!uploadResp.documentId) {
                updateBatchItem(item.id, { status: "error", error: apiError(ErrorCode.UPLOAD_FAILED, undefined, t) });
                return;
            }

            // Poll /api/status until done or timeout. Each tick checks
            // status, not progress — backend writes the final row atomically.
            const docId = uploadResp.documentId;
            updateBatchItem(item.id, { docId });
            const started = Date.now();
            // eslint-disable-next-line no-constant-condition
            while (true) {
                if (Date.now() - started > PER_FILE_TIMEOUT_MS) {
                    updateBatchItem(item.id, { status: "error", error: t("ocr.batchTimeout") });
                    return;
                }
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                try {
                    const res = await fetch(`/api/status?id=${docId}`);
                    const data = await res.json() as { status?: string; data?: any };
                    if (data.status === "completed") {
                        updateBatchItem(item.id, { status: "done", data: data.data });
                        return;
                    }
                    if (data.status === "error") {
                        updateBatchItem(item.id, { status: "error", error: t("ocr.aiFailedShort") });
                        return;
                    }
                } catch { /* transient network error — keep polling */ }
            }
        } catch (e: any) {
            console.error("[batch] runBatchItem failed", e);
            updateBatchItem(item.id, { status: "error", error: apiError(e?.code || ErrorCode.PROCESSING_FAILED, e?.vars, t) });
        }
    }, [extractFields, user, updateBatchItem, t, prepareUploadWithCrops, appendCropsToFormData, appendPagesToFormData, selectedPages]);

    const runBatch = useCallback(async () => {
        if (batchItems.length === 0 || batchRunning) return;
        if (extractFields.length === 0) {
            setError(t("ocr.batchNoFields"));
            return;
        }
        setBatchRunning(true);
        setError(null);

        // Snapshot the queue at run-start so re-rendering doesn't reshuffle
        // what's already processing. Concurrency-limited worker pool: spin up
        // N workers, each pulls the next queued id off the shared index.
        const ids = batchItems.map(it => it.id);
        let cursor = 0;
        const next = () => (cursor < ids.length ? ids[cursor++] : null);

        const worker = async () => {
            while (true) {
                const id = next();
                if (!id) return;
                // Re-read the latest version from state so any pre-flight
                // mutation (e.g. re-queued retry) is honoured.
                const current = await new Promise<BatchItem | undefined>(resolve => {
                    setBatchItems(prev => { resolve(prev.find(b => b.id === id)); return prev; });
                });
                if (!current || current.status === "done") continue;
                await runBatchItem(current);
            }
        };
        await Promise.all(Array.from({ length: OCR_BATCH_CONCURRENCY }, () => worker()));

        setBatchRunning(false);
        // Personalised credit average — count only successful runs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const doneCount = await new Promise<number>(resolve => {
            setBatchItems(prev => { resolve(prev.filter(b => b.status === "done").length); return prev; });
        });
        if (doneCount > 0) {
            recordCreditUse(estimateCredits({ operation: "ocr", fields: extractFields.length }).credits * doneCount);
            if (onDocumentProcessed) onDocumentProcessed();
        }
    }, [batchItems, batchRunning, extractFields, runBatchItem, onDocumentProcessed, t]);

    const downloadBatchSummary = useCallback((format: "excel" | "csv") => {
        const results: BatchResult[] = batchItems.map(it => ({
            fileName: it.file.name,
            data: it.data ?? null,
            status: it.status === "done" ? "done" : it.status === "skipped" ? "skipped" : "error",
            error: it.error,
        }));
        exportOCRBatch(results, "ocr-batch", format);
    }, [batchItems]);

    const removeBatchItem = useCallback((id: string) => {
        setBatchItems(prev => prev.filter(it => it.id !== id));
    }, []);

    // ── Result edit ──
    const updateField = (key: string, value: string) => {
        if (!result) return;
        const n = { ...result };
        if (n[key] && typeof n[key] === "object" && "value" in n[key]) n[key] = { ...n[key], value };
        else n[key] = value;
        setResult(n);
    };

    const updateCell = (key: string, row: number, col: string, value: string) => {
        if (!result) return;
        const n = { ...result };
        const item = n[key];
        const arr = (item && typeof item === "object" && "value" in item) ? item.value : item;
        if (Array.isArray(arr)) arr[row][col] = value;
        setResult(n);
    };

    // ── Export ──
    const exportData = (format: "excel" | "csv") => {
        if (!result) return;
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        exportOCRResult(result, `OCR_${ts}`, format);
    };

    const resetWorkspace = () => {
        setFile(null);
        previews.forEach(p => URL.revokeObjectURL(p));
        setPreviews([]);
        setPdfRaster(null);
        setResult(null);
        setError(null);
        setDocId(null);
        setIsExpandedView(false);
        setZoom(1);
        setConverting(null);
        setBatchItems([]);
    };

    // ── Template filtering ──
    const filteredTemplates = templates.filter(tpl => {
        const matchesSearch = tpl.name.toLowerCase().includes(templateSearch.toLowerCase());
        return matchesSearch;
    });
    const systemTemplates = filteredTemplates.filter(tpl => (tpl as any).user_id === "system");
    const myTemplates = filteredTemplates.filter(tpl => (tpl as any).user_id !== "system");
    const bookmarkedTemplates = templates.filter(tpl => bookmarkedIds.includes(tpl.id));

    // ─── Credit estimate (live as fields change) ───
    const estimate = estimateCredits({ operation: "ocr", fields: extractFields.length });
    const tone = creditTone(estimate.credits);
    const TONE_COLOR: Record<string, string> = {
        green: "var(--color-success)", amber: "var(--color-warning)", orange: "#f97316", red: "var(--color-danger)",
    };
    const estimateColor = TONE_COLOR[tone];

    // ─── RENDER ─────────────────────────────────────────────
    return (
        <div
            ref={dropRef}
            style={{
                display: "flex",
                // Fullscreen overlay when isExpandedView. The same JSX is used for
                // both states — switching just the outer wrapper keeps the result
                // table + preview reactive without remounting expensive children
                // like the PDF/image preview.
                ...(isExpandedView ? {
                    position: "fixed" as const,
                    inset: 0,
                    zIndex: 100,
                    height: "100vh",
                    borderRadius: 0,
                    border: "none",
                    animation: "fadeIn 0.18s ease",
                } : {
                    height: "calc(100vh - 92px)",
                    borderRadius: 10,
                    border: "1px solid var(--color-border)",
                }),
                overflow: "hidden",
                background: "var(--color-bg-body)",
                color: "var(--color-text-1)",
            }}
        >
            {/* Floating "exit fullscreen" button — rendered at the workspace
                root so it stays pinned even when the user scrolls inside the
                preview/result panels. */}
            {isExpandedView && (
                <button
                    onClick={() => setIsExpandedView(false)}
                    title={t("ocr.closeExpanded")}
                    style={{
                        position: "absolute",
                        top: 12,
                        right: 16,
                        zIndex: 110,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        background: "rgba(239,68,68,0.18)",
                        border: "1px solid rgba(239,68,68,0.4)",
                        color: "var(--color-danger)",
                        borderRadius: 7,
                        padding: "6px 12px",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        backdropFilter: "blur(4px)",
                    }}
                >
                    <Icon.X width={12} height={12} /> {t("ocr.closeExpanded")}
                </button>
            )}
            {/* Hover styles for interactive items — inline so theme tokens apply */}
            <style>{`
                .ocr-field-chip:hover {
                    background: color-mix(in srgb, var(--chip-color) 28%, transparent);
                    border-color: var(--chip-color);
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px color-mix(in srgb, var(--chip-color) 20%, transparent);
                }
                .ocr-field-chip:active { transform: translateY(0); }
                .ocr-template-item {
                    transition: background 0.15s, color 0.15s, transform 0.15s, padding-left 0.15s;
                    position: relative;
                }
                .ocr-template-item:hover {
                    background: rgba(255, 255, 255, 0.04);
                    color: var(--color-text-1) !important;
                    padding-left: 14px !important;
                }
                .ocr-template-item:hover::before {
                    content: "";
                    position: absolute;
                    left: 0; top: 6px; bottom: 6px;
                    width: 2px;
                    background: var(--ocr-template-accent, ${ACCENT});
                    border-radius: 0 2px 2px 0;
                }
                .ocr-template-item.is-active::before {
                    content: "";
                    position: absolute;
                    left: 0; top: 6px; bottom: 6px;
                    width: 2px;
                    background: var(--ocr-template-accent, ${ACCENT});
                    border-radius: 0 2px 2px 0;
                }
            `}</style>
            {/* ─ Template rail (open or collapsed) ─
                Hidden in fullscreen — the user is focused on reviewing the
                extracted result, not picking templates. They can exit
                fullscreen to switch templates. */}
            {!isExpandedView && (templateRailOpen ? (
                <div style={{
                    width: 220, minWidth: 220,
                    background: "var(--color-bg-panel)",
                    borderRight: "1px solid var(--color-border)",
                    display: "flex", flexDirection: "column", overflow: "hidden",
                }}>
                    <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--color-border)" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--color-text-3)" }}>
                                {t("ocr.templates")}
                            </span>
                            <button
                                onClick={() => setTemplateRailOpen(false)}
                                title={t("ocr.closeTemplates")}
                                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-3)", padding: 2 }}
                            >
                                <Icon.ChevronLeft width={14} height={14} />
                            </button>
                        </div>
                        <div style={{ position: "relative" }}>
                            <span style={{ position: "absolute", left: 9, top: 8, color: "var(--color-text-3)", pointerEvents: "none" }}>
                                <Icon.Search width={13} height={13} />
                            </span>
                            <input
                                value={templateSearch}
                                onChange={e => setTemplateSearch(e.target.value)}
                                placeholder={t("ocr.templatesSearch")}
                                style={{
                                    width: "100%", padding: "7px 8px 7px 28px",
                                    background: "var(--color-bg-elevated)",
                                    border: "1px solid var(--color-border)",
                                    borderRadius: 7, color: "var(--color-text-1)",
                                    fontSize: 12, outline: "none", boxSizing: "border-box",
                                }}
                            />
                        </div>
                    </div>
                    <div className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: 8 }}>
                        {bookmarkedTemplates.length > 0 && (
                            <TemplateGroup
                                title={t("ocr.templateSectionFavorites")}
                                items={bookmarkedTemplates}
                                activeId={activeTemplateId}
                                onPick={applyTemplate}
                                onBookmark={toggleBookmark}
                                bookmarkedIds={bookmarkedIds}
                                accent="#f59e0b"
                                defaultId={defaultTemplateId}
                                onSetDefault={setAsDefault}
                                pinLabel={t("ocr.templateSetDefault")}
                                pinnedLabel={t("ocr.templateDefault")}
                            />
                        )}
                        {systemTemplates.length > 0 && (
                            <TemplateGroup
                                title={t("ocr.templateSectionStandard")}
                                items={systemTemplates}
                                activeId={activeTemplateId}
                                onPick={applyTemplate}
                                onBookmark={toggleBookmark}
                                bookmarkedIds={bookmarkedIds}
                                accent={ACCENT}
                                defaultId={defaultTemplateId}
                                onSetDefault={setAsDefault}
                                pinLabel={t("ocr.templateSetDefault")}
                                pinnedLabel={t("ocr.templateDefault")}
                            />
                        )}
                        {myTemplates.length > 0 && (
                            <TemplateGroup
                                title={t("ocr.templateSectionMine")}
                                items={myTemplates}
                                activeId={activeTemplateId}
                                onPick={applyTemplate}
                                onBookmark={toggleBookmark}
                                bookmarkedIds={bookmarkedIds}
                                accent={ACCENT}
                                onDelete={deleteTemplate}
                                defaultId={defaultTemplateId}
                                onSetDefault={setAsDefault}
                                pinLabel={t("ocr.templateSetDefault")}
                                pinnedLabel={t("ocr.templateDefault")}
                            />
                        )}
                        {filteredTemplates.length === 0 && (
                            <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-3)", fontSize: 11.5 }}>
                                {t("ocr.templatesEmpty")}
                            </div>
                        )}
                    </div>
                    {/* New template footer */}
                    <div style={{ padding: "10px 8px", borderTop: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 6 }}>
                        <input
                            value={templateName}
                            onChange={e => setTemplateName(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && saveTemplate()}
                            placeholder={t("ocr.templateName")}
                            style={{
                                width: "100%", padding: "7px 9px",
                                background: "var(--color-bg-elevated)",
                                border: "1px solid var(--color-border)",
                                borderRadius: 7, color: "var(--color-text-1)",
                                fontSize: 12, outline: "none", boxSizing: "border-box",
                            }}
                        />
                        <button
                            onClick={() => saveTemplate()}
                            disabled={savingTemplate || !templateName.trim()}
                            style={{
                                width: "100%", padding: 8, borderRadius: 7,
                                border: `1px dashed ${ACCENT}66`,
                                background: "transparent", color: ACCENT,
                                fontSize: 12, fontWeight: 600,
                                cursor: savingTemplate || !templateName.trim() ? "not-allowed" : "pointer",
                                opacity: savingTemplate || !templateName.trim() ? 0.5 : 1,
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                            }}
                        >
                            <Icon.Plus width={13} height={13} />
                            {savingTemplate ? t("common.processing") : t("ocr.templatesNew")}
                        </button>
                        {activeTemplateId && (
                            <button
                                onClick={() => saveTemplate(activeTemplateId)}
                                disabled={savingTemplate}
                                title={templates.find(tpl => tpl.id === activeTemplateId)?.name || ""}
                                style={{
                                    width: "100%", padding: 8, borderRadius: 7,
                                    border: `1px solid ${ACCENT}88`,
                                    background: `${ACCENT}14`, color: ACCENT,
                                    fontSize: 12, fontWeight: 600,
                                    cursor: savingTemplate ? "not-allowed" : "pointer",
                                    opacity: savingTemplate ? 0.5 : 1,
                                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                }}
                            >
                                <Icon.RefreshCw width={12} height={12} />
                                {t("ocr.templatesOverwrite")}
                            </button>
                        )}
                    </div>
                </div>
            ) : (
                // ─ Collapsed rail (~48px wide, vertical "TEMPLATES" + favorite dots) ─
                <div style={{
                    width: 48, minWidth: 48,
                    background: "var(--color-bg-panel)",
                    borderRight: "1px solid var(--color-border)",
                    display: "flex", flexDirection: "column", alignItems: "center",
                    padding: "10px 0", gap: 8,
                }}>
                    <button
                        onClick={() => setTemplateRailOpen(true)}
                        title={t("ocr.openTemplates")}
                        style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer", padding: 6 }}
                    >
                        <Icon.Layers width={18} height={18} />
                    </button>
                    <div style={{
                        writingMode: "vertical-rl", transform: "rotate(180deg)",
                        fontSize: 9, fontWeight: 700, letterSpacing: 2,
                        textTransform: "uppercase", color: "var(--color-text-3)",
                        padding: "8px 0",
                    }}>
                        {t("ocr.templates")}
                    </div>
                    <div style={{
                        flex: 1, display: "flex", flexDirection: "column",
                        alignItems: "center", gap: 6, paddingTop: 6,
                        overflowY: "auto",
                    }}>
                        {bookmarkedTemplates.slice(0, 10).map(tpl => (
                            <button
                                key={tpl.id}
                                onClick={() => { applyTemplate(tpl); setTemplateRailOpen(true); }}
                                title={tpl.name}
                                style={{
                                    width: 8, height: 8, borderRadius: "50%",
                                    background: activeTemplateId === tpl.id ? ACCENT : "#f59e0b",
                                    border: "none", cursor: "pointer", padding: 0,
                                }}
                            />
                        ))}
                    </div>
                    <button
                        onClick={() => setTemplateRailOpen(true)}
                        title={t("ocr.templatesNew")}
                        style={{
                            background: `${ACCENT}22`,
                            border: `1px dashed ${ACCENT}55`,
                            color: ACCENT, cursor: "pointer",
                            padding: 6, borderRadius: 6,
                        }}
                    >
                        <Icon.Plus width={13} height={13} />
                    </button>
                </div>
            ))}

            {/* ─ Main workspace column ─ */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
                {/* Fields chip row — auto-grow 32→132px, then scroll */}
                <div style={{
                    padding: "10px 16px",
                    borderBottom: "1px solid var(--color-border)",
                    flexShrink: 0,
                    background: "var(--color-bg-surface)",
                }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                        <span style={{
                            fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
                            textTransform: "uppercase", color: "var(--color-text-3)",
                        }}>
                            {t("ocr.fieldsLabel")}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                            {t("ocr.fieldsActiveCount", { count: extractFields.length })}
                        </span>
                        {extractFields.length > 0 && (
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
                            <button
                                onClick={() => setExtractFields([])}
                                style={{
                                    marginLeft: "auto", background: "none", border: "none",
                                    color: "var(--color-danger)", fontSize: 11, cursor: "pointer",
                                }}
                            >
                                {t("ocr.fieldClearAll")}
                            </button>
                        )}
                    </div>
                    <div className="custom-scrollbar" style={{
                        display: "flex", flexWrap: "wrap", gap: 6,
                        minHeight: 32, maxHeight: 100,
                        overflowY: "auto", alignContent: "flex-start",
                        paddingRight: 4,
                    }}>
                        {extractFields.map(f => {
                            const c = TYPE_COLOR[f.type] || ACCENT;
                            const isDragging = draggingFieldId === f.id;
                            const isDropTarget = dropTargetFieldId === f.id && draggingFieldId && draggingFieldId !== f.id;
                            return (
                                <button
                                    key={f.id}
                                    className="ocr-field-chip"
                                    draggable
                                    onDragStart={(e) => {
                                        setDraggingFieldId(f.id);
                                        e.dataTransfer.effectAllowed = "move";
                                        // Required by Firefox to actually start a drag.
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
                                        ["--chip-color" as any]: c,
                                        transition: "background 0.15s, border-color 0.15s, transform 0.15s, box-shadow 0.15s, opacity 0.15s",
                                    }}
                                    title="Click to remove · Drag to reorder"
                                >
                                    <span style={{ fontSize: 9, opacity: 0.8, textTransform: "uppercase" }}>{TYPE_LABEL[f.type] || f.type}</span>
                                    {f.name}
                                    {/* Pin: click to enter draw mode for this field's bbox_hint.
                                        Filled when a hint exists, outlined otherwise. Shift-click
                                        clears the hint without opening the editor. */}
                                    <span
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (e.shiftKey && f.bbox_hint) {
                                                setExtractFields(prev => prev.map(x => x.id === f.id ? { ...x, bbox_hint: undefined } : x));
                                                return;
                                            }
                                            setHintEditingFieldId(hintEditingFieldId === f.id ? null : f.id);
                                        }}
                                        title={f.bbox_hint
                                            ? `ตำแหน่งบันทึกไว้ (คลิกเพื่อวาดใหม่, Shift+คลิกเพื่อล้าง)`
                                            : "คลิกเพื่อกำหนดตำแหน่งบนเอกสาร"}
                                        style={{
                                            display: "inline-flex", alignItems: "center",
                                            padding: "1px 3px", borderRadius: 3,
                                            background: hintEditingFieldId === f.id ? "#dc2626" : "transparent",
                                            color: hintEditingFieldId === f.id ? "#fff"
                                                 : f.bbox_hint ? c : "var(--color-text-4)",
                                            opacity: f.bbox_hint || hintEditingFieldId === f.id ? 1 : 0.6,
                                        }}
                                    >
                                        <Icon.Pin width={10} height={10} />
                                    </span>
                                    <Icon.X width={10} height={10} />
                                </button>
                            );
                        })}
                        {extractFields.length === 0 && (
                            <span style={{ fontSize: 11.5, color: "var(--color-text-3)", fontStyle: "italic", padding: "5px 0" }}>
                                {t("ocr.fieldEmptyHint")}
                            </span>
                        )}
                    </div>

                    {/* Add field composer — outside scroll area so dropdown isn't clipped */}
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
                        <input
                            value={newFieldName}
                            onChange={e => setNewFieldName(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && addField()}
                            placeholder={t("ocr.fieldNew")}
                            style={{
                                flex: 1, padding: "6px 10px",
                                background: "var(--color-bg-elevated)",
                                border: "1px solid var(--color-border)",
                                borderRadius: 6, color: "var(--color-text-1)",
                                fontSize: 12.5, outline: "none", minWidth: 0,
                            }}
                        />
                        <div style={{ position: "relative" }}>
                            <button
                                onClick={() => setIsTypeDropdownOpen(o => !o)}
                                style={{
                                    padding: "6px 10px",
                                    background: `${TYPE_COLOR[newFieldType]}18`,
                                    border: `1px solid ${TYPE_COLOR[newFieldType]}55`,
                                    color: TYPE_COLOR[newFieldType], borderRadius: 6,
                                    fontSize: 11, fontWeight: 600, cursor: "pointer",
                                    textTransform: "uppercase",
                                    display: "inline-flex", alignItems: "center", gap: 5,
                                    minWidth: 90, justifyContent: "space-between",
                                }}
                            >
                                {TYPE_LABEL[newFieldType] || newFieldType} <Icon.ChevronDown width={10} height={10} />
                            </button>
                            {isTypeDropdownOpen && (
                                <>
                                    <div
                                        style={{ position: "fixed", inset: 0, zIndex: 60 }}
                                        onClick={() => setIsTypeDropdownOpen(false)}
                                    />
                                    <div style={{
                                        position: "absolute", top: "100%", right: 0, marginTop: 4,
                                        background: "var(--color-bg-elevated)",
                                        border: "1px solid var(--color-border-strong)",
                                        borderRadius: 8, zIndex: 70, padding: 4, minWidth: 140,
                                        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                                    }}>
                                        {Object.keys(TYPE_COLOR).map(typ => (
                                            <button
                                                key={typ}
                                                onClick={() => { setNewFieldType(typ as ExtractField["type"]); setIsTypeDropdownOpen(false); }}
                                                style={{
                                                    display: "flex", alignItems: "center", gap: 8,
                                                    padding: "6px 10px", borderRadius: 5,
                                                    border: "none",
                                                    background: newFieldType === typ ? `${TYPE_COLOR[typ]}22` : "transparent",
                                                    color: TYPE_COLOR[typ], fontSize: 11.5, fontWeight: 600,
                                                    textTransform: "uppercase", cursor: "pointer",
                                                    width: "100%", textAlign: "left",
                                                }}
                                            >
                                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: TYPE_COLOR[typ] }} />
                                                {TYPE_LABEL[typ] || typ}
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                        <button
                            onClick={addField}
                            title={t("common.add")}
                            style={{
                                padding: "6px 10px", background: ACCENT, border: "none",
                                borderRadius: 6, color: "#fff", cursor: "pointer",
                                display: "inline-flex", alignItems: "center", gap: 4,
                                fontSize: 12, fontWeight: 600,
                            }}
                        >
                            <Icon.Plus width={12} height={12} /> {t("common.add")}
                        </button>
                    </div>
                </div>

                {/* Workspace: Preview (+ Result when ready) */}
                <div style={{ flex: 1, display: "flex", minHeight: 0, gap: 12, padding: 12 }}>
                    {/* ─ Preview pane ─ */}
                    <div style={{
                        flex: 1, display: "flex", flexDirection: "column",
                        minHeight: 0, minWidth: 0,
                        background: "var(--color-bg-card)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 10, overflow: "hidden",
                    }}>
                        {isBatchMode ? (
                            <BatchPanel
                                items={batchItems}
                                running={batchRunning}
                                onRun={runBatch}
                                onDownload={downloadBatchSummary}
                                onRemove={removeBatchItem}
                                onAddMore={() => document.getElementById("ocr-file-input")?.click()}
                                onClearAll={resetWorkspace}
                                t={t}
                                accent={ACCENT}
                            />
                        ) : !file ? (
                            <label
                                className="ocr-dropzone"
                                style={{
                                    flex: 1, display: "flex", flexDirection: "column",
                                    alignItems: "center", justifyContent: "center", gap: 14,
                                    cursor: "pointer",
                                    border: `2px dashed var(--color-border-strong)`,
                                    margin: 12, borderRadius: 10,
                                    transition: "all 0.3s ease",
                                }}>
                                <input id="ocr-file-input" type="file" multiple style={{ display: "none" }} onChange={handleFileInput} accept="application/pdf,image/*,.docx,.xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" />
                                <div
                                    className="ocr-dropzone-icon"
                                    style={{
                                        width: 80, height: 80, borderRadius: 20,
                                        background: `${ACCENT}14`,
                                        border: `2px dashed ${ACCENT}55`,
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                        transition: "transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.3s, border-color 0.3s",
                                    }}>
                                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ transition: "color 0.3s" }}>
                                        <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9" />
                                        <path d="M15 13l-3-3m0 0l-3 3m3-3v12" />
                                    </svg>
                                </div>
                                <div style={{ textAlign: "center" }}>
                                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-1)" }}>
                                        {t("ocr.uploadHeadline")}
                                    </div>
                                    <div style={{ fontSize: 12, color: "var(--color-text-3)", marginTop: 4 }}>
                                        {t("ocr.uploadSubtext")}
                                    </div>
                                </div>
                                <style>{`
                                    .ocr-dropzone:hover { border-color: ${ACCENT}88; background: ${ACCENT}08; }
                                    .ocr-dropzone:hover .ocr-dropzone-icon {
                                        transform: scale(1.1) rotate(3deg);
                                        background: ${ACCENT}22;
                                        border-color: ${ACCENT};
                                    }
                                `}</style>
                            </label>
                        ) : (
                            <>
                                <div style={{
                                    display: "flex", alignItems: "center", gap: 10,
                                    padding: "8px 12px",
                                    borderBottom: "1px solid var(--color-border)",
                                    flexShrink: 0,
                                }}>
                                    <Icon.FileText width={14} height={14} color={ACCENT} />
                                    <span style={{
                                        fontSize: 12, fontWeight: 600, color: "var(--color-text-1)",
                                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                        maxWidth: 240,
                                    }}>
                                        {file?.name}
                                    </span>
                                    <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                                        {previews.length > 1 ? `${previews.length} ${t("common.page")}` : ""}
                                        {previews.length > 1 ? " · " : ""}
                                        {((file?.size ?? 0) / 1024).toFixed(0)} KB
                                    </span>
                                    <div style={{ flex: 1 }} />
                                    {/* Zoom controls — mirror Compare's per-slot zoom UX so the user
                                        has the same muscle memory across both workspaces. */}
                                    {file && (
                                        <div style={{
                                            display: "inline-flex", alignItems: "center", gap: 4,
                                            padding: "2px 4px",
                                            background: "var(--color-bg-elevated)",
                                            border: "1px solid var(--color-border)",
                                            borderRadius: 6,
                                        }}>
                                            <button
                                                onClick={() => setZoomClamped(zoom - 0.25)}
                                                disabled={zoom <= 0.5}
                                                title={t("ocr.zoomOut")}
                                                style={{
                                                    background: "transparent", border: "none",
                                                    color: "var(--color-text-2)",
                                                    padding: "2px 6px", borderRadius: 4,
                                                    fontSize: 12, fontWeight: 700,
                                                    cursor: zoom <= 0.5 ? "not-allowed" : "pointer",
                                                    opacity: zoom <= 0.5 ? 0.4 : 1,
                                                }}
                                            >−</button>
                                            <button
                                                onClick={() => setZoom(1)}
                                                title={t("ocr.zoomReset")}
                                                style={{
                                                    background: "transparent", border: "none",
                                                    color: "var(--color-text-2)",
                                                    padding: "2px 6px", borderRadius: 4,
                                                    fontSize: 10.5, fontWeight: 600, minWidth: 38,
                                                    cursor: "pointer",
                                                }}
                                            >{Math.round(zoom * 100)}%</button>
                                            <button
                                                onClick={() => setZoomClamped(zoom + 0.25)}
                                                disabled={zoom >= 3}
                                                title={t("ocr.zoomIn")}
                                                style={{
                                                    background: "transparent", border: "none",
                                                    color: "var(--color-text-2)",
                                                    padding: "2px 6px", borderRadius: 4,
                                                    fontSize: 12, fontWeight: 700,
                                                    cursor: zoom >= 3 ? "not-allowed" : "pointer",
                                                    opacity: zoom >= 3 ? 0.4 : 1,
                                                }}
                                            >+</button>
                                        </div>
                                    )}
                                    {!loading && (
                                        <button
                                            onClick={resetWorkspace}
                                            style={{
                                                background: "transparent",
                                                border: "1px solid var(--color-border)",
                                                color: "var(--color-text-2)", borderRadius: 6,
                                                padding: "4px 10px", fontSize: 11.5, cursor: "pointer",
                                                display: "inline-flex", alignItems: "center", gap: 5,
                                            }}
                                        >
                                            <Icon.RefreshCw width={11} height={11} />
                                            {t("ocr.newDocument")}
                                        </button>
                                    )}
                                </div>

                                <div
                                    {...panZoom.containerProps}
                                    style={{
                                    // Always overflow:auto — the docx/image branch uses width:100%
                                    // height:auto, so a tall portrait scan needs vertical scroll at
                                    // zoom=1 too, not only when zoomed in.
                                    // `safe center` keeps the preview centered when it fits, but falls
                                    // back to `start` alignment once it overflows — without `safe`,
                                    // plain `center` puts the scrollbar origin in the middle of the
                                    // content, which clips the LEFT/TOP edge when scrolled to it.
                                    flex: 1, position: "relative",
                                    overflow: "auto",
                                    display: "flex",
                                    alignItems: "safe center",
                                    justifyContent: "safe center",
                                    background: "var(--color-bg-body)",
                                    ...panZoom.containerProps.style,
                                }}>
                                    {converting === "docx" && (
                                        <div style={{
                                            position: "absolute", inset: 0, zIndex: 5,
                                            display: "flex", alignItems: "center", justifyContent: "center",
                                            flexDirection: "column", gap: 8,
                                            background: "color-mix(in srgb, var(--color-bg-body) 85%, transparent)",
                                            color: "var(--color-text-2)", fontSize: 12.5,
                                        }}>
                                            <div style={{ width: 22, height: 22, border: "2px solid var(--color-border)", borderTopColor: ACCENT, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                                            {t("ocr.convertingDocx")}
                                        </div>
                                    )}
                                    {/* Scan-line overlay while OCR is running. Pure CSS; gated by a
                                        feature flag so we can revert by flipping a single constant. */}
                                    {ENABLE_OCR_SCAN_LINE && loading && file && (
                                        <div className="docroom-scan-line" aria-hidden />
                                    )}
                                    {file && isExcelFile(file) ? (
                                        <div style={{ position: "absolute", inset: 0 }}>
                                            {/* CSS `zoom` works here because ExcelPreview has its own
                                                scrollable container — no iframe + view-mode interaction. */}
                                            <div style={{ width: "100%", height: "100%", zoom: zoom as any }}>
                                                <ExcelPreview file={file} highlights={excelHighlights} />
                                            </div>
                                        </div>
                                    ) : previews[previewPage] && (
                                        // OCR-6c: PDF and image previews now share ONE code path.
                                        // Both render the actual raster pixels as `<img>` with
                                        // width:100% + height:auto, so the wrapper's client rect
                                        // == the rendered page rect. Hint fractions measured
                                        // against the wrapper ARE page-space fractions — no
                                        // letterbox, no wrapper-vs-page mismatch. Aspect ratio
                                        // comes from the actual rendered page dims (from pdfjs)
                                        // for PDFs; the browser derives it from the image intrinsic
                                        // size for docx/image previews.
                                        <div style={{
                                            width: `${100 * zoom}%`,
                                            flexShrink: 0,
                                            display: "block",
                                            position: "relative",  // anchor for bbox-hint overlay
                                            ...(previewPageAspect && previewPageAspect[previewPage]
                                                ? { aspectRatio: previewPageAspect[previewPage] }
                                                : null),
                                        }}>
                                            <img
                                                src={previews[previewPage]}
                                                alt="Preview"
                                                draggable={false}
                                                style={{
                                                    width: "100%", height: "auto",
                                                    display: "block",
                                                }}
                                            />
                                            <BboxHintLayer
                                                fields={extractFields}
                                                currentPage={previewPage + 1}
                                                editingFieldId={hintEditingFieldId}
                                                draw={hintDraw}
                                                onDrawUpdate={setHintDraw}
                                                onDrawCommit={(fid, r) => { commitHintDraw(fid, r); setHintDraw(null); setHintEditingFieldId(null); }}
                                            />
                                        </div>
                                    )}
                                    {previews.length > 1 && (
                                        <div style={{
                                            position: "absolute", bottom: 10, left: "50%",
                                            transform: "translateX(-50%)",
                                            background: "rgba(0,0,0,0.65)", color: "#fff",
                                            padding: "5px 12px", borderRadius: 20,
                                            display: "flex", alignItems: "center", gap: 12,
                                            fontSize: 11.5, fontWeight: 600,
                                            backdropFilter: "blur(4px)",
                                        }}>
                                            <button
                                                disabled={previewPage <= 0}
                                                onClick={() => setPreviewPage(p => p - 1)}
                                                style={{
                                                    background: "none", border: "none", color: "#fff",
                                                    cursor: previewPage <= 0 ? "not-allowed" : "pointer",
                                                    opacity: previewPage <= 0 ? 0.3 : 1,
                                                    display: "inline-flex",
                                                }}
                                            >
                                                <Icon.ChevronLeft width={14} height={14} />
                                            </button>
                                            <span>{previewPage + 1} / {previews.length}</span>
                                            <button
                                                disabled={previewPage >= previews.length - 1}
                                                onClick={() => setPreviewPage(p => p + 1)}
                                                style={{
                                                    background: "none", border: "none", color: "#fff",
                                                    cursor: previewPage >= previews.length - 1 ? "not-allowed" : "pointer",
                                                    opacity: previewPage >= previews.length - 1 ? 0.3 : 1,
                                                    display: "inline-flex",
                                                }}
                                            >
                                                <Icon.ChevronRight width={14} height={14} />
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {/* UI-1: page picker — only when the loaded doc is a multi-page
                                    PDF and we still have room to run (no result yet). Single-page
                                    PDFs, images, docx and xlsx don't render the picker. */}
                                {!result && showPagePicker && (
                                    <PagePicker
                                        previews={previews}
                                        pageCount={totalPagesInDoc}
                                        selectedPages={selectedPages}
                                        onToggle={togglePageSelection}
                                        onSelectAll={selectAllPages}
                                        onSelectNone={selectNonePages}
                                        max={PAGE_SELECTION_MAX}
                                        pickerHint={pickerHint}
                                        t={t}
                                    />
                                )}

                                {/* Extract CTA — only when no result yet */}
                                {!result && (
                                    <div style={{
                                        padding: "10px 12px",
                                        borderTop: "1px solid var(--color-border)",
                                        flexShrink: 0,
                                    }}>
                                        <button
                                            onClick={tryRun}
                                            disabled={loading || extractFields.length === 0 || (showPagePicker && selectedPages.length === 0)}
                                            title={showPagePicker && selectedPages.length === 0 ? t("ocr.pagePicker.selectAtLeastOne") : undefined}
                                            style={{
                                                width: "100%", padding: "10px 16px",
                                                background: (loading || extractFields.length === 0 || (showPagePicker && selectedPages.length === 0)) ? "var(--color-bg-elevated)" : ACCENT,
                                                color: (loading || extractFields.length === 0 || (showPagePicker && selectedPages.length === 0)) ? "var(--color-text-3)" : "#fff",
                                                border: "none", borderRadius: 8,
                                                fontSize: 13, fontWeight: 700,
                                                cursor: (loading || extractFields.length === 0 || (showPagePicker && selectedPages.length === 0)) ? "not-allowed" : "pointer",
                                                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                                            }}
                                        >
                                            {loading ? (
                                                <>
                                                    <div style={{
                                                        width: 14, height: 14,
                                                        border: "2px solid rgba(255,255,255,0.3)",
                                                        borderTopColor: "currentColor",
                                                        borderRadius: "50%",
                                                        animation: "spin 0.8s linear infinite",
                                                    }} />
                                                    {processingStep || t("ocr.extracting")}
                                                </>
                                            ) : (
                                                <>
                                                    <Icon.Zap width={14} height={14} />
                                                    {t("ocr.extractCta")} · {estimate.credits} {t("credits.label")}
                                                </>
                                            )}
                                        </button>
                                        {loading && progress > 0 && (
                                            <div style={{
                                                marginTop: 8, height: 3,
                                                background: "var(--color-bg-elevated)",
                                                borderRadius: 2, overflow: "hidden",
                                            }}>
                                                <div style={{
                                                    height: "100%", width: `${progress}%`,
                                                    background: ACCENT, transition: "width 0.4s",
                                                }} />
                                            </div>
                                        )}
                                        {/* Mini story — 5-step checklist driven by `progress`.
                                            Gated by a feature flag so we can revert by flipping
                                            the constant in featureFlags.ts. */}
                                        {ENABLE_LOADING_STORY && loading && progress > 0 && (
                                            <div style={{ marginTop: 10, padding: "8px 4px" }}>
                                                {LOADING_STORY_STEPS.map((step, i) => {
                                                    const prevEnd = i === 0 ? 0 : LOADING_STORY_STEPS[i - 1].endAt;
                                                    const state =
                                                        progress >= step.endAt ? "done"
                                                            : progress >= prevEnd ? "active"
                                                                : "pending";
                                                    return (
                                                        <div
                                                            key={step.key}
                                                            className={`docroom-story-step docroom-story-${state}`}
                                                        >
                                                            <span className="docroom-story-dot">
                                                                {state === "done" && (
                                                                    <Icon.Check width={10} height={10} />
                                                                )}
                                                            </span>
                                                            <span>{t(`ocr.${step.key}`)}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* ─ Result pane (shown when result OR error) ─ */}
                    {(result || error) && (
                        <div style={{
                            flex: 1, display: "flex", flexDirection: "column",
                            minHeight: 0, minWidth: 0,
                            background: "var(--color-bg-card)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 10, overflow: "hidden",
                        }}>
                            <div style={{
                                display: "flex", alignItems: "center", gap: 10,
                                padding: "8px 12px",
                                borderBottom: "1px solid var(--color-border)",
                                flexShrink: 0,
                            }}>
                                {error ? (
                                    <>
                                        <Icon.AlertCircle width={14} height={14} color="var(--color-danger)" />
                                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-1)" }}>
                                            {t("common.error")}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <Icon.CheckCircle width={14} height={14} color="var(--color-success)" />
                                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-1)" }}>
                                            {t("ocr.resultTitle")}
                                        </span>
                                        <span style={{
                                            fontSize: 10.5, padding: "2px 8px", borderRadius: 20,
                                            background: "rgba(16,185,129,0.13)",
                                            color: "var(--color-success)", fontWeight: 600,
                                        }}>
                                            {t("ocr.resultStatusSuccess")}
                                        </span>
                                        {docId && (
                                            <span style={{ fontSize: 10, color: "var(--color-text-4)", fontFamily: "monospace" }}>
                                                {docId.slice(0, 10)}…
                                            </span>
                                        )}
                                    </>
                                )}
                                <div style={{ flex: 1 }} />
                                {result && (
                                    <>
                                        <button
                                            onClick={() => exportData("excel")}
                                            style={{
                                                display: "inline-flex", alignItems: "center", gap: 5,
                                                padding: "5px 10px",
                                                background: "rgba(16,185,129,0.13)",
                                                border: "1px solid rgba(16,185,129,0.25)",
                                                borderRadius: 6, color: "var(--color-success)",
                                                fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                                            }}
                                        >
                                            <Icon.Download width={11} height={11} />
                                            {t("ocr.exportExcel")}
                                        </button>
                                        <button
                                            onClick={() => exportData("csv")}
                                            style={{
                                                display: "inline-flex", alignItems: "center", gap: 5,
                                                padding: "5px 10px",
                                                background: "rgba(59,130,246,0.13)",
                                                border: "1px solid rgba(59,130,246,0.25)",
                                                borderRadius: 6, color: "var(--color-info)",
                                                fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                                            }}
                                        >
                                            <Icon.Download width={11} height={11} />
                                            {t("ocr.exportCsv")}
                                        </button>
                                        <button
                                            onClick={() => setIsExpandedView(true)}
                                            title={t("ocr.expandView")}
                                            style={{
                                                display: "inline-flex", alignItems: "center", gap: 5,
                                                padding: "5px 10px",
                                                background: "rgba(99,102,241,0.13)",
                                                border: "1px solid rgba(99,102,241,0.25)",
                                                borderRadius: 6, color: "#818cf8",
                                                fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                                            }}
                                        >
                                            <Icon.Layers width={11} height={11} />
                                            {t("ocr.expandView")}
                                        </button>
                                        <button
                                            onClick={resetWorkspace}
                                            style={{
                                                display: "inline-flex", alignItems: "center", gap: 5,
                                                padding: "5px 10px",
                                                background: "transparent",
                                                border: "1px solid var(--color-border)",
                                                borderRadius: 6, color: "var(--color-text-2)",
                                                fontSize: 11.5, cursor: "pointer",
                                            }}
                                        >
                                            <Icon.RefreshCw width={11} height={11} />
                                            {t("ocr.newDocument")}
                                        </button>
                                    </>
                                )}
                            </div>

                            {/* Body */}
                            <div className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: 12 }}>
                                {error ? (
                                    <div style={{
                                        padding: 16, borderRadius: 8,
                                        background: "rgba(239,68,68,0.10)",
                                        border: "1px solid rgba(239,68,68,0.25)",
                                        color: "var(--color-danger)",
                                    }}>
                                        <p style={{ fontWeight: 600, marginBottom: 4 }}>{t("common.error")}</p>
                                        <p style={{ fontSize: 12 }}>{error}</p>
                                        <button
                                            onClick={() => setError(null)}
                                            style={{
                                                marginTop: 8, background: "none", border: "none",
                                                color: "var(--color-danger)", textDecoration: "underline",
                                                cursor: "pointer", fontSize: 11.5,
                                            }}
                                        >
                                            {t("common.close")}
                                        </button>
                                    </div>
                                ) : result && (
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                                        <thead>
                                            <tr style={{ background: "var(--color-bg-elevated)" }}>
                                                <th style={{ padding: "8px 12px", textAlign: "left", color: "var(--color-text-3)", fontSize: 10.5, fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase" }}>{t("ocr.resultField")}</th>
                                                <th style={{ padding: "8px 12px", textAlign: "left", color: "var(--color-text-3)", fontSize: 10.5, fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase" }}>{t("ocr.resultValue")}</th>
                                                <th style={{ padding: "8px 12px", textAlign: "center", color: "var(--color-text-3)", fontSize: 10.5, fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase" }}>{t("ocr.resultConfidence")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {Object.entries(result).map(([key, item]: [string, any], rowIdx) => {
                                                const val = (item && typeof item === "object" && "value" in item) ? item.value : item;
                                                const conf = (item && typeof item === "object" && "confidence" in item) ? Number(item.confidence) : null;
                                                // AI-reported spelling corrections. Prompt asks the model to
                                                // list every word it auto-corrected so the user can catch
                                                // wrong "helpful" edits (e.g. Plastelet → Platelet).
                                                const corrections: Array<{ original: string; corrected: string; reason?: string }> =
                                                    (item && typeof item === "object" && Array.isArray(item.corrections)) ? item.corrections : [];
                                                const confColor = conf == null
                                                    ? "var(--color-text-3)"
                                                    : conf >= 80 ? "var(--color-success)"
                                                    : conf >= 60 ? "var(--color-warning)"
                                                    : "var(--color-danger)";
                                                const isTable = Array.isArray(val);
                                                const typeHint = isTable ? "table" : "text";
                                                const c = TYPE_COLOR[typeHint] || ACCENT;
                                                const fmt = (v: any): string => {
                                                    if (v == null) return "";
                                                    if (Array.isArray(v)) return v.map(fmt).join(", ");
                                                    if (typeof v === "object") return Object.values(v).filter(x => x != null).map(fmt).join(" / ");
                                                    return String(v);
                                                };
                                                return (
                                                    <tr
                                                        key={key}
                                                        className={ENABLE_FIELD_POP ? "docroom-field-pop" : undefined}
                                                        style={{
                                                            borderTop: "1px solid var(--color-border)",
                                                            // Stagger each row by ~80ms; cap so 20+ field tables don't lag.
                                                            ...(ENABLE_FIELD_POP ? { animationDelay: `${Math.min(rowIdx, 14) * 0.08}s` } : {}),
                                                        }}
                                                    >
                                                        <td style={{ padding: "9px 12px", verticalAlign: "top" }}>
                                                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                                <span style={{
                                                                    fontSize: 9.5, background: `${c}22`, color: c,
                                                                    padding: "2px 6px", borderRadius: 4,
                                                                    fontWeight: 600, textTransform: "uppercase",
                                                                }}>{typeHint}</span>
                                                                <span style={{ color: "var(--color-text-2)" }}>{key.replace(/_/g, " ")}</span>
                                                                {corrections.length > 0 && (
                                                                    <span
                                                                        title={corrections.map(c => `"${c.original}" → "${c.corrected}"${c.reason ? ` (${c.reason})` : ""}`).join("\n")}
                                                                        style={{
                                                                            fontSize: 9.5, fontWeight: 700,
                                                                            background: "rgba(245,158,11,0.15)",
                                                                            color: "#f59e0b",
                                                                            padding: "2px 6px", borderRadius: 4,
                                                                            border: "1px solid rgba(245,158,11,0.35)",
                                                                            cursor: "help",
                                                                            display: "inline-flex", alignItems: "center", gap: 3,
                                                                        }}
                                                                    >
                                                                        ✎ แก้คำ {corrections.length}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {corrections.length > 0 && (
                                                                <div style={{
                                                                    marginTop: 4, fontSize: 10.5,
                                                                    color: "var(--color-text-3)",
                                                                    lineHeight: 1.4,
                                                                }}>
                                                                    {corrections.map((c, ci) => (
                                                                        <div key={ci}>
                                                                            <span style={{ textDecoration: "line-through", color: "var(--color-danger)" }}>{c.original}</span>
                                                                            {" → "}
                                                                            <span style={{ color: "var(--color-success)", fontWeight: 600 }}>{c.corrected}</span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </td>
                                                        <td style={{ padding: "9px 12px", color: "var(--color-text-1)", fontWeight: 500 }}>
                                                            {isTable ? (
                                                                <div style={{
                                                                    overflow: "auto",
                                                                    border: "1px solid var(--color-border)",
                                                                    borderRadius: 6,
                                                                }}>
                                                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                                                                        <thead>
                                                                            <tr style={{ background: "var(--color-bg-elevated)" }}>
                                                                                {val.length > 0 && Object.keys(val[0]).map(h => (
                                                                                    <th key={h} style={{
                                                                                        padding: "5px 8px", textAlign: "left",
                                                                                        color: "var(--color-text-3)",
                                                                                        fontSize: 10, textTransform: "uppercase",
                                                                                    }}>{h}</th>
                                                                                ))}
                                                                            </tr>
                                                                        </thead>
                                                                        <tbody>
                                                                            {val.map((row: any, ri: number) => (
                                                                                <tr key={ri} style={{ borderTop: "1px solid var(--color-border)" }}>
                                                                                    {Object.entries(row).map(([ck, cv], ci) => (
                                                                                        <td key={ci} style={{ padding: "2px 4px" }}>
                                                                                            <input
                                                                                                type="text"
                                                                                                value={fmt(cv)}
                                                                                                onChange={e => updateCell(key, ri, ck, e.target.value)}
                                                                                                style={{
                                                                                                    width: "100%",
                                                                                                    background: "transparent",
                                                                                                    border: "1px solid transparent",
                                                                                                    padding: "3px 6px",
                                                                                                    borderRadius: 4,
                                                                                                    color: "var(--color-text-1)",
                                                                                                    fontSize: 11.5, outline: "none",
                                                                                                }}
                                                                                            />
                                                                                        </td>
                                                                                    ))}
                                                                                </tr>
                                                                            ))}
                                                                        </tbody>
                                                                    </table>
                                                                </div>
                                                            ) : (() => {
                                                                // Multi-line values (address, long names) need a textarea
                                                                // to render \n visually — <input> collapses newlines.
                                                                const shown = fmt(val);
                                                                const isMulti = /\n/.test(shown);
                                                                const commonStyle: React.CSSProperties = {
                                                                    width: "100%",
                                                                    background: "transparent",
                                                                    border: "1px solid transparent",
                                                                    padding: "3px 6px", borderRadius: 4,
                                                                    color: "var(--color-text-1)",
                                                                    fontSize: 12.5, outline: "none",
                                                                };
                                                                return isMulti ? (
                                                                    <textarea
                                                                        value={shown}
                                                                        onChange={e => updateField(key, e.target.value)}
                                                                        placeholder="—"
                                                                        rows={Math.min(6, shown.split("\n").length)}
                                                                        style={{ ...commonStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.4 }}
                                                                    />
                                                                ) : (
                                                                    <input
                                                                        type="text"
                                                                        value={shown}
                                                                        onChange={e => updateField(key, e.target.value)}
                                                                        placeholder="—"
                                                                        style={commonStyle}
                                                                    />
                                                                );
                                                            })()}
                                                        </td>
                                                        <td style={{ padding: "9px 12px", textAlign: "center", verticalAlign: "top" }}>
                                                            {conf != null && (
                                                                <span style={{ fontSize: 11.5, fontWeight: 700, color: confColor }}>
                                                                    {conf}%
                                                                </span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Smart credit confirmation — only mounted when triggered */}
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
                    onConfirm={() => { setConfirmDialog(null); handleUpload(); }}
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
        </div>
    );
}

// ─── Template list group ─────────────────────────────────────────────────────
interface TemplateGroupProps {
    title: string;
    items: Template[];
    activeId: string | null;
    onPick: (t: Template) => void;
    onBookmark: (id: string, e: React.MouseEvent) => void;
    bookmarkedIds: string[];
    accent: string;
    onDelete?: (id: string, e: React.MouseEvent) => Promise<void>;
    /** Template id currently set as user's auto-load default. */
    defaultId?: string | null;
    /** Pin/unpin handler — passes id (or null to clear). */
    onSetDefault?: (id: string | null, e: React.MouseEvent) => void;
    pinLabel?: string;
    pinnedLabel?: string;
}

// ─── Bbox hint layer ─────────────────────────────────────────────────────────
// Overlays the document preview so the user can (a) see stored bbox_hint
// rectangles per field, and (b) drag out a new rectangle when a field is
// selected for editing. Uses percentage coords so it scales with the parent
// wrapper's zoom width. Mouse-events on the layer only intercept when a
// field is being edited — otherwise pointer-events fall through to the
// pan/zoom container so scroll + pan keep working.
interface BboxHintLayerProps {
    fields: ExtractField[];
    currentPage: number;
    editingFieldId: string | null;
    draw: { x0: number; y0: number; x1: number; y1: number } | null;
    onDrawUpdate: (d: { x0: number; y0: number; x1: number; y1: number } | null) => void;
    onDrawCommit: (fieldId: string, r: { x0: number; y0: number; x1: number; y1: number }) => void;
}
function BboxHintLayer({ fields, currentPage, editingFieldId, draw, onDrawUpdate, onDrawCommit }: BboxHintLayerProps) {
    const layerRef = useRef<HTMLDivElement>(null);
    const editing = fields.find(f => f.id === editingFieldId) || null;
    const isEditing = !!editing;

    const getRelCoords = (e: React.MouseEvent) => {
        const el = layerRef.current;
        if (!el) return { x: 0, y: 0 };
        const r = el.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
            y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
        };
    };

    return (
        <div
            ref={layerRef}
            onMouseDown={isEditing ? (e) => {
                e.preventDefault();
                const p = getRelCoords(e);
                onDrawUpdate({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
            } : undefined}
            onMouseMove={isEditing && draw ? (e) => {
                const p = getRelCoords(e);
                onDrawUpdate({ ...draw, x1: p.x, y1: p.y });
            } : undefined}
            onMouseUp={isEditing && draw && editing ? () => {
                onDrawCommit(editing.id, draw);
            } : undefined}
            style={{
                position: "absolute", inset: 0,
                pointerEvents: isEditing ? "auto" : "none",
                cursor: isEditing ? "crosshair" : "default",
                zIndex: 10,
                // subtle scrim while editing so user sees they're in draw mode
                background: isEditing ? "rgba(0,0,0,0.12)" : "transparent",
            }}
        >
            {/* Existing hints — visible always so user can see stored positions */}
            {fields.map(f => {
                const b = f.bbox_hint;
                if (!b) return null;
                if ((b.page || 1) !== currentPage) return null;
                const isEditingThis = editingFieldId === f.id;
                return (
                    <div key={f.id} style={{
                        position: "absolute",
                        left: `${b.x * 100}%`, top: `${b.y * 100}%`,
                        width: `${b.width * 100}%`, height: `${b.height * 100}%`,
                        border: `1.5px ${isEditingThis ? "dashed" : "solid"} rgba(220,38,38,0.85)`,
                        background: "rgba(220,38,38,0.08)",
                        borderRadius: 2,
                        pointerEvents: "none",
                    }}>
                        <span style={{
                            position: "absolute", top: -18, left: 0,
                            fontSize: 9, fontWeight: 700, background: "rgba(220,38,38,0.9)",
                            color: "#fff", padding: "1px 5px", borderRadius: 3,
                            whiteSpace: "nowrap",
                        }}>📍 {f.name}</span>
                    </div>
                );
            })}
            {/* Live drag preview */}
            {draw && isEditing && (
                <div style={{
                    position: "absolute",
                    left: `${Math.min(draw.x0, draw.x1) * 100}%`,
                    top: `${Math.min(draw.y0, draw.y1) * 100}%`,
                    width: `${Math.abs(draw.x1 - draw.x0) * 100}%`,
                    height: `${Math.abs(draw.y1 - draw.y0) * 100}%`,
                    border: "2px solid #dc2626",
                    background: "rgba(220,38,38,0.15)",
                    pointerEvents: "none",
                }} />
            )}
            {/* Instruction banner while editing */}
            {isEditing && !draw && (
                <div style={{
                    position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
                    background: "rgba(220,38,38,0.92)", color: "#fff",
                    padding: "4px 12px", borderRadius: 12,
                    fontSize: 11.5, fontWeight: 600,
                    pointerEvents: "none",
                    whiteSpace: "nowrap",
                }}>
                    📍 ลาก mouse เพื่อกำหนดตำแหน่งของ "{editing?.name}" · Esc = ยกเลิก
                </div>
            )}
        </div>
    );
}

// ─── Page picker (UI-1) ──────────────────────────────────────────────────────
// Thumbnail grid shown between the preview and the Extract CTA for multi-page
// PDFs. Reuses the per-page PNG blob URLs already produced by OCR-6c
// (`pdfRaster.result.pagePngs` → same blobs the preview `<img>` renders), so
// this component does NOT re-run pdfjs — thumbnails are byte-identical to the
// preview and cost nothing extra beyond the DOM. Selection is stored in the
// parent as 1-based ORIGINAL page numbers so it survives the API-1 Path A
// contract end-to-end.
interface PagePickerProps {
    previews: string[];
    pageCount: number;
    selectedPages: number[];
    onToggle: (page: number) => void;
    onSelectAll: () => void;
    onSelectNone: () => void;
    max: number;
    pickerHint: string | null;
    t: (key: string, vars?: Record<string, string | number>) => string;
}
function PagePicker({ previews, pageCount, selectedPages, onToggle, onSelectAll, onSelectNone, max, pickerHint, t }: PagePickerProps) {
    const over = pageCount > max;
    // Collapsed view hides thumbnails/banners and only shows header + counts +
    // toggle so the picker doesn't eat vertical space once the user has picked.
    const [collapsed, setCollapsed] = useState(false);
    return (
        <div
            style={{
                padding: "10px 12px",
                borderTop: "1px solid var(--color-border)",
                background: "var(--color-bg-surface)",
                flexShrink: 0,
                maxHeight: collapsed ? undefined : 220,
                overflowY: collapsed ? "visible" : "auto",
            }}
            className="custom-scrollbar"
        >
            <div style={{
                display: "flex", alignItems: "center", gap: 10,
                marginBottom: collapsed ? 0 : 8,
                flexWrap: "wrap",
            }}>
                <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
                    textTransform: "uppercase", color: "var(--color-text-3)",
                }}>
                    {t("ocr.pagePicker.title")}
                </span>
                <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                    {t("ocr.pagePicker.selectedCount", { n: selectedPages.length, max })}
                </span>
                <div style={{ flex: 1 }} />
                {!collapsed && (
                    <>
                        <button
                            onClick={onSelectAll}
                            style={{
                                background: "transparent",
                                border: "1px solid var(--color-border)",
                                color: "var(--color-text-2)", borderRadius: 6,
                                padding: "4px 10px", fontSize: 11, fontWeight: 600,
                                cursor: "pointer",
                            }}
                        >
                            {t("ocr.pagePicker.selectAll")}
                        </button>
                        <button
                            onClick={onSelectNone}
                            style={{
                                background: "transparent",
                                border: "1px solid var(--color-border)",
                                color: "var(--color-text-2)", borderRadius: 6,
                                padding: "4px 10px", fontSize: 11, fontWeight: 600,
                                cursor: "pointer",
                            }}
                        >
                            {t("ocr.pagePicker.selectNone")}
                        </button>
                    </>
                )}
                <button
                    onClick={() => setCollapsed(c => !c)}
                    title={collapsed ? t("ocr.pagePicker.expand") : t("ocr.pagePicker.collapse")}
                    style={{
                        background: "transparent",
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text-2)", borderRadius: 6,
                        padding: "4px 8px", fontSize: 11, fontWeight: 600,
                        cursor: "pointer",
                        display: "inline-flex", alignItems: "center", gap: 4,
                    }}
                >
                    <Icon.ChevronDown width={12} height={12} style={{ transform: collapsed ? "rotate(0deg)" : "rotate(180deg)", transition: "transform 0.15s" }} />
                    {collapsed ? t("ocr.pagePicker.expand") : t("ocr.pagePicker.collapse")}
                </button>
            </div>
            {!collapsed && over && (
                <div style={{
                    marginBottom: 8, padding: "6px 10px",
                    borderRadius: 6,
                    background: "rgba(245,158,11,0.13)",
                    border: "1px solid rgba(245,158,11,0.35)",
                    color: "#f59e0b", fontSize: 11.5, fontWeight: 600,
                }}>
                    {t("ocr.pagePicker.tooManyPagesWarning", { actual: pageCount, limit: max })}
                </div>
            )}
            {!collapsed && pickerHint && (
                <div style={{
                    marginBottom: 8, padding: "5px 10px",
                    borderRadius: 6,
                    background: "rgba(220,38,38,0.12)",
                    border: "1px solid rgba(220,38,38,0.3)",
                    color: "var(--color-danger)", fontSize: 11, fontWeight: 600,
                }}>
                    {pickerHint}
                </div>
            )}
            {!collapsed && <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                gap: 10,
            }}>
                {Array.from({ length: pageCount }, (_, i) => {
                    const page = i + 1;
                    const isSelected = selectedPages.includes(page);
                    const src = previews[i];
                    return (
                        <button
                            key={page}
                            onClick={() => onToggle(page)}
                            title={t("ocr.pagePicker.pageLabel", { n: page })}
                            style={{
                                position: "relative",
                                padding: 0,
                                background: "var(--color-bg-elevated)",
                                border: `2px solid ${isSelected ? "#6366f1" : "var(--color-border)"}`,
                                borderRadius: 8,
                                cursor: "pointer",
                                overflow: "hidden",
                                display: "flex", flexDirection: "column",
                                alignItems: "stretch",
                                boxShadow: isSelected ? "0 0 0 3px rgba(99,102,241,0.25)" : "none",
                                transition: "border-color 0.15s, box-shadow 0.15s, transform 0.1s",
                            }}
                        >
                            {src ? (
                                <img
                                    src={src}
                                    alt={t("ocr.pagePicker.pageLabel", { n: page })}
                                    draggable={false}
                                    style={{
                                        width: "100%", height: "auto",
                                        display: "block",
                                        background: "#ffffff",
                                        // Landscape/portrait render at their true aspect thanks
                                        // to OCR-6c — do not force a fixed height here.
                                    }}
                                />
                            ) : (
                                <div style={{
                                    aspectRatio: "210 / 297",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    color: "var(--color-text-4)", fontSize: 11,
                                }}>—</div>
                            )}
                            <div style={{
                                padding: "5px 8px",
                                fontSize: 10.5, fontWeight: 700,
                                color: isSelected ? "#6366f1" : "var(--color-text-3)",
                                textAlign: "center",
                                borderTop: "1px solid var(--color-border)",
                                background: "var(--color-bg-panel)",
                            }}>
                                {t("ocr.pagePicker.pageLabel", { n: page })}
                            </div>
                            {isSelected && (
                                <span style={{
                                    position: "absolute", top: 6, right: 6,
                                    width: 20, height: 20, borderRadius: "50%",
                                    background: "#6366f1", color: "#fff",
                                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                                    boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
                                    fontSize: 12, fontWeight: 700,
                                }}>
                                    <Icon.Check width={12} height={12} />
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>}
        </div>
    );
}

// ─── Batch panel ─────────────────────────────────────────────────────────────
// Replaces the preview + result area when the user queues 2+ files. Renders
// a per-file list with status badges + overall progress + a "Download
// summary" action that bundles every successful result into one xlsx/csv.
interface BatchPanelProps {
    items: Array<{
        id: string;
        file: File;
        status: "queued" | "processing" | "done" | "error" | "skipped";
        data?: Record<string, any> | null;
        error?: string;
    }>;
    running: boolean;
    onRun: () => void;
    onDownload: (format: "excel" | "csv") => void;
    onRemove: (id: string) => void;
    onAddMore: () => void;
    onClearAll: () => void;
    t: (key: string, vars?: Record<string, string | number>) => string;
    accent: string;
}
function BatchPanel({ items, running, onRun, onDownload, onRemove, onAddMore, onClearAll, t, accent }: BatchPanelProps) {
    const counts = {
        total: items.length,
        done: items.filter(i => i.status === "done").length,
        error: items.filter(i => i.status === "error").length,
        skipped: items.filter(i => i.status === "skipped").length,
        processing: items.filter(i => i.status === "processing").length,
    };
    const finished = counts.done + counts.error + counts.skipped;
    const allFinished = !running && finished === counts.total && counts.total > 0;
    const hasResults = counts.done > 0;

    const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
        queued:     { color: "var(--color-text-3)", bg: "var(--color-bg-elevated)", label: t("ocr.batchStatus.queued") },
        processing: { color: "#f59e0b",            bg: "rgba(245,158,11,0.13)",     label: t("ocr.batchStatus.processing") },
        done:       { color: "#10b981",            bg: "rgba(16,185,129,0.13)",     label: t("ocr.batchStatus.done") },
        error:      { color: "#ef4444",            bg: "rgba(239,68,68,0.13)",      label: t("ocr.batchStatus.error") },
        skipped:    { color: "#94a3b8",            bg: "rgba(148,163,184,0.13)",    label: t("ocr.batchStatus.skipped") },
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* Header — title + counters + actions */}
            <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px",
                borderBottom: "1px solid var(--color-border)",
                background: "var(--color-bg-surface)",
            }}>
                <strong style={{ fontSize: 13, color: "var(--color-text-1)" }}>
                    {t("ocr.batchTitle")} · {counts.total} {t("common.files")}
                </strong>
                <span style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
                    {t("ocr.batchProgress", { done: finished, total: counts.total })}
                </span>
                <div style={{ flex: 1 }} />
                <button
                    onClick={onAddMore}
                    disabled={running}
                    style={{
                        background: "transparent", border: "1px solid var(--color-border)",
                        color: "var(--color-text-2)", borderRadius: 6,
                        padding: "5px 11px", fontSize: 11.5, fontWeight: 600,
                        cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.5 : 1,
                    }}
                >+ {t("ocr.batchAddMore")}</button>
                <button
                    onClick={onClearAll}
                    disabled={running}
                    style={{
                        background: "transparent", border: "1px solid var(--color-border)",
                        color: "var(--color-text-2)", borderRadius: 6,
                        padding: "5px 11px", fontSize: 11.5,
                        cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.5 : 1,
                    }}
                >{t("ocr.batchClearAll")}</button>
            </div>

            {/* File list */}
            <div className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: 10 }}>
                {/* Inline results table — union of scalar fields across every
                    "done" item, one row per file. Mirrors what the Excel export
                    Summary sheet shows, so users can inspect without exporting. */}
                {hasResults && (() => {
                    const fieldKeys: string[] = [];
                    const seen = new Set<string>();
                    for (const it of items) {
                        if (it.status !== "done" || !it.data) continue;
                        for (const [k, v] of Object.entries(it.data)) {
                            if (seen.has(k)) continue;
                            const val = (v && typeof v === "object" && "value" in v) ? (v as any).value : v;
                            // Skip table-type values — they'd blow up the row height.
                            if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") continue;
                            seen.add(k);
                            fieldKeys.push(k);
                        }
                    }
                    const fmt = (v: any): string => {
                        if (v == null) return "";
                        const inner = (v && typeof v === "object" && "value" in v) ? v.value : v;
                        if (inner == null) return "";
                        if (Array.isArray(inner)) return `[${inner.length} rows]`;
                        return String(inner);
                    };
                    if (fieldKeys.length === 0) return null;
                    return (
                        <div style={{
                            marginBottom: 12,
                            border: "1px solid var(--color-border)",
                            borderRadius: 8, overflow: "hidden",
                        }}>
                            <div style={{
                                padding: "6px 10px", fontSize: 10.5, fontWeight: 700,
                                letterSpacing: 0.8, textTransform: "uppercase",
                                color: "var(--color-text-3)",
                                background: "var(--color-bg-surface)",
                                borderBottom: "1px solid var(--color-border)",
                            }}>
                                {t("ocr.batchResultsTitle")} · {counts.done}/{counts.total}
                            </div>
                            <div style={{ overflowX: "auto" }}>
                                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                                    <thead>
                                        <tr style={{ background: "var(--color-bg-elevated)" }}>
                                            <th style={{ padding: "6px 10px", textAlign: "left", color: "var(--color-text-3)", fontSize: 10, textTransform: "uppercase", fontWeight: 600, position: "sticky", left: 0, background: "var(--color-bg-elevated)", zIndex: 1 }}>{t("ocr.batchResultsFile")}</th>
                                            {fieldKeys.map(k => (
                                                <th key={k} style={{ padding: "6px 10px", textAlign: "left", color: "var(--color-text-3)", fontSize: 10, textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap" }}>{k}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {items.filter(it => it.status === "done" && it.data).map(it => (
                                            <tr key={it.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                                                <td style={{ padding: "6px 10px", color: "var(--color-text-1)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180, position: "sticky", left: 0, background: "var(--color-bg-panel)", zIndex: 1 }} title={it.file.name}>
                                                    {it.file.name}
                                                </td>
                                                {fieldKeys.map(k => (
                                                    <td key={k} style={{ padding: "6px 10px", color: "var(--color-text-2)", verticalAlign: "top", maxWidth: 260, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                                        {fmt(it.data?.[k])}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    );
                })()}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {items.map(it => {
                        const st = STATUS_STYLE[it.status];
                        return (
                            <div key={it.id} style={{
                                display: "flex", alignItems: "center", gap: 10,
                                padding: "8px 10px",
                                background: "var(--color-bg-elevated)",
                                border: "1px solid var(--color-border)",
                                borderRadius: 7,
                            }}>
                                <Icon.FileText width={14} height={14} color={accent} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{
                                        fontSize: 12, fontWeight: 600, color: "var(--color-text-1)",
                                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                    }}>{it.file.name}</div>
                                    <div style={{ fontSize: 10.5, color: "var(--color-text-3)", marginTop: 1 }}>
                                        {(it.file.size / 1024).toFixed(0)} KB
                                        {it.error ? <span style={{ color: "#ef4444", marginLeft: 6 }}>· {it.error}</span> : null}
                                    </div>
                                </div>
                                <span style={{
                                    fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
                                    padding: "3px 8px", borderRadius: 4,
                                    background: st.bg, color: st.color,
                                    textTransform: "uppercase",
                                }}>{st.label}</span>
                                {!running && it.status !== "processing" && (
                                    <button
                                        onClick={() => onRemove(it.id)}
                                        title={t("ocr.batchRemoveFile")}
                                        style={{
                                            background: "none", border: "none",
                                            color: "var(--color-text-3)", cursor: "pointer",
                                            padding: 2, display: "inline-flex",
                                        }}
                                    ><Icon.X width={12} height={12} /></button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Footer — run / download */}
            <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 14px",
                borderTop: "1px solid var(--color-border)",
                background: "var(--color-bg-surface)",
            }}>
                <span style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
                    {counts.done > 0 && <span style={{ color: "#10b981", marginRight: 8 }}>✓ {counts.done} {t("ocr.batchStatus.done")}</span>}
                    {counts.error > 0 && <span style={{ color: "#ef4444", marginRight: 8 }}>✗ {counts.error} {t("ocr.batchStatus.error")}</span>}
                    {counts.skipped > 0 && <span style={{ color: "#94a3b8" }}>· {counts.skipped} {t("ocr.batchStatus.skipped")}</span>}
                </span>
                <div style={{ flex: 1 }} />
                {!allFinished ? (
                    <button
                        onClick={onRun}
                        disabled={running || items.length === 0}
                        style={{
                            background: accent, color: "#fff",
                            border: "none", borderRadius: 7,
                            padding: "7px 16px", fontSize: 12.5, fontWeight: 700,
                            cursor: (running || items.length === 0) ? "not-allowed" : "pointer",
                            opacity: (running || items.length === 0) ? 0.6 : 1,
                            display: "inline-flex", alignItems: "center", gap: 6,
                        }}
                    >
                        {running ? (
                            <>
                                <div style={{ width: 11, height: 11, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                                {t("ocr.batchRunning")}
                            </>
                        ) : (
                            <>
                                <Icon.Zap width={12} height={12} />
                                {t("ocr.batchRunAll")}
                            </>
                        )}
                    </button>
                ) : (
                    <>
                        <button
                            onClick={() => onDownload("excel")}
                            disabled={!hasResults}
                            style={{
                                background: "rgba(16,185,129,0.13)",
                                border: "1px solid rgba(16,185,129,0.25)",
                                color: hasResults ? "#10b981" : "var(--color-text-3)",
                                borderRadius: 7, padding: "6px 12px",
                                fontSize: 11.5, fontWeight: 600,
                                cursor: hasResults ? "pointer" : "not-allowed",
                                opacity: hasResults ? 1 : 0.5,
                                display: "inline-flex", alignItems: "center", gap: 5,
                            }}
                        >
                            <Icon.Download width={11} height={11} />
                            {t("ocr.batchDownloadExcel")}
                        </button>
                        <button
                            onClick={() => onDownload("csv")}
                            disabled={!hasResults}
                            style={{
                                background: "rgba(59,130,246,0.13)",
                                border: "1px solid rgba(59,130,246,0.25)",
                                color: hasResults ? "var(--color-info)" : "var(--color-text-3)",
                                borderRadius: 7, padding: "6px 12px",
                                fontSize: 11.5, fontWeight: 600,
                                cursor: hasResults ? "pointer" : "not-allowed",
                                opacity: hasResults ? 1 : 0.5,
                                display: "inline-flex", alignItems: "center", gap: 5,
                            }}
                        >
                            <Icon.Download width={11} height={11} />
                            {t("ocr.batchDownloadCsv")}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function TemplateGroup({ title, items, activeId, onPick, onBookmark, bookmarkedIds, accent, onDelete, defaultId, onSetDefault, pinLabel = "Set as default", pinnedLabel = "Default" }: TemplateGroupProps) {
    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 1.1,
                color: "var(--color-text-4)", textTransform: "uppercase",
                padding: "4px 6px 6px",
            }}>
                {title}
            </div>
            {items.map(tpl => {
                const active = activeId === tpl.id;
                const bookmarked = bookmarkedIds.includes(tpl.id);
                const isDefault = defaultId === tpl.id;
                return (
                    <div key={tpl.id} style={{ position: "relative" }}>
                        <button
                            onClick={() => onPick(tpl)}
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
                            }}
                        >
                            <span style={{
                                width: 6, height: 6, borderRadius: "50%",
                                background: active ? accent : "var(--color-text-4)",
                                flexShrink: 0,
                            }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {tpl.name.split(" (")[0]}
                            </span>
                            {isDefault && (
                                <span style={{
                                    fontSize: 8.5, fontWeight: 700,
                                    background: `${accent}22`, color: accent,
                                    padding: "1px 5px", borderRadius: 8,
                                    letterSpacing: 0.5, textTransform: "uppercase",
                                    flexShrink: 0,
                                }}>
                                    {pinnedLabel}
                                </span>
                            )}
                        </button>
                        <div style={{
                            position: "absolute", right: 4, top: "50%",
                            transform: "translateY(-50%)",
                            display: "flex", gap: 0,
                        }}>
                            {onSetDefault && (
                                <button
                                    onClick={(e) => onSetDefault(isDefault ? null : tpl.id, e)}
                                    title={isDefault ? `${pinnedLabel} (คลิกเพื่อยกเลิก)` : pinLabel}
                                    style={{
                                        background: "none", border: "none",
                                        color: isDefault ? accent : "var(--color-text-4)",
                                        cursor: "pointer", padding: 3,
                                        display: "inline-flex",
                                    }}
                                >
                                    <Icon.Pin width={11} height={11} />
                                </button>
                            )}
                            <button
                                onClick={(e) => onBookmark(tpl.id, e)}
                                title="Bookmark"
                                style={{
                                    background: "none", border: "none",
                                    color: bookmarked ? "#f59e0b" : "var(--color-text-4)",
                                    cursor: "pointer", padding: 3,
                                    display: "inline-flex",
                                }}
                            >
                                <Icon.Star width={11} height={11} />
                            </button>
                            {onDelete && (
                                <button
                                    onClick={(e) => onDelete(tpl.id, e)}
                                    title="Delete"
                                    style={{
                                        background: "none", border: "none",
                                        color: "var(--color-text-4)", cursor: "pointer",
                                        padding: 3, display: "inline-flex",
                                    }}
                                >
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
