"use client";
// OCRBatchViewV2 — UI-7 implementation (2026-07-14).
//
// Decision log: `pm/reports/UI-7-decisions.md` (D1-D8 locked 2026-07-14).
// Replaces the UI-4c stopgap where v2 embedded `OCRWorkspaceV1` verbatim
// whenever the topbar mode-switch was flipped to "batch". This component
// keeps the v2 look (stepper, panels, cards) while owning batch state
// natively — no v1 embed, no `?mode=batch` URL routing.
//
// Scope invariants (see UI-7-decisions.md):
//  - D1: shared 6-step stepper for the whole batch.
//  - D2: shared template + field list across every queued file.
//  - D3: per-file page picker, horizontal file tabs, default = auto up to cap.
//  - D4: sequential extraction, 500ms inter-file delay to pace CF/AI RL.
//  - D5: fulldoc + batch allowed; credit dialog shows per-file breakdown.
//  - D6: results = spreadsheet (rows = files, cols = fields) + click → drawer.
//  - D7: retry per file (whole file), reuses OCR-3 retry temp 0.6.
//  - D8: no v1 embed. Rollback path = `ENABLE_OCR_WORKSPACE_V2 = false`.
//
// Credit charge semantics — file-by-file via `/api/upload` (matches v1):
//  file 5 error after files 1-4 charged = files 1-4 stay charged. Refund
//  only fires server-side on AI-side failure (API-4b `refundCreditsAtomic`).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@/lib/types";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { apiError } from "@/lib/friendlyError";
import { fetchJson } from "@/lib/fetchJson";
import { ErrorCode } from "@/lib/errorCodes";
import { pdfFileToImageDetailed, type PdfRasterResult, type StackedPageRect, DEFAULT_TARGET_LONG_EDGE } from "@/lib/pdf-to-image";
import { docxFileToImage } from "@/lib/docx-to-image";
import { buildFieldCrops, CROP_DPI_SCALE, interleaveDualScaleCrops } from "@/lib/field-crops";
import { ENABLE_DUAL_SCALE_CROPS } from "@/lib/featureFlags";
import { estimateCredits, type CreditModel, DEFAULT_CREDIT_MODEL } from "@/lib/pricing";
import { exportOCRBatch, type BatchResult } from "@/lib/exportUtils";
import { PAGE_SELECTION_MAX, MAX_BATCH_FILES, MAX_UPLOAD_SIZE_BYTES, MAX_UPLOAD_SIZE_MB, PER_FILE_TIMEOUT_MS, POLL_INTERVAL_MS } from "@/lib/ocrBatchConfig";
import { evaluateConfirm, makeFingerprint, shouldSkipDialog } from "@/lib/credit-preferences";
import CreditConfirmDialog from "./CreditConfirmDialog";
import TemplatePickerPanel from "./TemplatePickerPanel";

// D4: pacing constant. Between-file sleep before firing the next /api/upload
// on the same batch. Kept small enough that a 10-file batch adds only ~5 s of
// artificial delay but large enough to keep CF/AI RL headroom for headers.
const BATCH_INTER_FILE_DELAY_MS = 500;

interface FieldBboxHint { x: number; y: number; width: number; height: number; page?: number; space?: "page"; }
interface ExtractField {
    id: string;
    name: string;
    type: "text" | "number" | "currency" | "date" | "address" | "email" | "table" | "raw_text";
    bbox_hint?: FieldBboxHint;
}
interface Template { id: string; name: string; fields_json: string; user_id?: string; }
interface OCRResult { [key: string]: any; }
type Stage = "upload" | "pages" | "fields" | "run" | "results" | "export";
type ExtractMode = "field" | "fulldoc";
type BatchStatus = "pending" | "extracting" | "done" | "error";

interface BatchFile {
    id: string;
    file: File;                              // may be re-assigned after DOCX flatten
    displayName: string;
    previewUrl: string | null;
    pdfRaster: PdfRasterResult | null;
    pageCount: number;
    selectedPages: number[];
    result: OCRResult | null;
    fulldocResult: { pages: { page: number; text: string }[] } | null;
    status: BatchStatus;
    error?: string;
    progress: number;                        // 0..100 for the currently-active row
    attempt: "initial" | "retry";
}

const STAGE_ORDER: Stage[] = ["upload", "pages", "fields", "run", "results", "export"];

const TYPE_COLOR: Record<string, string> = {
    text: "#6366f1", number: "#f59e0b", currency: "#10b981", date: "#3b82f6",
    address: "#8b5cf6", email: "#06b6d4", table: "#ec4899", raw_text: "#dc2626",
};

interface Props {
    user: User | null;
    balance?: number;
    onDocumentProcessed?: () => void;
    onNavigateToBilling?: () => void;
    /** Header slot — the parent (v2 workspace) still owns the ModeSwitch chip
     *  so flipping back to single-file is 1 click regardless of which stage
     *  the batch is on. */
    headerRight?: React.ReactNode;
}

export default function OCRBatchViewV2({ user, balance = 0, onDocumentProcessed, onNavigateToBilling, headerRight }: Props) {
    const { t } = useTranslation();

    // ── File queue ─────────────────────────────────────────────────────────
    const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
    const [activeBatchFileId, setActiveBatchFileId] = useState<string | null>(null);
    const dropRef = useRef<HTMLDivElement>(null);

    // ── Templates + fields (D2: shared across every file) ─────────────────
    const [templates, setTemplates] = useState<Template[]>([]);
    const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
    const [extractFields, setExtractFields] = useState<ExtractField[]>([
        { id: "1", name: t("ocr.defaultCompany"), type: "text" },
        { id: "2", name: t("ocr.defaultTaxId"), type: "number" },
        { id: "3", name: t("ocr.defaultAddress"), type: "address" },
        { id: "4", name: t("ocr.defaultTotal"), type: "currency" },
        { id: "5", name: t("ocr.defaultDate"), type: "date" },
    ]);
    const [newFieldName, setNewFieldName] = useState("");
    const [newFieldType, setNewFieldType] = useState<ExtractField["type"]>("text");
    const [extractMode, setExtractMode] = useState<ExtractMode>("field");

    // UI-7 UAT r1 (F2): template picker state — mirrors OCRWorkspaceV2. Batch
    // has ONE shared template across every file (D2), so dirty-tracking and
    // save semantics apply to the single shared `extractFields` list.
    const [favoriteTemplateIds, setFavoriteTemplateIds] = useState<string[]>([]);
    const [recentTemplateIds, setRecentTemplateIds] = useState<string[]>([]);
    const [templateSearch, setTemplateSearch] = useState("");
    const [defaultOcrTemplateId, setDefaultOcrTemplateId] = useState<string | null>(null);
    const [loadedTemplateSnapshot, setLoadedTemplateSnapshot] = useState<string | null>(null);
    const [saveAsNewOpen, setSaveAsNewOpen] = useState(false);
    const [newTemplateName, setNewTemplateName] = useState("");
    const [savingTemplate, setSavingTemplate] = useState(false);

    useEffect(() => {
        if (!user) return;
        fetch(`/api/templates?userId=${user.id}`).then(r => r.json())
            .then((d: any) => { if (Array.isArray(d)) setTemplates(d); })
            .catch(() => { /* best-effort */ });
    }, [user]);

    // Persisted picker prefs (localStorage keys match v2 workspace — shared).
    useEffect(() => {
        if (typeof localStorage === "undefined") return;
        try {
            const fav = JSON.parse(localStorage.getItem("ocr_v2_favorite_template_ids") || "[]");
            if (Array.isArray(fav)) setFavoriteTemplateIds(fav.filter((x: any) => typeof x === "string"));
        } catch { /* ignore */ }
        try {
            const rec = JSON.parse(localStorage.getItem("ocr_v2_recent_template_ids") || "[]");
            if (Array.isArray(rec)) setRecentTemplateIds(rec.filter((x: any) => typeof x === "string").slice(0, 3));
        } catch { /* ignore */ }
    }, []);
    useEffect(() => {
        if (typeof localStorage === "undefined") return;
        try { localStorage.setItem("ocr_v2_favorite_template_ids", JSON.stringify(favoriteTemplateIds)); } catch {}
    }, [favoriteTemplateIds]);
    useEffect(() => {
        if (typeof localStorage === "undefined") return;
        try { localStorage.setItem("ocr_v2_recent_template_ids", JSON.stringify(recentTemplateIds)); } catch {}
    }, [recentTemplateIds]);

    // Default OCR template — reuse existing /api/user-prefs field.
    useEffect(() => {
        if (!user) return;
        fetchJson<{ defaultOcrTemplateId: string | null }>(`/api/user-prefs?userId=${user.id}`)
            .then(r => { if (r.ok) setDefaultOcrTemplateId(r.defaultOcrTemplateId); })
            .catch(() => { /* best-effort */ });
    }, [user]);

    const templateDirty = useMemo(() => {
        if (!activeTemplateId || !loadedTemplateSnapshot) return false;
        return JSON.stringify(extractFields) !== loadedTemplateSnapshot;
    }, [activeTemplateId, loadedTemplateSnapshot, extractFields]);

    const activeTemplateName = useMemo(() => {
        if (!activeTemplateId) return null;
        return templates.find(x => x.id === activeTemplateId)?.name || null;
    }, [activeTemplateId, templates]);

    const toggleFavoriteTemplate = useCallback((id: string) => {
        setFavoriteTemplateIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    }, []);

    // ── Stage / frontier ──────────────────────────────────────────────────
    const [currentStage, setCurrentStageRaw] = useState<Stage>("upload");
    const [maxReachedStage, setMaxReachedStage] = useState<Stage>("upload");
    const setCurrentStage = useCallback((s: Stage) => {
        setCurrentStageRaw(s);
        setMaxReachedStage(prev => STAGE_ORDER.indexOf(s) > STAGE_ORDER.indexOf(prev) ? s : prev);
    }, []);

    // ── Run state ─────────────────────────────────────────────────────────
    const [batchRunning, setBatchRunning] = useState(false);
    const [globalError, setGlobalError] = useState<string | null>(null);
    const [inspectorCell, setInspectorCell] = useState<{ fileId: string; fieldKey: string } | null>(null);
    const [activeCreditModel] = useState<CreditModel>(DEFAULT_CREDIT_MODEL);

    // ── Credit-confirm dialog ─────────────────────────────────────────────
    const [confirmDialog, setConfirmDialog] = useState<{
        reasons: any[]; fingerprint: string; steps: { label: string; value: string }[]; credits: number;
        onProceed: () => void;
    } | null>(null);

    // Cleanup previews on unmount / change.
    useEffect(() => {
        return () => {
            batchFiles.forEach(bf => { if (bf.previewUrl) URL.revokeObjectURL(bf.previewUrl); });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── File intake ───────────────────────────────────────────────────────
    const addFiles = useCallback(async (fl: FileList | File[]) => {
        const incoming = Array.from(fl);
        if (incoming.length === 0) return;
        const remaining = MAX_BATCH_FILES - batchFiles.length;
        if (remaining <= 0) {
            setGlobalError(t("ocr.v2.batch.limitReached", { max: MAX_BATCH_FILES }));
            return;
        }
        const toTake = incoming.slice(0, remaining);
        // Sync stub rows first — page count / preview populated async below.
        const rows: BatchFile[] = toTake.map((f, i) => {
            const oversize = f.size > MAX_UPLOAD_SIZE_BYTES;
            return {
                id: `bf-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
                file: f,
                displayName: f.name,
                previewUrl: null,
                pdfRaster: null,
                pageCount: 1,
                selectedPages: [1],
                result: null,
                fulldocResult: null,
                status: oversize ? "error" : "pending",
                error: oversize ? t("ocr.v2.batch.tooLarge", { mb: MAX_UPLOAD_SIZE_MB }) : undefined,
                progress: 0,
                attempt: "initial",
            };
        });
        setBatchFiles(prev => [...prev, ...rows]);
        setActiveBatchFileId(prev => prev ?? rows[0]?.id ?? null);
        // Kick off preview + page-count enrichment per file.
        for (const row of rows) {
            if (row.status === "error") continue;
            enrichRowAsync(row.id, row.file);
        }
    }, [batchFiles.length, t]); // eslint-disable-line react-hooks/exhaustive-deps

    // Async post-add enrichment: rasterize PDF for page count + preview.
    const enrichRowAsync = useCallback(async (rowId: string, f: File) => {
        const isDocx = f.name.toLowerCase().endsWith(".docx");
        const isPdf = f.type === "application/pdf";
        try {
            if (isDocx) {
                const imgFile = await docxFileToImage(f);
                const url = URL.createObjectURL(imgFile);
                setBatchFiles(prev => prev.map(bf => bf.id === rowId
                    ? { ...bf, file: imgFile, previewUrl: url, pageCount: 1, selectedPages: [1] }
                    : bf));
                return;
            }
            if (isPdf) {
                const raster = await pdfFileToImageDetailed(f);
                const total = raster.pagePngs.length;
                const url = URL.createObjectURL(raster.pagePngs[0]);
                const n = Math.min(total, PAGE_SELECTION_MAX);
                const auto = Array.from({ length: n }, (_, i) => i + 1);
                setBatchFiles(prev => prev.map(bf => bf.id === rowId
                    ? { ...bf, pdfRaster: raster, pageCount: total, previewUrl: url, selectedPages: auto }
                    : bf));
                return;
            }
            const url = URL.createObjectURL(f);
            setBatchFiles(prev => prev.map(bf => bf.id === rowId
                ? { ...bf, previewUrl: url, pageCount: 1, selectedPages: [1] }
                : bf));
        } catch (e) {
            console.warn("[batch] enrichment failed", e);
            setBatchFiles(prev => prev.map(bf => bf.id === rowId
                ? { ...bf, status: "error", error: t("ocr.v2.batch.previewFailed") }
                : bf));
        }
    }, [t]);

    const removeRow = useCallback((rowId: string) => {
        setBatchFiles(prev => {
            const row = prev.find(bf => bf.id === rowId);
            if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
            return prev.filter(bf => bf.id !== rowId);
        });
        setActiveBatchFileId(prev => prev === rowId ? null : prev);
    }, []);

    // Drop + input plumbing.
    useEffect(() => {
        const el = dropRef.current;
        if (!el) return;
        const prevent = (e: DragEvent) => e.preventDefault();
        const onDrop = (e: DragEvent) => {
            e.preventDefault();
            const fl = e.dataTransfer?.files;
            if (fl && fl.length > 0) addFiles(fl);
        };
        el.addEventListener("dragover", prevent);
        el.addEventListener("drop", onDrop);
        return () => { el.removeEventListener("dragover", prevent); el.removeEventListener("drop", onDrop); };
    }, [addFiles]);

    // ── Templates + fields helpers ────────────────────────────────────────
    const applyTemplate = useCallback((id: string | null) => {
        if (!id) {
            setActiveTemplateId(null);
            setLoadedTemplateSnapshot(null);
            return;
        }
        const tpl = templates.find(x => x.id === id);
        if (!tpl) return;
        try {
            const fields = JSON.parse(tpl.fields_json);
            if (Array.isArray(fields)) {
                setExtractFields(fields);
                setLoadedTemplateSnapshot(JSON.stringify(fields));
            }
        } catch { /* skip */ }
        setActiveTemplateId(id);
        setRecentTemplateIds(prev => [id, ...prev.filter(x => x !== id)].slice(0, 3));
    }, [templates]);

    const saveAsNewTemplate = useCallback(async () => {
        if (!user || !newTemplateName.trim()) return;
        setSavingTemplate(true);
        try {
            const res = await fetch("/api/templates", {
                method: "POST",
                body: JSON.stringify({ userId: user.id, name: newTemplateName.trim(), fields: extractFields }),
            });
            const data = await res.json() as any;
            const newId = data?.id || data?.template?.id;
            const newTpl: Template = {
                id: newId || crypto.randomUUID(),
                name: newTemplateName.trim(),
                fields_json: JSON.stringify(extractFields),
                user_id: user.id,
            };
            setTemplates(prev => [...prev, newTpl]);
            setActiveTemplateId(newTpl.id);
            setLoadedTemplateSnapshot(JSON.stringify(extractFields));
            setRecentTemplateIds(prev => [newTpl.id, ...prev.filter(x => x !== newTpl.id)].slice(0, 3));
            setNewTemplateName("");
            setSaveAsNewOpen(false);
        } catch (e) {
            console.warn("[batch save-new-template] failed", e);
        } finally {
            setSavingTemplate(false);
        }
    }, [user, newTemplateName, extractFields]);

    const updateActiveTemplate = useCallback(async () => {
        if (!user || !activeTemplateId) return;
        const tpl = templates.find(x => x.id === activeTemplateId);
        if (!tpl) return;
        setSavingTemplate(true);
        try {
            await fetch("/api/templates", {
                method: "POST",
                body: JSON.stringify({ userId: user.id, name: tpl.name, fields: extractFields, id: activeTemplateId }),
            });
            const updated = { ...tpl, fields_json: JSON.stringify(extractFields) };
            setTemplates(prev => prev.map(t2 => t2.id === activeTemplateId ? updated : t2));
            setLoadedTemplateSnapshot(JSON.stringify(extractFields));
        } catch (e) {
            console.warn("[batch update-template] failed", e);
        } finally {
            setSavingTemplate(false);
        }
    }, [user, activeTemplateId, templates, extractFields]);

    const deleteTemplate = useCallback(async (id: string) => {
        if (!user) return;
        const tpl = templates.find(x => x.id === id);
        if (!tpl) return;
        if (tpl.user_id === "system" || id.startsWith("global-")) return;
        const prevList = templates;
        setTemplates(prev => prev.filter(x => x.id !== id));
        if (activeTemplateId === id) {
            setActiveTemplateId(null);
            setLoadedTemplateSnapshot(null);
        }
        setFavoriteTemplateIds(prev => prev.filter(x => x !== id));
        setRecentTemplateIds(prev => prev.filter(x => x !== id));
        if (defaultOcrTemplateId === id) setDefaultOcrTemplateId(null);
        try {
            const res = await fetchJson<{ success?: boolean }>(
                `/api/templates?id=${encodeURIComponent(id)}&userId=${encodeURIComponent(user.id)}`,
                { method: "DELETE" },
            );
            if (!res.ok) throw Object.assign(new Error(res.code || "delete_failed"), { code: res.code, vars: res.vars });
        } catch (err: any) {
            setTemplates(prevList);
            setGlobalError(apiError(err?.code || ErrorCode.SERVER_ERROR, err?.vars, t));
        }
    }, [user, templates, activeTemplateId, defaultOcrTemplateId, t]);

    const persistDefaultTemplate = useCallback(async (id: string | null) => {
        if (!user) return;
        setDefaultOcrTemplateId(id);
        try {
            await fetchJson("/api/user-prefs", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: user.id, kind: "ocr", templateId: id }),
            });
        } catch { /* best-effort */ }
    }, [user]);

    const addField = () => {
        if (!newFieldName.trim()) return;
        setExtractFields(prev => [...prev, { id: crypto.randomUUID(), name: newFieldName.trim(), type: newFieldType }]);
        setNewFieldName("");
    };
    const removeField = (id: string) => setExtractFields(prev => prev.filter(f => f.id !== id));

    // ── Prep + upload ─────────────────────────────────────────────────────
    // Same DPI-bump + dual-scale logic as OCRWorkspaceV2 (kept in sync — any
    // OCR-8/OCR-8b change there must be mirrored here or batch drifts back
    // toward the pre-Rung-1 accuracy floor on hinted fields).
    const prepareUpload = useCallback(async (
        source: File, cachedRaster: PdfRasterResult | null, selection: number[],
    ): Promise<{ uploadFile: File; crops: any[]; renderedPages: number[]; totalPages: number | null; cropDpiScale: number; }> => {
        let uploadFile: File = source;
        let pageRects: StackedPageRect[] | null = null;
        let renderedPages: number[] = [];
        let totalPages: number | null = null;
        let isPdf = false;
        if (source.type === "application/pdf") {
            isPdf = true;
            try {
                totalPages = cachedRaster ? cachedRaster.pageNumbers.length : null;
                const wantsSubset = Array.isArray(selection) && selection.length > 0 && cachedRaster
                    && !(selection.length === cachedRaster.pageNumbers.length
                         && selection.every((p, i) => p === cachedRaster.pageNumbers[i]));
                const detailed = wantsSubset
                    ? await pdfFileToImageDetailed(source, { pages: selection! })
                    : (cachedRaster ?? await pdfFileToImageDetailed(source));
                uploadFile = detailed.file;
                pageRects = detailed.pageRects;
                renderedPages = detailed.pageNumbers.slice();
                if (totalPages === null) totalPages = detailed.pageNumbers.length;
            } catch (e) { console.error("[batch] pdf convert failed", e); }
        }
        let crops: any[] = [];
        let cropDpiScale = 1;
        if (extractFields.some(f => f.bbox_hint)) {
            let cropSourceFile: File = uploadFile;
            let cropPageRects: StackedPageRect[] | null = pageRects;
            if (isPdf && CROP_DPI_SCALE > 1) {
                try {
                    const hiRes = await pdfFileToImageDetailed(source, {
                        pages: renderedPages.length > 0 ? renderedPages : undefined,
                        targetLongEdge: DEFAULT_TARGET_LONG_EDGE * CROP_DPI_SCALE,
                        maxScale: Math.max(4, 4 * CROP_DPI_SCALE),
                    });
                    cropSourceFile = hiRes.file;
                    cropPageRects = hiRes.pageRects;
                    cropDpiScale = CROP_DPI_SCALE;
                } catch (e) {
                    console.warn("[batch] hi-DPI crop render failed, falling back", e);
                    cropDpiScale = 1;
                }
            }
            try { crops = await buildFieldCrops(cropSourceFile, extractFields, cropPageRects, renderedPages); }
            catch (e) { console.warn("[batch] crop build failed", e); crops = []; }
            if (ENABLE_DUAL_SCALE_CROPS && cropDpiScale > 1 && crops.length > 0) {
                try {
                    const loCrops = await buildFieldCrops(uploadFile, extractFields, pageRects, renderedPages);
                    if (loCrops.length > 0) crops = interleaveDualScaleCrops(crops, loCrops);
                } catch (e) {
                    console.warn("[batch] lo-DPI crop build failed", e);
                }
            }
        }
        return { uploadFile, crops, renderedPages, totalPages, cropDpiScale };
    }, [extractFields]);

    const updateRow = useCallback((rowId: string, patch: Partial<BatchFile>) => {
        setBatchFiles(prev => prev.map(bf => bf.id === rowId ? { ...bf, ...patch } : bf));
    }, []);

    const runOne = useCallback(async (row: BatchFile, isRetry: boolean): Promise<void> => {
        updateRow(row.id, { status: "extracting", progress: 15, error: undefined });
        try {
            const { uploadFile, crops, renderedPages, totalPages, cropDpiScale } =
                await prepareUpload(row.file, row.pdfRaster, row.selectedPages);
            const fd = new FormData();
            fd.append("file", uploadFile);
            if (user) fd.append("userId", user.id);
            if (extractMode === "fulldoc") {
                fd.append("mode", "fulldoc");
                fd.append("fields", "full_document (raw_text)");
                fd.append("fields_json", JSON.stringify([{ id: "fulldoc", name: "full_document", type: "raw_text" }]));
            } else {
                fd.append("fields", extractFields.map(f => f.type !== "text" ? `${f.name} (${f.type})` : f.name).join(", "));
                fd.append("fields_json", JSON.stringify(extractFields));
                if (crops.length > 0) {
                    fd.append("field_crops", JSON.stringify(crops.map((c, i) => ({
                        index: i, fieldName: c.fieldName, page: c.page, bytes: c.bytes ?? null, scale: c.scale ?? null,
                    }))));
                    fd.append("crop_dpi_scale", String(cropDpiScale));
                    crops.forEach((c, i) => fd.append(`crop_${i}`, new File([c.blob], `crop_${i}.png`, { type: "image/png" })));
                }
            }
            if (totalPages !== null && totalPages > 0) fd.append("total_pages", String(totalPages));
            if (renderedPages.length > 0 && totalPages !== null
                && !(renderedPages.length === totalPages && renderedPages.every((p, i) => p === i + 1))) {
                fd.append("pages", JSON.stringify(renderedPages));
            }
            if (isRetry) fd.append("retry", "true");

            updateRow(row.id, { progress: 35 });
            const data = await fetchJson<{ documentId?: string }>("/api/upload", { method: "POST", body: fd });
            if (!data.ok) {
                if (data.code === ErrorCode.INSUFFICIENT_CREDITS && onNavigateToBilling) {
                    updateRow(row.id, { status: "error", error: apiError(data.code, data.vars, t) });
                    return;
                }
                updateRow(row.id, { status: "error", error: apiError(data.code, data.vars, t) });
                return;
            }
            if (!data.documentId) {
                updateRow(row.id, { status: "error", error: apiError(ErrorCode.UPLOAD_FAILED, undefined, t) });
                return;
            }
            updateRow(row.id, { progress: 55 });
            const started = Date.now();
            // Poll /api/status until completed / error / timeout.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                if (Date.now() - started > PER_FILE_TIMEOUT_MS) {
                    updateRow(row.id, { status: "error", error: t("ocr.batchTimeout") });
                    return;
                }
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                setBatchFiles(prev => prev.map(bf => bf.id === row.id && bf.progress < 90 ? { ...bf, progress: bf.progress + 5 } : bf));
                try {
                    const res = await fetch(`/api/status?id=${data.documentId}`);
                    const s = await res.json() as { status?: string; data?: any };
                    if (s.status === "completed") {
                        if (extractMode === "fulldoc") {
                            const txt = Object.values(s.data || {})
                                .map((v: any) => (v && typeof v === "object" && "value" in v) ? String(v.value) : String(v ?? ""))
                                .join("\n\n");
                            updateRow(row.id, {
                                status: "done", progress: 100,
                                fulldocResult: { pages: [{ page: 1, text: txt }] },
                                attempt: isRetry ? "retry" : "initial",
                            });
                        } else {
                            updateRow(row.id, {
                                status: "done", progress: 100,
                                result: s.data,
                                attempt: isRetry ? "retry" : "initial",
                            });
                        }
                        return;
                    }
                    if (s.status === "error") {
                        updateRow(row.id, { status: "error", error: t("ocr.aiFailedShort") });
                        return;
                    }
                } catch { /* transient */ }
            }
        } catch (err: any) {
            updateRow(row.id, { status: "error", error: apiError(err?.code || ErrorCode.PROCESSING_FAILED, err?.vars, t) });
        }
    }, [prepareUpload, extractMode, extractFields, user, onNavigateToBilling, updateRow, t]);

    // ── Sequential batch runner (D4) ──────────────────────────────────────
    const runAll = useCallback(async () => {
        if (batchFiles.length === 0 || batchRunning) return;
        if (extractMode === "field" && extractFields.length === 0) {
            setGlobalError(t("ocr.batchNoFields"));
            return;
        }
        setBatchRunning(true);
        setGlobalError(null);
        setCurrentStage("run");
        // Snapshot ids so re-render doesn't reshuffle.
        const ids = batchFiles.filter(bf => bf.status !== "done").map(bf => bf.id);
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            // Latest state (row may have been edited between iterations).
            const row = await new Promise<BatchFile | undefined>(res =>
                setBatchFiles(prev => { res(prev.find(bf => bf.id === id)); return prev; }));
            if (!row || row.status === "done" || row.status === "error") continue;
            await runOne(row, false);
            // D4: pace between files. Skip after the last one.
            if (i < ids.length - 1) {
                await new Promise(r => setTimeout(r, BATCH_INTER_FILE_DELAY_MS));
            }
        }
        setBatchRunning(false);
        setCurrentStage("results");
        if (onDocumentProcessed) onDocumentProcessed();
    }, [batchFiles, batchRunning, extractMode, extractFields.length, runOne, setCurrentStage, onDocumentProcessed, t]);

    // ── Per-file retry (D7) ───────────────────────────────────────────────
    const retryOne = useCallback(async (rowId: string) => {
        const row = batchFiles.find(bf => bf.id === rowId);
        if (!row) return;
        await runOne(row, true);
    }, [batchFiles, runOne]);

    // ── Credit estimate (D5: per-file breakdown) ──────────────────────────
    const eligibleFiles = useMemo(() => batchFiles.filter(bf => bf.status !== "error"), [batchFiles]);
    const perFileBreakdown = useMemo(() => eligibleFiles.map(bf => {
        const pages = Math.max(1, bf.selectedPages.length);
        const est = estimateCredits({
            operation: "ocr",
            fields: extractMode === "field" ? extractFields.length : 1,
            pages,
            creditModel: activeCreditModel,
        });
        return { id: bf.id, name: bf.displayName, pages, credits: est.credits };
    }), [eligibleFiles, extractFields.length, extractMode, activeCreditModel]);
    const totalCredits = useMemo(() => perFileBreakdown.reduce((a, b) => a + b.credits, 0), [perFileBreakdown]);

    const requestRunAll = useCallback(() => {
        if (eligibleFiles.length === 0) {
            setGlobalError(t("ocr.v2.batch.noFiles"));
            return;
        }
        // Per-file breakdown as CreditConfirmDialog `steps` — the shared
        // dialog just renders a label/value list, so we tag each row
        // "<filename>" → "<pages>p · <credits>c" (D5).
        const steps = [
            ...perFileBreakdown.map(row => ({
                label: row.name,
                value: t("ocr.v2.batch.perFileStep", { pages: row.pages, credits: row.credits }),
            })),
            { label: t("ocr.v2.batch.totalLabel"), value: t("ocr.v2.batch.totalValue", { n: totalCredits }) },
        ];
        const fp = makeFingerprint({
            operation: "ocr",
            templateId: activeTemplateId,
            fieldCount: extractFields.length,
            docCount: eligibleFiles.length,
        });
        const proceed = () => runAll();
        if (shouldSkipDialog(fp)) { proceed(); return; }
        const ev = evaluateConfirm({
            estimate: totalCredits, balance,
            hasTableField: extractFields.some(f => f.type === "table"),
        });
        if (!ev.needsConfirm) { proceed(); return; }
        setConfirmDialog({
            reasons: ev.reasons, fingerprint: fp,
            steps, credits: totalCredits,
            onProceed: proceed,
        });
    }, [eligibleFiles, perFileBreakdown, totalCredits, activeTemplateId, extractFields, balance, runAll, t]);

    // ── Stage jump gating ─────────────────────────────────────────────────
    const canJumpTo = useCallback((target: Stage): boolean => {
        const idx = STAGE_ORDER.indexOf(target);
        const frontier = STAGE_ORDER.indexOf(maxReachedStage);
        if (idx > frontier) return false;
        if (target === "upload") return true;
        const hasFiles = batchFiles.length > 0;
        if (target === "pages") return hasFiles;
        if (target === "fields") return hasFiles;
        if (target === "run") return hasFiles && (extractMode === "fulldoc" || extractFields.length > 0);
        if (target === "results") return batchFiles.some(bf => !!bf.result || !!bf.fulldocResult);
        if (target === "export") return batchFiles.some(bf => !!bf.result || !!bf.fulldocResult);
        return false;
    }, [maxReachedStage, batchFiles, extractFields.length, extractMode]);

    // UI-7 UAT r1 (F1 + F3): NO auto-advance. Two bugs shared the same root
    // cause — an effect keyed on `batchFiles.length` fired on both add and
    // delete, and it snapshotted pageCount before the async PDF enrichment
    // finished:
    //   F1: 7-page PDF added → effect fires with pageCount still =1 (default)
    //       → skips "pages" stage entirely.
    //   F3: user deletes a file at upload stage → length changes → effect
    //       auto-advances even though the user did not click Next.
    // Fix: drop the effect. User explicitly clicks "ถัดไป" from upload; the
    // button re-evaluates `pageCount > 1` at click time, after enrichment.

    // Active batch file for the pages tabs.
    const activeBatchFile = useMemo(() =>
        batchFiles.find(bf => bf.id === activeBatchFileId) ?? batchFiles[0] ?? null,
    [batchFiles, activeBatchFileId]);

    // Warn if any file's selection is over cap.
    const pagesOverCap = useMemo(() =>
        batchFiles.filter(bf => bf.selectedPages.length > PAGE_SELECTION_MAX),
    [batchFiles]);

    // UI-7 UAT r4: full-size preview modal. Any mini preview (sidebar row
    // thumb from UAT r3 OR right-panel page thumb from UAT r2) opens the same
    // modal at the given page. No new object URLs — reuses `previewUrl` for
    // page 1 / images / DOCX-flattened, and `pdfRaster.pagePngs[i]` for other
    // pages (already blob URLs owned by `activeThumbUrls`).
    const [previewModal, setPreviewModal] = useState<{ fileId: string; pageIndex: number } | null>(null);
    const openPreview = useCallback((fileId: string, pageIndex: number) => {
        // Ensure the active batch file is switched so `activeThumbUrls` has
        // the right pageset for chevron nav on multi-page PDFs.
        setActiveBatchFileId(fileId);
        setPreviewModal({ fileId, pageIndex });
    }, []);
    const closePreview = useCallback(() => setPreviewModal(null), []);
    const previewFile = useMemo(() =>
        previewModal ? batchFiles.find(bf => bf.id === previewModal.fileId) ?? null : null,
    [previewModal, batchFiles]);
    const previewPrev = useCallback(() => {
        setPreviewModal(prev => (prev && prev.pageIndex > 0)
            ? { ...prev, pageIndex: prev.pageIndex - 1 } : prev);
    }, []);
    const previewNext = useCallback(() => {
        setPreviewModal(prev => {
            if (!prev) return prev;
            const row = batchFiles.find(bf => bf.id === prev.fileId);
            const total = row?.pageCount ?? 1;
            return prev.pageIndex < total - 1 ? { ...prev, pageIndex: prev.pageIndex + 1 } : prev;
        });
    }, [batchFiles]);

    // Keyboard + body scroll lock, active only while modal is open.
    useEffect(() => {
        if (!previewModal) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { e.preventDefault(); closePreview(); }
            else if (e.key === "ArrowLeft") { e.preventDefault(); previewPrev(); }
            else if (e.key === "ArrowRight") { e.preventDefault(); previewNext(); }
        };
        window.addEventListener("keydown", onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            window.removeEventListener("keydown", onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [previewModal, closePreview, previewPrev, previewNext]);

    // Togglable "include this page" checkbox inside the modal — mirrors the
    // same `selectedPages[fileId]` set the right-panel grid uses.
    const togglePreviewPage = useCallback(() => {
        if (!previewModal) return;
        const row = batchFiles.find(bf => bf.id === previewModal.fileId);
        if (!row) return;
        const p = previewModal.pageIndex + 1;
        const on = row.selectedPages.includes(p);
        const next = on
            ? row.selectedPages.filter(x => x !== p)
            : [...row.selectedPages, p].sort((a, b) => a - b);
        updateRow(row.id, { selectedPages: next });
    }, [previewModal, batchFiles, updateRow]);

    // UI-7 UAT r2: per-page thumbnail URLs for the *currently selected* file.
    // The whole PDF was already rasterized in `enrichRowAsync` (no cost — this
    // just wraps existing Blobs in object URLs). We rebuild + revoke when the
    // active file changes so unused URLs don't leak. Non-PDF single-page files
    // fall back to `previewUrl`; see renderPages.
    const activeRaster = useMemo(() =>
        batchFiles.find(x => x.id === activeBatchFileId)?.pdfRaster ?? null,
    [batchFiles, activeBatchFileId]);
    const [activeThumbUrls, setActiveThumbUrls] = useState<string[]>([]);
    useEffect(() => {
        if (!activeRaster) { setActiveThumbUrls([]); return; }
        const urls = activeRaster.pagePngs.map(b => URL.createObjectURL(b));
        setActiveThumbUrls(urls);
        return () => { urls.forEach(u => URL.revokeObjectURL(u)); };
    }, [activeRaster]);

    // Union of field keys across all completed rows — column list for the
    // spreadsheet (D6). Stable order = first-seen order.
    const columnKeys = useMemo(() => {
        if (extractMode === "fulldoc") return ["full_document"];
        const seen = new Set<string>();
        const order: string[] = [];
        for (const bf of batchFiles) {
            if (!bf.result) continue;
            for (const k of Object.keys(bf.result)) {
                if (k.startsWith("_")) continue;
                if (!seen.has(k)) { seen.add(k); order.push(k); }
            }
        }
        // Also seed with configured fields so empty batches still show columns.
        for (const f of extractFields) {
            if (!seen.has(f.name)) { seen.add(f.name); order.push(f.name); }
        }
        return order;
    }, [batchFiles, extractFields, extractMode]);

    // Cell reader for the spreadsheet + drawer.
    const readCell = useCallback((bf: BatchFile, key: string) => {
        if (extractMode === "fulldoc") {
            const txt = bf.fulldocResult?.pages.map(p => p.text).join("\n\n") ?? "";
            return { value: txt, confidence: 0, corrections: [], source: "ai", bbox: null, raw: txt };
        }
        const raw = bf.result?.[key];
        if (raw && typeof raw === "object") {
            return {
                value: String(raw.value ?? ""),
                confidence: Number(raw.confidence ?? 0),
                corrections: Array.isArray(raw.corrections) ? raw.corrections : [],
                source: raw.crop_miss ? "crop_miss" : raw.crop_no_match ? "crop_no_match" : raw.source || "ai",
                bbox: raw.bbox || raw.bbox_hint || null,
                raw,
            };
        }
        return { value: raw != null ? String(raw) : "", confidence: 0, corrections: [], source: "ai", bbox: null, raw };
    }, [extractMode]);

    // ── Export (Q1: match v1 shape = exportOCRBatch) ──────────────────────
    const doExport = useCallback((format: "excel" | "csv" | "json") => {
        if (extractMode === "fulldoc") {
            // Q-open: one combined .txt with file/page headers.
            const text = batchFiles.map(bf => {
                if (bf.status !== "done" || !bf.fulldocResult) return `=== ${bf.displayName} ===\n[${bf.status}${bf.error ? ": " + bf.error : ""}]`;
                const pageBlocks = bf.fulldocResult.pages.map(p => `--- ${t("ocr.v2.pageLabel", { n: p.page })} ---\n${p.text}`).join("\n\n");
                return `=== ${bf.displayName} ===\n${pageBlocks}`;
            }).join("\n\n\n");
            const ext = format === "json" ? "json" : "txt";
            const payload = format === "json"
                ? JSON.stringify(batchFiles.map(bf => ({ file: bf.displayName, status: bf.status, error: bf.error, fulldoc: bf.fulldocResult })), null, 2)
                : text;
            const blob = new Blob([payload], { type: format === "json" ? "application/json" : "text/plain" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `OCR_batch_fulldoc_${Date.now()}.${ext}`;
            a.click();
            return;
        }
        if (format === "json") {
            const payload = batchFiles.map(bf => ({
                file: bf.displayName, status: bf.status, error: bf.error, data: bf.result,
            }));
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `OCR_batch_${Date.now()}.json`;
            a.click();
            return;
        }
        const results: BatchResult[] = batchFiles.map(bf => ({
            fileName: bf.displayName,
            data: bf.result ?? null,
            status: bf.status === "done" ? "done" : bf.status === "error" ? "error" : "error",
            error: bf.error,
        }));
        exportOCRBatch(results, "OCR_batch", format);
    }, [batchFiles, extractMode, t]);

    // ── RENDER ────────────────────────────────────────────────────────────

    const renderStepper = () => {
        const labels: Record<Stage, string> = {
            upload: t("ocr.v2.step.upload"), pages: t("ocr.v2.step.pages"), fields: t("ocr.v2.step.fields"),
            run: t("ocr.v2.step.run"), results: t("ocr.v2.step.results"), export: t("ocr.v2.step.export"),
        };
        const curIdx = STAGE_ORDER.indexOf(currentStage);
        return (
            <div style={{
                display: "flex", alignItems: "center", gap: 4, padding: "10px 20px",
                background: "var(--color-bg-panel)",
                borderBottom: "1px solid var(--color-border)",
                overflowX: "auto",
            }}>
                {STAGE_ORDER.map((s, i) => {
                    const done = i < curIdx;
                    const current = i === curIdx;
                    const jumpable = canJumpTo(s);
                    return (
                        <React.Fragment key={s}>
                            {i > 0 && <div style={{ color: "var(--color-text-4)", padding: "0 2px" }}>→</div>}
                            <button
                                onClick={() => { if (jumpable) setCurrentStageRaw(s); }}
                                disabled={!jumpable}
                                style={{
                                    display: "flex", alignItems: "center", gap: 8,
                                    padding: "8px 14px", borderRadius: 10, whiteSpace: "nowrap",
                                    fontSize: 12.5, fontWeight: current ? 600 : 400,
                                    border: current ? "1px solid var(--color-accent-border)" : "1px solid transparent",
                                    background: current ? "var(--color-accent-dim)" : "transparent",
                                    color: current ? "var(--color-text-1)"
                                        : done ? "var(--color-text-2)" : "var(--color-text-3)",
                                    cursor: jumpable ? "pointer" : "default",
                                    fontFamily: "inherit",
                                }}
                            >
                                <span style={{
                                    width: 20, height: 20, borderRadius: "50%",
                                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                                    fontSize: 11, fontWeight: 700,
                                    background: done ? "var(--color-success)"
                                        : current ? "var(--color-accent)" : "var(--color-bg-elevated)",
                                    color: (done || current) ? "#0a1628" : "var(--color-text-3)",
                                    border: (done || current) ? "none" : "1px solid var(--color-border-strong)",
                                }}>{done ? "✓" : i + 1}</span>
                                <span>{labels[s]}</span>
                            </button>
                        </React.Fragment>
                    );
                })}
                {headerRight && (
                    <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {headerRight}
                    </div>
                )}
            </div>
        );
    };

    // ── Upload stage: dropzone + queued list ──────────────────────────────
    const renderUpload = () => (
        <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: "var(--color-text-1)" }}>
                {t("ocr.v2.batch.uploadTitle")}
            </div>
            <div style={{ color: "var(--color-text-3)", fontSize: 13 }}>
                {t("ocr.v2.batch.uploadSubtitle", { max: MAX_BATCH_FILES })}
            </div>
            <label style={{
                border: "2px dashed var(--color-border-strong)", borderRadius: 12, padding: 40,
                textAlign: "center", cursor: "pointer", background: "var(--color-bg-card)",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
            }}>
                <div style={{ fontSize: 32 }}>📥</div>
                <div style={{ fontSize: 15, color: "var(--color-text-2)" }}>{t("ocr.v2.batch.dropzone")}</div>
                <div style={{ fontSize: 12, color: "var(--color-text-3)" }}>
                    {t("ocr.v2.batch.dropzoneSub", { mb: MAX_UPLOAD_SIZE_MB })}
                </div>
                <input
                    type="file"
                    multiple
                    accept="image/*,application/pdf,.docx"
                    style={{ display: "none" }}
                    onChange={e => e.target.files && addFiles(e.target.files)}
                />
            </label>
            {batchFiles.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 12, color: "var(--color-text-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>
                        {t("ocr.v2.batch.queueHead", { n: batchFiles.length })}
                    </div>
                    {batchFiles.map(bf => (
                        <div key={bf.id} style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                            border: "1px solid var(--color-border)", borderRadius: 8,
                            background: "var(--color-bg-card)",
                        }}>
                            <div style={{ fontSize: 18 }}>
                                {bf.file.type === "application/pdf" ? "📄" : bf.file.name.endsWith(".docx") ? "📝" : "🖼"}
                            </div>
                            <div style={{ flex: 1, overflow: "hidden" }}>
                                <div style={{ fontSize: 13, color: "var(--color-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {bf.displayName}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                                    {bf.pageCount} {t("ocr.v2.batch.pagesShort")} · {(bf.file.size / 1024 / 1024).toFixed(1)} MB
                                    {bf.error && <span style={{ color: "var(--color-danger)" }}> · ⚠ {bf.error}</span>}
                                </div>
                            </div>
                            <button onClick={() => removeRow(bf.id)}
                                style={{
                                    background: "transparent", border: "1px solid var(--color-border)",
                                    borderRadius: 6, padding: "4px 8px", cursor: "pointer",
                                    color: "var(--color-text-3)", fontSize: 12,
                                }}>✕</button>
                        </div>
                    ))}
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                        <button
                            onClick={() => setCurrentStage(batchFiles.some(bf => bf.pageCount > 1) ? "pages" : "fields")}
                            disabled={batchFiles.every(bf => bf.status === "error")}
                            style={ctaStyle(batchFiles.every(bf => bf.status === "error"))}>
                            {t("ocr.v2.batch.nextPages")}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );

    // ── Pages stage: vertical file list (left) + page-thumbnail grid (right) ─
    // UI-7 UAT r2 (2026-07-14): the r1 horizontal tabs wrapped and collided
    // once operators queued 5+ files with long Thai filenames — filenames were
    // clipped to unreadable slivers. New layout:
    //   • left column = vertical scrollable file list (filename + N/M badge,
    //     selected row highlighted with an accent border-left)
    //   • right column = header ("N หน้า · เลือก M หน้า") + responsive grid
    //     of page-preview thumbnails. Preview PNGs come from the raster we
    //     already computed in enrichRowAsync — no extra PDF work. Click the
    //     thumbnail OR its checkbox to toggle selection.
    // Data flow to the runner is unchanged: `selectedPages` per BatchFile.
    const renderPages = () => {
        const bf = activeBatchFile;
        return (
            <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-1)" }}>
                    {t("ocr.v2.batch.pagesTitle")}
                </div>
                <div style={{ color: "var(--color-text-3)", fontSize: 12 }}>
                    {t("ocr.v2.batch.pagesTip", { max: PAGE_SELECTION_MAX })}
                </div>
                <div style={{
                    flex: 1, minHeight: 0,
                    display: "grid",
                    gridTemplateColumns: "minmax(220px, 260px) 1fr",
                    gap: 14,
                    border: "1px solid var(--color-border)",
                    borderRadius: 10,
                    overflow: "hidden",
                    background: "var(--color-bg-card)",
                }}>
                    {/* ── LEFT: vertical file list ────────────────────── */}
                    <div style={{
                        display: "flex", flexDirection: "column",
                        borderRight: "1px solid var(--color-border)",
                        background: "var(--color-bg-panel)",
                        minHeight: 0,
                    }}>
                        <div style={{
                            padding: "8px 12px",
                            fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em",
                            color: "var(--color-text-3)", fontWeight: 700,
                            borderBottom: "1px solid var(--color-border)",
                        }}>
                            {t("ocr.v2.batch.pages.fileListHead", { n: batchFiles.length })}
                        </div>
                        <div style={{ flex: 1, overflowY: "auto" }}>
                            {batchFiles.map(row => {
                                const active = row.id === bf?.id;
                                const overCap = row.selectedPages.length > PAGE_SELECTION_MAX;
                                return (
                                    <button
                                        key={row.id}
                                        onClick={() => setActiveBatchFileId(row.id)}
                                        title={row.displayName}
                                        style={{
                                            display: "flex", alignItems: "center", gap: 8,
                                            width: "100%", textAlign: "left",
                                            padding: "10px 12px",
                                            background: active ? "var(--color-accent-dim)" : "transparent",
                                            borderLeft: active
                                                ? "3px solid var(--color-accent)"
                                                : "3px solid transparent",
                                            borderTop: "none", borderRight: "none",
                                            borderBottom: "1px solid var(--color-border)",
                                            color: active ? "var(--color-text-1)" : "var(--color-text-2)",
                                            cursor: "pointer",
                                            fontFamily: "inherit", fontSize: 12,
                                        }}
                                    >
                                        {/* UI-7 UAT r3: page-1 mini preview so the operator can
                                            verify the correct file was queued without having to
                                            click each row. Reuses row.previewUrl (already an
                                            object URL of page 1 for PDF / DOCX-flattened, or the
                                            image itself for image uploads — created in
                                            enrichRowAsync, revoked in removeRow + unmount).
                                            No extra rasterization, no new object-URL lifecycle. */}
                                        <span
                                            onClick={(e) => {
                                                // UI-7 UAT r4: click mini thumb → full preview modal
                                                // at page 1. stopPropagation so the outer row-button
                                                // (which sets the active file) doesn't also fire —
                                                // openPreview handles active-file selection itself.
                                                if (row.previewUrl) {
                                                    e.stopPropagation();
                                                    openPreview(row.id, 0);
                                                }
                                            }}
                                            title={row.previewUrl ? t("ocr.v2.batch.preview.title") : undefined}
                                            style={{
                                                flexShrink: 0,
                                                width: 40, height: 56, borderRadius: 4,
                                                background: "var(--color-bg-elevated)",
                                                border: "1px solid var(--color-border)",
                                                overflow: "hidden",
                                                display: "flex", alignItems: "center", justifyContent: "center",
                                                cursor: row.previewUrl ? "zoom-in" : "default",
                                            }}>
                                            {row.previewUrl ? (
                                                <img
                                                    src={row.previewUrl}
                                                    alt=""
                                                    style={{
                                                        maxWidth: "100%", maxHeight: "100%",
                                                        objectFit: "contain",
                                                    }}
                                                />
                                            ) : (
                                                <span style={{
                                                    fontSize: 9,
                                                    color: "var(--color-text-4)",
                                                }}>…</span>
                                            )}
                                        </span>
                                        <span style={{
                                            flex: 1, overflow: "hidden",
                                            textOverflow: "ellipsis", whiteSpace: "nowrap",
                                        }}>
                                            {overCap && <span style={{ color: "var(--color-danger)" }}>⚠ </span>}
                                            {row.displayName}
                                        </span>
                                        <span style={{
                                            flexShrink: 0,
                                            padding: "2px 7px", borderRadius: 10,
                                            fontSize: 10, fontWeight: 600,
                                            background: overCap
                                                ? "rgba(239,68,68,0.15)"
                                                : "var(--color-bg-elevated)",
                                            color: overCap ? "#ef4444" : "var(--color-text-3)",
                                            border: "1px solid var(--color-border)",
                                        }}>
                                            {row.selectedPages.length}/{row.pageCount}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {/* ── RIGHT: page-picker + thumbnail grid ─────────── */}
                    <div style={{
                        display: "flex", flexDirection: "column",
                        minHeight: 0, minWidth: 0,
                    }}>
                        {bf ? (
                            <>
                                {/* Header */}
                                <div style={{
                                    padding: "12px 16px",
                                    borderBottom: "1px solid var(--color-border)",
                                    display: "flex", flexDirection: "column", gap: 6,
                                }}>
                                    <div style={{
                                        fontSize: 13, fontWeight: 600, color: "var(--color-text-1)",
                                        wordBreak: "break-word",
                                    }}
                                        title={bf.displayName}>
                                        {bf.displayName}
                                    </div>
                                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 12, color: "var(--color-text-3)" }}>
                                            {t("ocr.v2.batch.pages.pageSummary", {
                                                total: bf.pageCount, n: bf.selectedPages.length,
                                            })}
                                        </span>
                                        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                                            <button style={miniBtn} onClick={() => {
                                                const n = Math.min(bf.pageCount, PAGE_SELECTION_MAX);
                                                const pages = Array.from({ length: n }, (_, i) => i + 1);
                                                updateRow(bf.id, { selectedPages: pages });
                                            }} disabled={bf.pageCount <= 1}>
                                                {t("ocr.v2.pages.selectAll")}
                                            </button>
                                            <button style={miniBtn}
                                                onClick={() => updateRow(bf.id, { selectedPages: [] })}
                                                disabled={bf.pageCount <= 1}>
                                                {t("ocr.v2.pages.clear")}
                                            </button>
                                        </div>
                                    </div>
                                    {bf.selectedPages.length > PAGE_SELECTION_MAX && (
                                        <div style={{ color: "var(--color-danger)", fontSize: 12 }}>
                                            ⚠ {t("ocr.v2.batch.overCap", { max: PAGE_SELECTION_MAX })}
                                        </div>
                                    )}
                                </div>
                                {/* Body */}
                                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
                                    {bf.pageCount <= 1 ? (
                                        <div style={{
                                            padding: 20, textAlign: "center",
                                            color: "var(--color-text-3)", fontSize: 13,
                                        }}>
                                            {t("ocr.v2.batch.singlePage")}
                                        </div>
                                    ) : (
                                        <div style={{
                                            display: "grid",
                                            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                                            gap: 10,
                                        }}>
                                            {Array.from({ length: bf.pageCount }, (_, i) => i + 1).map(p => {
                                                const on = bf.selectedPages.includes(p);
                                                const thumb = activeThumbUrls[p - 1] ?? null;
                                                // UI-7 UAT r4: split click surfaces.
                                                //  • Thumb image  → openPreview (modal at page p)
                                                //  • Bottom row   → toggle selection (checkbox + label)
                                                // Outer card no longer has onClick, so plain selection
                                                // toggle still works via the row where user expects it,
                                                // while the image behaves like a zoom trigger. Prevents
                                                // the double-meaning that UAT r3 had (single click both
                                                // toggled AND was the only way to inspect a page).
                                                const toggleSelect = () => {
                                                    const next = on
                                                        ? bf.selectedPages.filter(x => x !== p)
                                                        : [...bf.selectedPages, p].sort((a, b) => a - b);
                                                    updateRow(bf.id, { selectedPages: next });
                                                };
                                                return (
                                                    <div key={p}
                                                        style={{
                                                            position: "relative",
                                                            display: "flex", flexDirection: "column",
                                                            gap: 4, padding: 6,
                                                            borderRadius: 8,
                                                            background: on
                                                                ? "var(--color-accent-dim)"
                                                                : "var(--color-bg-elevated)",
                                                            border: on
                                                                ? "2px solid var(--color-accent-border)"
                                                                : "1px solid var(--color-border)",
                                                        }}>
                                                        <div
                                                            onClick={() => thumb && openPreview(bf.id, p - 1)}
                                                            title={thumb ? t("ocr.v2.batch.preview.title") : undefined}
                                                            style={{
                                                                width: "100%", height: 140,
                                                                background: "var(--color-bg-panel)",
                                                                borderRadius: 4, overflow: "hidden",
                                                                display: "flex", alignItems: "center", justifyContent: "center",
                                                                cursor: thumb ? "zoom-in" : "default",
                                                            }}>
                                                            {thumb ? (
                                                                <img src={thumb} alt={`page ${p}`}
                                                                    style={{
                                                                        maxWidth: "100%", maxHeight: "100%",
                                                                        objectFit: "contain",
                                                                    }} />
                                                            ) : (
                                                                <span style={{
                                                                    fontSize: 10,
                                                                    color: "var(--color-text-4)",
                                                                }}>—</span>
                                                            )}
                                                        </div>
                                                        <div
                                                            onClick={toggleSelect}
                                                            style={{
                                                                display: "flex", alignItems: "center", gap: 6,
                                                                fontSize: 11,
                                                                color: on ? "var(--color-text-1)" : "var(--color-text-3)",
                                                                cursor: "pointer",
                                                            }}>
                                                            <input
                                                                type="checkbox" checked={on} readOnly
                                                                onClick={e => e.stopPropagation()}
                                                                onChange={toggleSelect}
                                                                style={{ margin: 0, cursor: "pointer" }}
                                                            />
                                                            <span>{t("ocr.v2.pageLabel", { n: p })}</span>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div style={{
                                flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                                color: "var(--color-text-3)", fontSize: 13, padding: 20,
                            }}>
                                {t("ocr.v2.batch.pages.emptyRight")}
                            </div>
                        )}
                    </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 4 }}>
                    <button style={miniBtn} onClick={() => setCurrentStage("upload")}>← {t("common.back")}</button>
                    <button
                        onClick={() => setCurrentStage("fields")}
                        disabled={pagesOverCap.length > 0}
                        style={ctaStyle(pagesOverCap.length > 0)}>
                        {t("ocr.v2.batch.nextFields")}
                    </button>
                </div>
            </div>
        );
    };

    // ── Fields stage: template picker + shared fields ─────────────────────
    const renderFields = () => (
        <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-1)" }}>
                {t("ocr.v2.batch.fieldsTitle")}
            </div>
            <div style={{ color: "var(--color-text-3)", fontSize: 12 }}>
                {t("ocr.v2.batch.fieldsTip")}
            </div>
            {/* Mode toggle */}
            <div style={{ display: "flex", gap: 6 }}>
                {(["field", "fulldoc"] as ExtractMode[]).map(m => (
                    <button key={m} onClick={() => setExtractMode(m)}
                        style={{
                            padding: "6px 12px", borderRadius: 8, fontSize: 12,
                            background: extractMode === m ? "var(--color-accent-dim)" : "var(--color-bg-elevated)",
                            border: extractMode === m ? "1px solid var(--color-accent-border)" : "1px solid var(--color-border)",
                            color: extractMode === m ? "var(--color-text-1)" : "var(--color-text-2)",
                            cursor: "pointer", fontFamily: "inherit",
                        }}>
                        {m === "field" ? t("ocr.v2.fields.modeField") : t("ocr.v2.fields.modeFulldoc")}
                    </button>
                ))}
            </div>
            {extractMode === "field" && (
                <>
                    {/* UI-7 UAT r1 (F2): batch mode now uses the same
                        TemplatePickerPanel as single-file (⭐ Favorites / 🕐
                        Recent / 📋 All + search + inline delete + save-as-new
                        / update-active). The shared template applies to every
                        queued file per D2. */}
                    <TemplatePickerPanel
                        templates={templates}
                        activeTemplateId={activeTemplateId}
                        activeTemplateName={activeTemplateName}
                        favoriteIds={favoriteTemplateIds}
                        recentIds={recentTemplateIds}
                        defaultTemplateId={defaultOcrTemplateId}
                        dirty={templateDirty}
                        search={templateSearch}
                        onSearch={setTemplateSearch}
                        onApply={applyTemplate}
                        onToggleFavorite={toggleFavoriteTemplate}
                        onSetDefault={persistDefaultTemplate}
                        onSaveAsNew={() => { setNewTemplateName(""); setSaveAsNewOpen(true); }}
                        onUpdateActive={updateActiveTemplate}
                        onDelete={deleteTemplate}
                        savingTemplate={savingTemplate}
                        t={t}
                    />
                    <div>
                        <div style={{ fontSize: 12, color: "var(--color-text-3)", marginBottom: 6 }}>{t("ocr.v2.fields.fieldsHead")}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                            {extractFields.map(f => (
                                <div key={f.id} style={{
                                    display: "inline-flex", alignItems: "center", gap: 6,
                                    padding: "4px 8px", borderRadius: 16,
                                    background: "var(--color-bg-elevated)",
                                    border: "1px solid var(--color-border)",
                                    fontSize: 12,
                                }}>
                                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: TYPE_COLOR[f.type] || "#999" }} />
                                    {f.name}
                                    <span style={{ color: "var(--color-text-3)", fontSize: 10 }}>({t(`ocr.v2.fields.type.${f.type}`)})</span>
                                    <button onClick={() => removeField(f.id)}
                                        style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--color-text-3)" }}>✕</button>
                                </div>
                            ))}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                            <input value={newFieldName} onChange={e => setNewFieldName(e.target.value)}
                                placeholder={t("ocr.v2.fields.newFieldPlaceholder")}
                                onKeyDown={e => e.key === "Enter" && addField()}
                                style={{
                                    flex: 1, padding: "6px 10px", borderRadius: 6, fontSize: 12,
                                    background: "var(--color-bg-elevated)", color: "var(--color-text-1)",
                                    border: "1px solid var(--color-border)", fontFamily: "inherit",
                                }} />
                            <select value={newFieldType} onChange={e => setNewFieldType(e.target.value as ExtractField["type"])}
                                style={{
                                    padding: "6px 10px", borderRadius: 6, fontSize: 12,
                                    background: "var(--color-bg-elevated)", color: "var(--color-text-1)",
                                    border: "1px solid var(--color-border)", fontFamily: "inherit",
                                }}>
                                {(["text", "number", "currency", "date", "address", "email", "table", "raw_text"] as const).map(ty => (
                                    <option key={ty} value={ty}>{t(`ocr.v2.fields.type.${ty}`)}</option>
                                ))}
                            </select>
                            <button style={miniBtn} onClick={addField}>{t("ocr.v2.fields.add")}</button>
                        </div>
                    </div>
                </>
            )}
            {extractMode === "fulldoc" && (
                <div style={{
                    padding: 12, borderRadius: 8,
                    background: "var(--color-bg-elevated)", border: "1px solid var(--color-border)",
                    fontSize: 12, color: "var(--color-text-2)",
                }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("ocr.v2.fields.fulldocHead")}</div>
                    {t("ocr.v2.fields.fulldocBody")}
                </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "auto", paddingTop: 12 }}>
                <button style={miniBtn}
                    onClick={() => setCurrentStage(batchFiles.some(bf => bf.pageCount > 1) ? "pages" : "upload")}>
                    ← {t("common.back")}
                </button>
                <button
                    onClick={() => setCurrentStage("run")}
                    disabled={extractMode === "field" && extractFields.length === 0}
                    style={ctaStyle(extractMode === "field" && extractFields.length === 0)}>
                    {t("ocr.v2.batch.nextRun")}
                </button>
            </div>
        </div>
    );

    // ── Run stage: cost summary + CTA ─────────────────────────────────────
    const renderRun = () => (
        <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{t("ocr.v2.batch.runTitle")}</div>
            <div style={{
                padding: 16, borderRadius: 12,
                background: "var(--color-accent-dim)", border: "1px solid var(--color-accent-border)",
            }}>
                <div style={{ fontSize: 13, color: "var(--color-text-2)", marginBottom: 6 }}>
                    {t("ocr.v2.run.costHead")}
                </div>
                <div style={{ fontSize: 32, fontWeight: 700, color: "var(--color-accent)" }}>
                    {totalCredits} <span style={{ fontSize: 13, color: "var(--color-text-3)", fontWeight: 400 }}>{t("ocr.v2.run.credits")}</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-3)" }}>
                    {t("ocr.v2.batch.runSummary", {
                        files: eligibleFiles.length,
                        pages: perFileBreakdown.reduce((a, b) => a + b.pages, 0),
                    })}
                </div>
            </div>
            {/* Per-file breakdown */}
            <div style={{
                border: "1px solid var(--color-border)", borderRadius: 10,
                maxHeight: 240, overflowY: "auto",
            }}>
                {batchFiles.map(bf => (
                    <div key={bf.id} style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                        borderBottom: "1px solid var(--color-border)", fontSize: 12,
                    }}>
                        <div style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {bf.displayName}
                        </div>
                        <div style={{ color: "var(--color-text-3)" }}>
                            {bf.selectedPages.length} {t("ocr.v2.batch.pagesShort")}
                        </div>
                        <div style={{ minWidth: 60, textAlign: "right", color: "var(--color-text-2)" }}>
                            {bf.status === "extracting" ? `${bf.progress}%` :
                             bf.status === "done" ? "✓" :
                             bf.status === "error" ? "⚠" : "—"}
                        </div>
                    </div>
                ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
                <button style={miniBtn} onClick={() => setCurrentStage("fields")} disabled={batchRunning}>
                    ← {t("common.back")}
                </button>
                <button onClick={requestRunAll} disabled={batchRunning || eligibleFiles.length === 0}
                    style={ctaStyle(batchRunning || eligibleFiles.length === 0)}>
                    {batchRunning
                        ? t("ocr.v2.batch.running", {
                              done: batchFiles.filter(bf => bf.status === "done").length,
                              total: eligibleFiles.length,
                          })
                        : t("ocr.v2.batch.runCta")}
                </button>
            </div>
            {batchRunning && (
                <div style={{ color: "var(--color-text-3)", fontSize: 11, textAlign: "center" }}>
                    {t("ocr.v2.batch.runNote")}
                </div>
            )}
        </div>
    );

    // ── Results stage: spreadsheet ────────────────────────────────────────
    const renderResults = () => (
        <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{t("ocr.v2.batch.resultsTitle")}</div>
                <div style={{ fontSize: 12, color: "var(--color-text-3)" }}>
                    {t("ocr.v2.batch.resultsSummary", {
                        done: batchFiles.filter(bf => bf.status === "done").length,
                        total: batchFiles.length,
                        err: batchFiles.filter(bf => bf.status === "error").length,
                    })}
                </div>
            </div>
            <div style={{
                flex: 1, overflow: "auto",
                border: "1px solid var(--color-border)", borderRadius: 8,
                background: "var(--color-bg-card)",
            }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead style={{ position: "sticky", top: 0, background: "var(--color-bg-panel)", zIndex: 1 }}>
                        <tr>
                            <th style={thStyle}>{t("ocr.v2.batch.colFile")}</th>
                            <th style={thStyle}>{t("ocr.v2.batch.colStatus")}</th>
                            {columnKeys.map(k => <th key={k} style={thStyle}>{k}</th>)}
                            <th style={thStyle}>{t("ocr.v2.batch.colActions")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {batchFiles.map(bf => (
                            <tr key={bf.id}>
                                <td style={tdStyle}>
                                    {/* UI-7 UAT r1 (F5): let long filenames wrap so operator
                                        sees the full name; keep min-width so the column doesn't
                                        collapse to nothing when only short names are present. */}
                                    <div style={{ minWidth: 160, maxWidth: 320, wordBreak: "break-word" }}
                                        title={bf.displayName}>
                                        {bf.displayName}
                                    </div>
                                </td>
                                <td style={tdStyle}>
                                    <StatusPill status={bf.status} error={bf.error} attempt={bf.attempt} t={t} />
                                </td>
                                {columnKeys.map(k => {
                                    const cell = readCell(bf, k);
                                    const empty = !cell.value;
                                    const err = bf.status === "error";
                                    return (
                                        <td key={k} style={{ ...tdStyle, cursor: "pointer", minWidth: 140, maxWidth: 320 }}
                                            onClick={() => bf.status === "done" && setInspectorCell({ fileId: bf.id, fieldKey: k })}>
                                            {err ? (
                                                <span style={{ color: "var(--color-danger)" }}>⚠</span>
                                            ) : empty ? (
                                                <span style={{ color: "var(--color-text-4)" }}>—</span>
                                            ) : (
                                                <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                                                    {/* UI-7 UAT r1 (F5): drop the ellipsis so the full
                                                        value is visible; wrap on word boundaries. Cell
                                                        still opens the inspector drawer on click for
                                                        confidence / bbox / raw payload. */}
                                                    <span title={cell.value}
                                                        style={{ flex: 1, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                                                        {cell.value}
                                                    </span>
                                                    {cell.confidence > 0 && (
                                                        <span style={{
                                                            fontSize: 9, padding: "1px 4px", borderRadius: 4,
                                                            background: cell.confidence >= 80 ? "rgba(16,185,129,0.15)"
                                                                : cell.confidence >= 60 ? "rgba(245,158,11,0.15)"
                                                                : "rgba(239,68,68,0.15)",
                                                            color: cell.confidence >= 80 ? "#10b981"
                                                                : cell.confidence >= 60 ? "#f59e0b" : "#ef4444",
                                                        }}>{Math.round(cell.confidence)}</span>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                    );
                                })}
                                <td style={tdStyle}>
                                    <button style={miniBtn} disabled={batchRunning}
                                        onClick={() => retryOne(bf.id)}
                                        title={t("ocr.v2.batch.retryFile")}>↻</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
                <button style={miniBtn} onClick={() => setCurrentStage("run")}>← {t("common.back")}</button>
                <button onClick={() => setCurrentStage("export")}
                    disabled={!batchFiles.some(bf => bf.result || bf.fulldocResult)}
                    style={ctaStyle(!batchFiles.some(bf => bf.result || bf.fulldocResult))}>
                    {t("ocr.v2.batch.nextExport")}
                </button>
            </div>
        </div>
    );

    // ── Export stage ──────────────────────────────────────────────────────
    const renderExport = () => (
        <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{t("ocr.v2.batch.exportTitle")}</div>
            <div style={{ color: "var(--color-text-3)", fontSize: 13 }}>
                {t("ocr.v2.batch.exportSubtitle", {
                    done: batchFiles.filter(bf => bf.status === "done").length,
                    total: batchFiles.length,
                })}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button style={ctaStyle(false)} onClick={() => doExport("excel")}>📊 Excel (.xlsx)</button>
                <button style={ctaStyle(false)} onClick={() => doExport("csv")}>📋 CSV</button>
                <button style={miniBtn} onClick={() => doExport("json")}>{"{ }"} JSON</button>
            </div>
            <div style={{
                padding: 12, borderRadius: 8,
                background: "var(--color-bg-elevated)", border: "1px solid var(--color-border)",
                fontSize: 12, color: "var(--color-text-3)",
            }}>
                {t("ocr.v2.batch.exportHint")}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "auto" }}>
                <button style={miniBtn} onClick={() => setCurrentStage("results")}>← {t("common.back")}</button>
            </div>
        </div>
    );

    // ── Inspector drawer for spreadsheet cells ────────────────────────────
    const renderInspector = () => {
        if (!inspectorCell) return null;
        const bf = batchFiles.find(x => x.id === inspectorCell.fileId);
        if (!bf) return null;
        const cell = readCell(bf, inspectorCell.fieldKey);
        return (
            <div style={{
                position: "fixed", top: 0, right: 0, bottom: 0, width: 400, zIndex: 60,
                background: "var(--color-bg-card)", borderLeft: "1px solid var(--color-border)",
                padding: 20, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto",
                boxShadow: "-8px 0 24px rgba(0,0,0,0.15)",
            }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{inspectorCell.fieldKey}</div>
                    <button onClick={() => setInspectorCell(null)} style={miniBtn}>✕</button>
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>{bf.displayName}</div>
                <div style={{ borderTop: "1px solid var(--color-border)" }} />
                <Section label={t("ocr.v2.batch.inspValue")}>
                    <div style={{ fontSize: 14, color: "var(--color-text-1)" }}>{cell.value || "—"}</div>
                </Section>
                {cell.confidence > 0 && (
                    <Section label={t("ocr.v2.batch.inspConfidence")}>
                        <div style={{ fontSize: 14 }}>{Math.round(cell.confidence)}%</div>
                    </Section>
                )}
                <Section label={t("ocr.v2.batch.inspSource")}>
                    <div style={{ fontSize: 12, color: "var(--color-text-2)" }}>{t(`ocr.v2.provenance.${cell.source}`)}</div>
                </Section>
                {cell.corrections.length > 0 && (
                    <Section label={t("ocr.v2.batch.inspCorrections")}>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                            {cell.corrections.map((c: any, i: number) => (
                                <li key={i}>{c.original} → {c.corrected} ({c.why})</li>
                            ))}
                        </ul>
                    </Section>
                )}
                {cell.bbox && (
                    <Section label={t("ocr.v2.batch.inspBbox")}>
                        <div style={{ fontSize: 11, fontFamily: "monospace", color: "var(--color-text-3)" }}>
                            {JSON.stringify(cell.bbox)}
                        </div>
                    </Section>
                )}
                <Section label={t("ocr.v2.batch.inspRaw")}>
                    <pre style={{
                        margin: 0, fontSize: 10, background: "var(--color-bg-elevated)",
                        padding: 8, borderRadius: 6, overflowX: "auto", maxHeight: 200,
                    }}>{JSON.stringify(cell.raw, null, 2)}</pre>
                </Section>
            </div>
        );
    };

    // ── UI-7 UAT r4: full-size preview modal ──────────────────────────────
    // Opened by clicking any mini thumbnail (sidebar row or right-panel page).
    // Multi-page files get chevron nav + ← / → keys; Esc closes. Backdrop
    // click closes. The "include this page" checkbox toggles the same
    // `selectedPages[fileId]` set the right-panel grid uses, so operators can
    // inspect + include/exclude a page without leaving the modal.
    // Image source is reused (no new object URLs):
    //   • PDF     → activeThumbUrls[pageIndex] (built once per active file)
    //   • image / DOCX-flattened → previewFile.previewUrl (built in enrichRowAsync)
    const renderPreviewModal = () => {
        if (!previewModal || !previewFile) return null;
        const total = previewFile.pageCount;
        const idx = previewModal.pageIndex;
        const isPdf = !!previewFile.pdfRaster;
        const imgSrc = isPdf ? (activeThumbUrls[idx] ?? null) : previewFile.previewUrl;
        const pageNumber = idx + 1;
        const isSelected = previewFile.selectedPages.includes(pageNumber);
        const canPrev = idx > 0;
        const canNext = idx < total - 1;
        return (
            <div
                onClick={closePreview}
                role="dialog"
                aria-modal="true"
                aria-label={previewFile.displayName}
                style={{
                    position: "fixed", inset: 0, zIndex: 90,
                    background: "rgba(0,0,0,0.85)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    padding: 24,
                }}>
                <div
                    onClick={e => e.stopPropagation()}
                    style={{
                        background: "var(--color-bg-card)",
                        border: "1px solid var(--color-border-strong)",
                        borderRadius: 12,
                        maxWidth: "90vw", maxHeight: "90vh",
                        display: "flex", flexDirection: "column",
                        overflow: "hidden",
                        boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
                        color: "var(--color-text-1)",
                    }}>
                    {/* Header */}
                    <div style={{
                        display: "flex", alignItems: "center", gap: 12,
                        padding: "12px 16px",
                        borderBottom: "1px solid var(--color-border)",
                    }}>
                        <div style={{
                            flex: 1, minWidth: 0,
                            display: "flex", flexDirection: "column", gap: 2,
                        }}>
                            <div style={{
                                fontSize: 14, fontWeight: 600,
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }} title={previewFile.displayName}>
                                {previewFile.displayName}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                                {t("ocr.v2.batch.preview.pageOf", { n: pageNumber, total })}
                            </div>
                        </div>
                        {total > 1 && (
                            <label style={{
                                display: "inline-flex", alignItems: "center", gap: 6,
                                fontSize: 12, color: "var(--color-text-2)",
                                cursor: "pointer",
                            }}>
                                <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={togglePreviewPage}
                                    style={{ margin: 0, cursor: "pointer" }}
                                />
                                {t("ocr.v2.batch.preview.includePage")}
                            </label>
                        )}
                        <button
                            onClick={closePreview}
                            aria-label={t("ocr.v2.batch.preview.close")}
                            title={t("ocr.v2.batch.preview.close")}
                            style={{
                                background: "var(--color-bg-elevated)",
                                border: "1px solid var(--color-border)",
                                borderRadius: 8, padding: "4px 10px",
                                cursor: "pointer",
                                color: "var(--color-text-2)",
                                fontSize: 14, fontFamily: "inherit",
                            }}>✕</button>
                    </div>
                    {/* Body */}
                    <div style={{
                        flex: 1, minHeight: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        gap: 8, padding: 12,
                        background: "var(--color-bg-panel)",
                    }}>
                        {total > 1 && (
                            <button
                                onClick={previewPrev}
                                disabled={!canPrev}
                                aria-label={t("ocr.v2.batch.preview.prev")}
                                title={t("ocr.v2.batch.preview.prev")}
                                style={chevronStyle(!canPrev)}>‹</button>
                        )}
                        <div style={{
                            flex: 1, minWidth: 0, minHeight: 0,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            maxHeight: "78vh",
                        }}>
                            {imgSrc ? (
                                <img
                                    src={imgSrc}
                                    alt={`${previewFile.displayName} — page ${pageNumber}`}
                                    style={{
                                        maxWidth: "100%", maxHeight: "78vh",
                                        objectFit: "contain",
                                        borderRadius: 4,
                                        background: "var(--color-bg-elevated)",
                                    }} />
                            ) : (
                                <div style={{ color: "var(--color-text-3)", fontSize: 12 }}>…</div>
                            )}
                        </div>
                        {total > 1 && (
                            <button
                                onClick={previewNext}
                                disabled={!canNext}
                                aria-label={t("ocr.v2.batch.preview.next")}
                                title={t("ocr.v2.batch.preview.next")}
                                style={chevronStyle(!canNext)}>›</button>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    // ── Main layout ───────────────────────────────────────────────────────
    return (
        <div ref={dropRef} style={{
            display: "flex", flexDirection: "column",
            minHeight: "calc(100vh - 92px)",
            background: "var(--color-bg-surface)",
            color: "var(--color-text-1)",
            border: "1px solid var(--color-border)",
            borderRadius: 12, overflow: "hidden",
        }}>
            {renderStepper()}
            {globalError && (
                <div style={{
                    padding: "10px 20px", background: "rgba(239,68,68,0.1)",
                    borderBottom: "1px solid rgba(239,68,68,0.3)",
                    color: "var(--color-danger)", fontSize: 13,
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                    <span>⚠ {globalError}</span>
                    <button onClick={() => setGlobalError(null)} style={miniBtn}>✕</button>
                </div>
            )}
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                {currentStage === "upload" && renderUpload()}
                {currentStage === "pages" && renderPages()}
                {currentStage === "fields" && renderFields()}
                {currentStage === "run" && renderRun()}
                {currentStage === "results" && renderResults()}
                {currentStage === "export" && renderExport()}
            </div>
            {renderInspector()}
            {renderPreviewModal()}
            {saveAsNewOpen && (
                <div onClick={() => setSaveAsNewOpen(false)}
                    style={{
                        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        zIndex: 70, padding: 16,
                    }}>
                    <div onClick={e => e.stopPropagation()}
                        style={{
                            background: "var(--color-bg-card)",
                            border: "1px solid var(--color-border-strong)",
                            borderRadius: 12, padding: 18, minWidth: 320, maxWidth: 420,
                            boxShadow: "0 24px 60px rgba(0,0,0,0.4)",
                            color: "var(--color-text-1)",
                        }}>
                        <h4 style={{ margin: 0, marginBottom: 10, fontSize: 14 }}>
                            {t("ocr.v2.templatePicker.saveAsNewTitle")}
                        </h4>
                        <input value={newTemplateName}
                            autoFocus
                            onChange={e => setNewTemplateName(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter" && newTemplateName.trim()) saveAsNewTemplate(); }}
                            placeholder={t("ocr.v2.templatePicker.newNamePh")}
                            style={{
                                width: "100%", padding: "8px 10px", borderRadius: 8, fontSize: 13,
                                background: "var(--color-bg-panel)", color: "var(--color-text-1)",
                                border: "1px solid var(--color-border-strong)", fontFamily: "inherit",
                                marginBottom: 12,
                            }} />
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                            <button style={miniBtn} onClick={() => setSaveAsNewOpen(false)}>
                                {t("ocr.v2.templatePicker.cancel")}
                            </button>
                            <button style={ctaStyle(!newTemplateName.trim() || savingTemplate)}
                                disabled={!newTemplateName.trim() || savingTemplate}
                                onClick={saveAsNewTemplate}>
                                {savingTemplate ? "…" : t("ocr.v2.templatePicker.save")}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {confirmDialog && (
                <CreditConfirmDialog
                    open
                    reasons={confirmDialog.reasons}
                    steps={confirmDialog.steps}
                    credits={confirmDialog.credits}
                    fingerprint={confirmDialog.fingerprint}
                    balance={balance}
                    onCancel={() => setConfirmDialog(null)}
                    onConfirm={() => { const p = confirmDialog.onProceed; setConfirmDialog(null); p(); }}
                />
            )}
        </div>
    );
}

// ── Local presentational bits ────────────────────────────────────────────
function StatusPill({ status, error, attempt, t }: {
    status: BatchStatus; error?: string; attempt: "initial" | "retry";
    t: (k: string, vars?: any) => string;
}) {
    const label = status === "done" ? t("ocr.v2.batch.statusDone")
        : status === "extracting" ? t("ocr.v2.batch.statusExtracting")
        : status === "error" ? t("ocr.v2.batch.statusError")
        : t("ocr.v2.batch.statusPending");
    const bg = status === "done" ? "rgba(16,185,129,0.15)"
        : status === "extracting" ? "rgba(59,130,246,0.15)"
        : status === "error" ? "rgba(239,68,68,0.15)"
        : "var(--color-bg-elevated)";
    const fg = status === "done" ? "#10b981"
        : status === "extracting" ? "#3b82f6"
        : status === "error" ? "#ef4444"
        : "var(--color-text-3)";
    return (
        <span title={error} style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "2px 8px", borderRadius: 10, fontSize: 10,
            background: bg, color: fg, fontWeight: 600,
        }}>
            {label}{attempt === "retry" && status === "done" ? ` · ${t("ocr.v2.results.attemptRetry")}` : ""}
        </span>
    );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-3)", fontWeight: 700, marginBottom: 4 }}>
                {label}
            </div>
            {children}
        </div>
    );
}

// Shared inline style blocks (kept local to keep the module self-contained).
const miniBtn: React.CSSProperties = {
    padding: "5px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
    background: "var(--color-bg-elevated)", color: "var(--color-text-2)",
    border: "1px solid var(--color-border)", fontFamily: "inherit",
};
function ctaStyle(disabled: boolean): React.CSSProperties {
    return {
        padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
        background: disabled ? "var(--color-bg-elevated)" : "var(--color-accent)",
        color: disabled ? "var(--color-text-4)" : "#0a1628",
        border: disabled ? "1px solid var(--color-border)" : "1px solid var(--color-accent-border)",
        cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
    };
}
function chevronStyle(disabled: boolean): React.CSSProperties {
    return {
        flexShrink: 0,
        width: 44, height: 44, borderRadius: 22,
        background: disabled ? "var(--color-bg-elevated)" : "var(--color-bg-card)",
        border: "1px solid var(--color-border)",
        color: disabled ? "var(--color-text-4)" : "var(--color-text-1)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 24, lineHeight: 1, fontFamily: "inherit",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: disabled ? "none" : "0 4px 16px rgba(0,0,0,0.35)",
    };
}
const thStyle: React.CSSProperties = {
    padding: "8px 10px", textAlign: "left", fontSize: 11, fontWeight: 700,
    textTransform: "uppercase", letterSpacing: "0.05em",
    color: "var(--color-text-3)", borderBottom: "1px solid var(--color-border)",
    whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
    padding: "8px 10px", fontSize: 12, color: "var(--color-text-1)",
    borderBottom: "1px solid var(--color-border)", verticalAlign: "middle",
};
