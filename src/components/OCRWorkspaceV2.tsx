"use client";
// OCRWorkspaceV2 — UI-4b implementation (2026-07-10).
//
// Mockup spec: `pm/reports/UI-4-mockup-v3.html` (operator-approved 2026-07-09).
// Gated behind `ENABLE_OCR_WORKSPACE_V2` — flag OFF path keeps rendering the
// original `OCRWorkspace.tsx` byte-identical. See report `pm/reports/UI-4b.md`
// for scope-reality (which chunks landed FULLY vs stubbed).
//
// Design invariants:
//  - hint overlay stays MOUNTED across stage transitions (OCR-6c lesson) —
//    toggled by opacity / pointer-events, never conditionally rendered.
//  - all user-visible strings go through `t()` under the `ocr.v2.*` namespace.
//  - Props signature MUST match `OCRWorkspace` so `src/app/(app)/ocr/page.tsx`
//    can dispatch by flag with no import shuffle.
//  - Backend contract untouched. New affordances that need a server change
//    (full-doc `mode=fulldoc`, per-field retry) are wired UI-side but flagged
//    as follow-ups in the report.
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { User } from "@/lib/types";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { apiError } from "@/lib/friendlyError";
import { fetchJson } from "@/lib/fetchJson";
import { ErrorCode } from "@/lib/errorCodes";
import { pdfFileToImageDetailed, type PdfRasterResult, type StackedPageRect } from "@/lib/pdf-to-image";
import { docxFileToImage } from "@/lib/docx-to-image";
import { buildFieldCrops } from "@/lib/field-crops";
import { estimateCredits, creditTone, type CreditModel, DEFAULT_CREDIT_MODEL } from "@/lib/pricing";
import { exportOCRResult } from "@/lib/exportUtils";
import { PAGE_SELECTION_MAX } from "@/lib/ocrBatchConfig";
import { evaluateConfirm, makeFingerprint, shouldSkipDialog } from "@/lib/credit-preferences";
import { ENABLE_OCR_SCAN_LINE, ENABLE_LOADING_STORY } from "@/lib/featureFlags";
import { usePanZoom } from "@/lib/hooks/usePanZoom";
import CreditConfirmDialog from "./CreditConfirmDialog";
import OCRWorkspaceV1 from "./OCRWorkspace";

// ─── Types ────────────────────────────────────────────────────────────────
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
type OverlayStyle = "box" | "underline";
type ResultTab = "fields" | "json" | "corrections" | "positions";

interface Props {
    user: User | null;
    balance?: number;
    onDocumentProcessed?: () => void;
    onNavigateToBilling?: () => void;
}

// Field-type accent for chip/badge dots — mirrors OCRWorkspace TYPE_COLOR.
const TYPE_COLOR: Record<string, string> = {
    text: "#6366f1", number: "#f59e0b", currency: "#10b981", date: "#3b82f6",
    address: "#8b5cf6", email: "#06b6d4", table: "#ec4899", raw_text: "#dc2626",
};

const STAGE_ORDER: Stage[] = ["upload", "pages", "fields", "run", "results", "export"];

// UI-4c §3d — mini loading story (ported verbatim from OCRWorkspace v1 L45-51).
// Maps 0..100 progress to a 5-step checklist keyed to existing i18n `ocr.stepXxx`.
const LOADING_STORY_STEPS = [
    { key: "stepUpload",  endAt: 30  },
    { key: "stepPrepare", endAt: 50  },
    { key: "stepReading", endAt: 70  },
    { key: "stepExtract", endAt: 92  },
    { key: "stepFormat",  endAt: 100 },
] as const;

// ─── Component ────────────────────────────────────────────────────────────
export default function OCRWorkspaceV2({ user, balance = 0, onDocumentProcessed, onNavigateToBilling }: Props) {
    const { t } = useTranslation();

    // File + preview state (subset of OCRWorkspace — kept minimal).
    const [file, setFile] = useState<File | null>(null);
    const [previews, setPreviews] = useState<string[]>([]);
    const [pdfRaster, setPdfRaster] = useState<{ sourceFile: File; result: PdfRasterResult } | null>(null);
    const [previewPage, setPreviewPage] = useState(0);
    const [converting, setConverting] = useState<"docx" | null>(null);
    const dropRef = useRef<HTMLDivElement>(null);

    // Page selection (multi-page PDFs).
    const [selectedPages, setSelectedPages] = useState<number[]>([]);
    useEffect(() => {
        if (!pdfRaster) { setSelectedPages([]); return; }
        const total = pdfRaster.result.pagePngs.length;
        if (total <= 1) { setSelectedPages([1]); return; }
        const n = Math.min(total, PAGE_SELECTION_MAX);
        setSelectedPages(Array.from({ length: n }, (_, i) => i + 1));
    }, [pdfRaster]);

    // Templates + fields.
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
    const [advancedOpen, setAdvancedOpen] = useState(false);
    // Field rename UI state — chips become <input> when this matches f.id.
    const [renamingFieldId, setRenamingFieldId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState("");

    // Fetch templates.
    useEffect(() => {
        if (!user) return;
        fetch(`/api/templates?userId=${user.id}`).then(r => r.json())
            .then((d: any) => { if (Array.isArray(d)) setTemplates(d); })
            .catch(() => { /* best-effort */ });
    }, [user]);

    // Processing state.
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [result, setResult] = useState<OCRResult | null>(null);
    const [fulldocResult, setFulldocResult] = useState<{ pages: { page: number; text: string }[] } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState<1 | 2>(1); // 2 = retry
    const [displayedAttempt, setDisplayedAttempt] = useState<"attempt1" | "retry">("attempt1");

    // Mode + overlay + results tab.
    const [extractMode, setExtractMode] = useState<ExtractMode>("field");
    const [overlayEnabled, setOverlayEnabled] = useState(true);
    const [overlayStyle, setOverlayStyle] = useState<OverlayStyle>("box");
    const [resultTab, setResultTab] = useState<ResultTab>("fields");
    const [selectedFieldName, setSelectedFieldName] = useState<string | null>(null);
    const [expandedFieldName, setExpandedFieldName] = useState<string | null>(null);

    // Credit model — no client-facing endpoint delivers it today, so we default
    // to per_page (matches BILL-1 DEFAULT_CREDIT_MODEL). Follow-up: expose a
    // lightweight /api/user-prefs field for the client to read.
    const [activeCreditModel] = useState<CreditModel>(DEFAULT_CREDIT_MODEL);

    // ─── UI-6: template picker (favorites / recent) + save semantics ─────
    // Favorites + recent + quickMode live in localStorage per-device
    // (user_preferences table has no JSON blob column and the spec forbids
    // a schema migration — see report §Prefs shape). Default OCR template
    // reuses the existing user_preferences.default_ocr_template_id column
    // via /api/user-prefs PATCH (kind:"ocr").
    const [favoriteTemplateIds, setFavoriteTemplateIds] = useState<string[]>([]);
    const [recentTemplateIds, setRecentTemplateIds] = useState<string[]>([]);
    const [quickMode, setQuickMode] = useState<boolean>(false);
    const [templateSearch, setTemplateSearch] = useState("");
    const [defaultOcrTemplateId, setDefaultOcrTemplateId] = useState<string | null>(null);
    // Snapshot of fields JSON at the moment a template was applied — used
    // to detect dirty state ("● มีการแก้ไข") and gate the "update template" button.
    const [loadedTemplateSnapshot, setLoadedTemplateSnapshot] = useState<string | null>(null);
    // Save-as-new dialog.
    const [saveAsNewOpen, setSaveAsNewOpen] = useState(false);
    const [newTemplateName, setNewTemplateName] = useState("");
    const [savingTemplate, setSavingTemplate] = useState(false);
    // Quick-mode one-time picker (no default template yet).
    const [quickPickerOpen, setQuickPickerOpen] = useState(false);
    const [quickSetAsDefault, setQuickSetAsDefault] = useState(true);
    // Ephemeral toast for "unsaved edits" nag (non-blocking).
    const [unsavedToast, setUnsavedToast] = useState<string | null>(null);
    // Non-blocking notice toast for delete-template success / failure.
    const [noticeToast, setNoticeToast] = useState<{ text: string; tone: "success" | "error" } | null>(null);
    // Guard so quick-mode auto-run only fires once per file load.
    const quickFiredRef = useRef(false);

    // Load persisted prefs from localStorage once (SSR-safe).
    useEffect(() => {
        if (typeof localStorage === "undefined") return;
        try {
            const fav = JSON.parse(localStorage.getItem("ocr_v2_favorite_template_ids") || "[]");
            if (Array.isArray(fav)) setFavoriteTemplateIds(fav.filter(x => typeof x === "string"));
        } catch { /* ignore */ }
        try {
            const rec = JSON.parse(localStorage.getItem("ocr_v2_recent_template_ids") || "[]");
            if (Array.isArray(rec)) setRecentTemplateIds(rec.filter(x => typeof x === "string").slice(0, 3));
        } catch { /* ignore */ }
        try {
            const qm = localStorage.getItem("ocr_v2_quick_mode");
            if (qm === "1") setQuickMode(true);
        } catch { /* ignore */ }
    }, []);

    // Persist favorites / recent / quickMode when they change.
    useEffect(() => {
        if (typeof localStorage === "undefined") return;
        try { localStorage.setItem("ocr_v2_favorite_template_ids", JSON.stringify(favoriteTemplateIds)); } catch {}
    }, [favoriteTemplateIds]);
    useEffect(() => {
        if (typeof localStorage === "undefined") return;
        try { localStorage.setItem("ocr_v2_recent_template_ids", JSON.stringify(recentTemplateIds)); } catch {}
    }, [recentTemplateIds]);
    useEffect(() => {
        if (typeof localStorage === "undefined") return;
        try { localStorage.setItem("ocr_v2_quick_mode", quickMode ? "1" : "0"); } catch {}
    }, [quickMode]);

    // Fetch default OCR template id from /api/user-prefs (existing column).
    useEffect(() => {
        if (!user) return;
        fetchJson<{ defaultOcrTemplateId: string | null }>(`/api/user-prefs?userId=${user.id}`)
            .then(r => { if (r.ok) setDefaultOcrTemplateId(r.defaultOcrTemplateId); })
            .catch(() => { /* best-effort */ });
    }, [user]);

    // Dirty flag — extractFields diverges from the snapshot taken on apply.
    const templateDirty = useMemo(() => {
        if (!activeTemplateId || !loadedTemplateSnapshot) return false;
        return JSON.stringify(extractFields) !== loadedTemplateSnapshot;
    }, [activeTemplateId, loadedTemplateSnapshot, extractFields]);

    const activeTemplateName = useMemo(() => {
        if (!activeTemplateId) return null;
        return templates.find(x => x.id === activeTemplateId)?.name || null;
    }, [activeTemplateId, templates]);

    // Toggle favorite. Persist happens via effect.
    const toggleFavoriteTemplate = useCallback((id: string) => {
        setFavoriteTemplateIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    }, []);

    // Apply a template — updates fields, snapshots, promotes to recent (top).
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
        setRecentTemplateIds(prev => {
            const next = [id, ...prev.filter(x => x !== id)].slice(0, 3);
            return next;
        });
    }, [templates]);

    // Save current fields as a NEW template.
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
            console.warn("[v2 save-new-template] failed", e);
        } finally {
            setSavingTemplate(false);
        }
    }, [user, newTemplateName, extractFields]);

    // Update currently-loaded template (in place).
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
            console.warn("[v2 update-template] failed", e);
        } finally {
            setSavingTemplate(false);
        }
    }, [user, activeTemplateId, templates, extractFields]);

    // Delete a template — optimistic remove, DELETE via fetchJson, on failure
    // re-fetch to reconcile. System templates (user_id === "system" or id
    // prefixed "global-") are gated at the picker UI so this call path is
    // never reached for them; we still guard here as belt-and-braces.
    const deleteTemplate = useCallback(async (id: string) => {
        if (!user) return;
        const tpl = templates.find(x => x.id === id);
        if (!tpl) return;
        if (tpl.user_id === "system" || id.startsWith("global-")) return;
        // Optimistic remove.
        const prevList = templates;
        setTemplates(prev => prev.filter(x => x.id !== id));
        // Clear currently-loaded state if it was this template.
        if (activeTemplateId === id) {
            setActiveTemplateId(null);
            setLoadedTemplateSnapshot(null);
        }
        // Clean localStorage keys (UI-6).
        setFavoriteTemplateIds(prev => prev.filter(x => x !== id));
        setRecentTemplateIds(prev => prev.filter(x => x !== id));
        if (defaultOcrTemplateId === id) {
            setDefaultOcrTemplateId(null);
        }
        try {
            const res = await fetchJson<{ success?: boolean }>(
                `/api/templates?id=${encodeURIComponent(id)}&userId=${encodeURIComponent(user.id)}`,
                { method: "DELETE" },
            );
            if (!res.ok) {
                throw Object.assign(new Error(res.code || "delete_failed"), { code: res.code, vars: res.vars });
            }
            setNoticeToast({ text: t("ocr.v2.templatePicker.delete.success"), tone: "success" });
            setTimeout(() => setNoticeToast(null), 3000);
        } catch (err: any) {
            // Reconcile on failure — restore previous list.
            setTemplates(prevList);
            const msg = apiError(err?.code || ErrorCode.SERVER_ERROR, err?.vars, t);
            setNoticeToast({
                text: `${t("ocr.v2.templatePicker.delete.failure")}: ${msg}`,
                tone: "error",
            });
            setTimeout(() => setNoticeToast(null), 4000);
        }
    }, [user, templates, activeTemplateId, defaultOcrTemplateId, t]);

    // Persist default template selection (server-side).
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

    // Credit-confirm dialog for the retry action.
    const [confirmDialog, setConfirmDialog] = useState<{
        reasons: any[]; fingerprint: string; steps: { label: string; value: string }[]; credits: number;
        onProceed: () => void;
    } | null>(null);

    // Stage: derived from state but held explicitly so backward jumps stick.
    // UI-4c bugfix: track BOTH `currentStage` (where the user is now) and
    // `maxReachedStage` (furthest completed stage). Without the frontier, once
    // the user jumps back to `upload` every forward step got locked (`canJumpTo`
    // was gated on `idx <= cur`), producing the 5 → 1 → stuck deadlock.
    const [currentStage, setCurrentStageRaw] = useState<Stage>("upload");
    const [maxReachedStage, setMaxReachedStage] = useState<Stage>("upload");
    // Wrapper: any stage move updates the frontier monotonically. Backward
    // jumps only move `currentStage`, never lower `maxReachedStage`.
    const setCurrentStage = useCallback((s: Stage) => {
        setCurrentStageRaw(s);
        setMaxReachedStage(prev => STAGE_ORDER.indexOf(s) > STAGE_ORDER.indexOf(prev) ? s : prev);
    }, []);
    // Auto-advance rules — only forward, never backward (backward is via goToStage).
    useEffect(() => {
        if (!file) return; // stay on upload
        if (currentStage === "upload") {
            setCurrentStage(pdfRaster && pdfRaster.result.pagePngs.length > 1 ? "pages" : "fields");
        }
    }, [file, pdfRaster]); // eslint-disable-line

    // ─── UI-6 §B: ⚡ Quick mode auto-advance ──────────────────────────────
    // On file-load, when Quick mode is ON:
    //   • pages ≤ cap → auto-select all → apply default template → jump to
    //     run stage → auto-fire Extract (through requestExtract → credit
    //     confirm respected)
    //   • pages > cap → stop at "pages" stage (only unskippable step)
    //   • no default template → open one-time picker with "set as default"
    //   • fulldoc mode → skip fields, jump straight to run + transcribe
    // `quickFiredRef` guards against re-firing during the same file session.
    useEffect(() => {
        if (!quickMode || !file || quickFiredRef.current) return;
        // Wait until PDF raster is ready so we know the page count.
        if (file.type === "application/pdf" && !pdfRaster) return;
        const total = pdfRaster ? pdfRaster.result.pagePngs.length : 1;

        // Guard 1: pages > cap — user must intervene.
        if (total > PAGE_SELECTION_MAX) {
            setCurrentStage("pages");
            return;
        }
        // Auto-select all pages up to cap.
        const pages = Array.from({ length: Math.min(total, PAGE_SELECTION_MAX) }, (_, i) => i + 1);
        setSelectedPages(pages);

        // Fulldoc-mode compat: skip templates, go straight to run.
        if (extractMode === "fulldoc") {
            quickFiredRef.current = true;
            setCurrentStage("run");
            setTimeout(() => requestExtract(false), 0);
            return;
        }

        // Guard 2: no default template — open the one-time picker.
        if (!defaultOcrTemplateId) {
            // Wait until templates have arrived before opening picker; if the
            // list is genuinely empty, still open — user can pick "no template"
            // or add fields manually via the fields panel afterwards.
            setQuickPickerOpen(true);
            return;
        }
        const tpl = templates.find(x => x.id === defaultOcrTemplateId);
        if (!tpl) {
            // Default id is stale (template deleted) — open picker.
            setQuickPickerOpen(true);
            return;
        }
        // Apply + jump + fire.
        applyTemplate(tpl.id);
        quickFiredRef.current = true;
        setCurrentStage("run");
        setTimeout(() => requestExtract(false), 0);
    }, [quickMode, file, pdfRaster, defaultOcrTemplateId, templates, extractMode]); // eslint-disable-line
    useEffect(() => {
        if (loading && currentStage !== "run") setCurrentStage("run");
    }, [loading]); // eslint-disable-line
    useEffect(() => {
        if ((result || fulldocResult) && !loading && currentStage === "run") setCurrentStage("results");
    }, [result, fulldocResult, loading]); // eslint-disable-line

    // Any stage at-or-before the frontier is jumpable — plus the standard
    // prerequisite checks so a stage without its inputs (no file / no result)
    // still stays disabled.
    const canJumpTo = useCallback((target: Stage): boolean => {
        const idx = STAGE_ORDER.indexOf(target);
        const frontier = STAGE_ORDER.indexOf(maxReachedStage);
        if (idx > frontier) return false;
        if (target === "upload") return true;
        if (target === "pages") return !!file;
        if (target === "fields") return !!file;
        if (target === "run") return !!file && (extractMode === "fulldoc" || extractFields.length > 0);
        if (target === "results") return !!(result || fulldocResult);
        if (target === "export") return !!(result || fulldocResult);
        return false;
    }, [maxReachedStage, file, extractFields.length, extractMode, result, fulldocResult]);
    const goToStage = useCallback((target: Stage) => {
        if (canJumpTo(target)) setCurrentStageRaw(target);
    }, [canJumpTo]);

    // ─── UI-4c: batch mode switch (renders v1 verbatim when batch) ────────
    const [uiMode, setUiMode] = useState<"single" | "batch">("single");

    // ─── UI-4c: bbox_hint drawing (ported from v1) ────────────────────────
    // hintEditingFieldId → BboxHintLayer intercepts drag; drop rectangle
    // saves to that field's bbox_hint and persists to the active template.
    const [hintEditingFieldId, setHintEditingFieldId] = useState<string | null>(null);
    const [hintDraw, setHintDraw] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    useEffect(() => {
        if (!hintEditingFieldId) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { setHintEditingFieldId(null); setHintDraw(null); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [hintEditingFieldId]);

    // ─── UI-4c: zoom/pan (parity with v1's usePanZoom) ────────────────────
    // CRITICAL (OCR-6c invariant): the zoomed wrapper holds BOTH the image AND
    // the overlay/hint layers as siblings, so they scale in the same coord
    // space. Never scale image without overlay — that decouples the hint math.
    const [zoom, setZoom] = useState(1);
    const setZoomClamped = useCallback((z: number) => {
        setZoom(Math.max(0.5, Math.min(3, +z.toFixed(3))));
    }, []);
    const panZoom = usePanZoom({ zoom, setZoom: setZoomClamped, min: 0.5, max: 3 });

    // ─── File processing ──────────────────────────────────────────────────
    const processFile = useCallback(async (f: File) => {
        setResult(null); setFulldocResult(null); setError(null);
        previews.forEach(p => URL.revokeObjectURL(p));
        setPreviews([]); setPreviewPage(0); setPdfRaster(null);
        setAttempt(1); setDisplayedAttempt("attempt1");
        quickFiredRef.current = false; // re-arm quick-mode auto-run for new file

        const isDocx = f.name.toLowerCase().endsWith(".docx");
        if (isDocx) {
            setFile(null); setConverting("docx");
            try {
                const imgFile = await docxFileToImage(f);
                setFile(imgFile); setPreviews([URL.createObjectURL(imgFile)]);
            } catch (e) {
                console.error("[v2] docx convert failed", e);
                setError(t("ocr.convertDocxFailed"));
            } finally { setConverting(null); }
            return;
        }

        setFile(f);
        if (f.type === "application/pdf") {
            try {
                const detailed = await pdfFileToImageDetailed(f);
                setPreviews(detailed.pagePngs.map(b => URL.createObjectURL(b)));
                setPdfRaster({ sourceFile: f, result: detailed });
            } catch (e) {
                console.warn("[v2] pdf raster failed, falling back to raw preview", e);
                setPreviews([URL.createObjectURL(f)]);
            }
        } else {
            setPreviews([URL.createObjectURL(f)]);
        }
    }, [previews, t]);

    // Drop + input.
    useEffect(() => {
        const el = dropRef.current;
        if (!el) return;
        const prevent = (e: DragEvent) => e.preventDefault();
        const onDrop = (e: DragEvent) => {
            e.preventDefault();
            const fl = e.dataTransfer?.files;
            if (fl && fl.length > 0) processFile(fl[0]);
        };
        el.addEventListener("dragover", prevent);
        el.addEventListener("drop", onDrop);
        return () => { el.removeEventListener("dragover", prevent); el.removeEventListener("drop", onDrop); };
    }, [processFile]);

    // ─── Upload plumbing ──────────────────────────────────────────────────
    const prepareUploadWithCrops = useCallback(async (
        source: File, selection?: number[],
    ): Promise<{ uploadFile: File; crops: any[]; renderedPages: number[]; totalPages: number | null; }> => {
        let uploadFile: File = source;
        let pageRects: StackedPageRect[] | null = null;
        let renderedPages: number[] = [];
        let totalPages: number | null = null;
        if (source.type === "application/pdf") {
            try {
                const cached = pdfRaster && pdfRaster.sourceFile === source ? pdfRaster.result : null;
                totalPages = cached ? cached.pageNumbers.length : null;
                const wantsSubset = Array.isArray(selection) && selection.length > 0 && cached
                    && !(selection.length === cached.pageNumbers.length
                         && selection.every((p, i) => p === cached.pageNumbers[i]));
                const detailed = wantsSubset
                    ? await pdfFileToImageDetailed(source, { pages: selection! })
                    : (cached ?? await pdfFileToImageDetailed(source));
                uploadFile = detailed.file;
                pageRects = detailed.pageRects;
                renderedPages = detailed.pageNumbers.slice();
                if (totalPages === null) totalPages = detailed.pageNumbers.length;
            } catch (e) { console.error("[v2] pdf convert failed", e); }
        }
        let crops: any[] = [];
        if (extractFields.some(f => f.bbox_hint)) {
            try { crops = await buildFieldCrops(uploadFile, extractFields, pageRects, renderedPages); }
            catch (e) { console.warn("[v2] crop build failed", e); crops = []; }
        }
        return { uploadFile, crops, renderedPages, totalPages };
    }, [extractFields, pdfRaster]);

    const runExtract = useCallback(async (isRetry: boolean) => {
        if (!file) return;
        setLoading(true); setResult(null); setFulldocResult(null); setError(null);
        setProgress(15);
        try {
            const { uploadFile, crops, renderedPages, totalPages } = await prepareUploadWithCrops(file, selectedPages);
            const fd = new FormData();
            fd.append("file", uploadFile);
            if (user) fd.append("userId", user.id);
            if (extractMode === "fulldoc") {
                // Full-doc transcription — backend does NOT yet honour this
                // part. Sent for forward-compat; see UI-4b report §API-4
                // follow-up. Server today ignores unknown parts.
                fd.append("mode", "fulldoc");
                // Send a placeholder single-field spec so the current backend
                // path still returns SOMETHING (a `raw_text`-style dump).
                fd.append("fields", "full_document (raw_text)");
                fd.append("fields_json", JSON.stringify([
                    { id: "fulldoc", name: "full_document", type: "raw_text" },
                ]));
            } else {
                fd.append("fields", extractFields.map(f => f.type !== "text" ? `${f.name} (${f.type})` : f.name).join(", "));
                fd.append("fields_json", JSON.stringify(extractFields));
                if (crops.length > 0) {
                    fd.append("field_crops", JSON.stringify(
                        crops.map((c, i) => ({ index: i, fieldName: c.fieldName, page: c.page }))
                    ));
                    crops.forEach((c, i) => fd.append(`crop_${i}`, new File([c.blob], `crop_${i}.png`, { type: "image/png" })));
                }
            }
            if (totalPages !== null && totalPages > 0) fd.append("total_pages", String(totalPages));
            if (renderedPages.length > 0 && totalPages !== null
                && !(renderedPages.length === totalPages && renderedPages.every((p, i) => p === i + 1))) {
                fd.append("pages", JSON.stringify(renderedPages));
            }
            if (isRetry) fd.append("retry", "true");

            setProgress(35);
            const data = await fetchJson<{ documentId?: string }>("/api/upload", { method: "POST", body: fd });
            if (!data.ok) {
                if (data.code === ErrorCode.INSUFFICIENT_CREDITS && onNavigateToBilling) {
                    onNavigateToBilling(); return;
                }
                throw Object.assign(new Error(data.code), { code: data.code, vars: data.vars });
            }
            if (!data.documentId) throw new Error("no_doc_id");
            setProgress(55);
            // Poll.
            const started = Date.now();
            while (true) {
                if (Date.now() - started > 60000) throw new Error("timeout");
                await new Promise(r => setTimeout(r, 2000));
                setProgress(p => Math.min(90, p + 6));
                try {
                    const res = await fetch(`/api/status?id=${data.documentId}`);
                    const s = await res.json() as { status?: string; data?: any };
                    if (s.status === "completed") {
                        if (extractMode === "fulldoc") {
                            // Server hasn't been taught fulldoc yet — synthesise
                            // a per-page transcript view by joining any string
                            // values in the response. Follow-up: proper shape.
                            const txt = Object.values(s.data || {})
                                .map((v: any) => (v && typeof v === "object" && "value" in v) ? String(v.value) : String(v ?? ""))
                                .join("\n\n");
                            setFulldocResult({ pages: [{ page: 1, text: txt }] });
                        } else {
                            setResult(s.data);
                        }
                        setProgress(100);
                        setAttempt(isRetry ? 2 : 1);
                        setDisplayedAttempt(isRetry ? "retry" : "attempt1");
                        if (onDocumentProcessed) onDocumentProcessed();
                        setTimeout(() => { setLoading(false); setProgress(0); }, 400);
                        return;
                    }
                    if (s.status === "error") throw new Error("ai_failed");
                } catch (inner: any) {
                    if (inner?.message === "ai_failed" || inner?.message === "timeout") throw inner;
                    // transient — keep polling
                }
            }
        } catch (err: any) {
            const code = err?.code || (err?.message === "ai_failed" ? ErrorCode.AI_FAILED : ErrorCode.UPLOAD_FAILED);
            setError(apiError(code, err?.vars, t));
            setLoading(false); setProgress(0);
        }
    }, [file, selectedPages, extractFields, extractMode, user, prepareUploadWithCrops, onDocumentProcessed, onNavigateToBilling, t]);

    // ─── Credit estimate ──────────────────────────────────────────────────
    const estimate = useMemo(() => estimateCredits({
        operation: "ocr",
        fields: extractFields.length,
        pages: selectedPages.length || 1,
        creditModel: activeCreditModel,
    }), [extractFields.length, selectedPages.length, activeCreditModel]);
    const creditLabel = useMemo(() => {
        if (activeCreditModel === "per_page")
            return t("ocr.v2.creditPerPage", { n: selectedPages.length || 1 });
        if (activeCreditModel === "per_file")
            return t("ocr.v2.creditPerFile");
        return t("ocr.v2.creditFormula", { n: extractFields.length });
    }, [activeCreditModel, selectedPages.length, extractFields.length, t]);

    // ─── Extract (with credit-confirm) + Retry ───────────────────────────
    // Shared entry point: applies the same T1-T4 evaluation + per-template
    // "don't ask again" logic used by the manual Extract CTA, then either
    // fires runExtract or opens CreditConfirmDialog. Used by:
    //  • manual Extract CTA in run stage
    //  • ⚡ Quick mode auto-run (UI-6 §B3 — must NOT bypass credit confirm)
    //  • ⟳ Retry action on results
    const requestExtract = useCallback((isRetry: boolean) => {
        if (!file) return;
        // Warn (non-blocking) if the fields have diverged from the loaded template.
        if (!isRetry && templateDirty) {
            setUnsavedToast(t("ocr.v2.templatePicker.unsavedRunToast"));
            setTimeout(() => setUnsavedToast(null), 5000);
        }
        const fp = makeFingerprint({
            operation: "ocr",
            templateId: activeTemplateId,
            fieldCount: extractFields.length,
            docCount: 1,
        });
        const proceed = () => runExtract(isRetry);
        if (shouldSkipDialog(fp)) { proceed(); return; }
        const ev = evaluateConfirm({
            estimate: estimate.credits, balance,
            hasTableField: extractFields.some(f => f.type === "table"),
        });
        if (!ev.needsConfirm) { proceed(); return; }
        setConfirmDialog({
            reasons: ev.reasons, fingerprint: fp,
            steps: estimate.steps, credits: estimate.credits,
            onProceed: proceed,
        });
    }, [file, templateDirty, activeTemplateId, extractFields, estimate, balance, runExtract, t]);

    const requestRetry = useCallback(() => requestExtract(true), [requestExtract]);

    // ─── Field composer helpers ──────────────────────────────────────────
    const addField = () => {
        if (!newFieldName.trim()) return;
        setExtractFields(prev => [...prev, { id: crypto.randomUUID(), name: newFieldName.trim(), type: newFieldType }]);
        setNewFieldName("");
    };
    const removeField = (id: string) => setExtractFields(prev => prev.filter(f => f.id !== id));
    const startRename = (f: ExtractField) => {
        if (currentStage !== "fields") return; // rename gated to before-run
        setRenamingFieldId(f.id); setRenameDraft(f.name);
    };
    const commitRename = () => {
        if (!renamingFieldId) return;
        const name = renameDraft.trim();
        if (name) setExtractFields(prev => prev.map(f => f.id === renamingFieldId ? { ...f, name } : f));
        setRenamingFieldId(null); setRenameDraft("");
    };

    // Result field row helpers.
    const resultEntries = useMemo(() => {
        if (!result) return [] as { key: string; value: string; confidence: number; source: string; bbox: any; corrections: any[]; raw: any; }[];
        return Object.entries(result)
            .filter(([k]) => !k.startsWith("_"))
            .map(([k, v]: [string, any]) => {
                if (v && typeof v === "object") {
                    return {
                        key: k,
                        value: String(v.value ?? ""),
                        confidence: Number(v.confidence ?? 0),
                        source: v.crop_miss ? "crop_miss" : v.crop_no_match ? "crop_no_match" : v.source || "ai",
                        bbox: v.bbox || v.bbox_hint || null,
                        corrections: Array.isArray(v.corrections) ? v.corrections : [],
                        raw: v,
                    };
                }
                return { key: k, value: String(v ?? ""), confidence: 0, source: "ai", bbox: null, corrections: [], raw: v };
            });
    }, [result]);

    const allCorrections = useMemo(() => {
        return resultEntries.flatMap(e => e.corrections.map((c: any) => ({ field: e.key, original: c.original, corrected: c.corrected, why: c.why })));
    }, [resultEntries]);

    const lowConfidence = useMemo(() => resultEntries.some(e => e.confidence > 0 && e.confidence < 60), [resultEntries]);

    // Client-side revert (แก้คำ tab, "ใช้ค่าเดิม").
    const revertCorrection = (fieldKey: string, original: string) => {
        setResult(prev => {
            if (!prev) return prev;
            const cur = prev[fieldKey];
            if (cur && typeof cur === "object") {
                return { ...prev, [fieldKey]: { ...cur, value: original, _reverted: true } };
            }
            return { ...prev, [fieldKey]: original };
        });
    };

    // Update a field value (Fields tab inline edit).
    const updateFieldValue = (fieldKey: string, value: string) => {
        setResult(prev => {
            if (!prev) return prev;
            const cur = prev[fieldKey];
            if (cur && typeof cur === "object") return { ...prev, [fieldKey]: { ...cur, value } };
            return { ...prev, [fieldKey]: value };
        });
    };

    // ─── Export ──────────────────────────────────────────────────────────
    const doExport = (format: "excel" | "csv" | "json") => {
        if (extractMode === "fulldoc" && fulldocResult) {
            const blob = format === "json"
                ? new Blob([JSON.stringify(fulldocResult, null, 2)], { type: "application/json" })
                : new Blob([fulldocResult.pages.map(p => `--- ${t("ocr.v2.pageLabel", { n: p.page })} ---\n${p.text}`).join("\n\n")], { type: "text/plain" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `OCR_fulldoc_${Date.now()}.${format === "json" ? "json" : "txt"}`;
            a.click();
            return;
        }
        if (!result) return;
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        if (format === "json") {
            const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob); a.download = `OCR_${ts}.json`; a.click();
            return;
        }
        exportOCRResult(result, `OCR_${ts}`, format);
    };

    // ─── Bbox hint commit (persist to active template like v1) ────────────
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
        if (activeTemplateId && user) {
            const tpl = templates.find(x => x.id === activeTemplateId);
            if (tpl) {
                fetch("/api/templates", {
                    method: "POST",
                    body: JSON.stringify({ userId: user.id, name: tpl.name, fields: next, id: activeTemplateId }),
                }).catch(err => console.warn("[v2 bbox_hint] template save failed", err));
            }
        }
    }, [extractFields, activeTemplateId, user, templates, previewPage]);

    const resetAll = () => {
        setFile(null); previews.forEach(p => URL.revokeObjectURL(p));
        setPreviews([]); setPdfRaster(null); setResult(null); setFulldocResult(null);
        setError(null); setSelectedPages([]);
        setCurrentStageRaw("upload"); setMaxReachedStage("upload");
        setAttempt(1); setDisplayedAttempt("attempt1"); setResultTab("fields");
        setHintEditingFieldId(null); setHintDraw(null); setZoom(1);
        quickFiredRef.current = false;
    };

    // ─── Sub-render helpers ──────────────────────────────────────────────
    // Stepper — always visible.
    // UI-4c §3d: ModeSwitch is now inline on the right of this row (no more
    // separate header strip above). Steps flex-grow to the left; ModeSwitch
    // sits at the far right so it never scrolls off with the step chips.
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
                    const failed = current && !!error && s === "upload";
                    const jumpable = canJumpTo(s);
                    return (
                        <React.Fragment key={s}>
                            {i > 0 && (
                                <div style={{ color: "var(--color-text-4)", display: "flex", alignItems: "center", padding: "0 2px" }}>→</div>
                            )}
                            <button
                                onClick={() => goToStage(s)}
                                disabled={!jumpable}
                                title={jumpable ? labels[s] : ""}
                                style={{
                                    display: "flex", alignItems: "center", gap: 8,
                                    padding: "8px 14px", borderRadius: 10, whiteSpace: "nowrap",
                                    fontSize: 12.5, fontWeight: current ? 600 : 400,
                                    border: current ? "1px solid var(--color-accent-border)" : "1px solid transparent",
                                    background: current ? "var(--color-accent-dim)" : "transparent",
                                    color: failed ? "var(--color-danger)"
                                        : current ? "var(--color-text-1)"
                                        : done ? "var(--color-text-2)"
                                        : "var(--color-text-3)",
                                    cursor: jumpable ? "pointer" : "default",
                                    fontFamily: "inherit",
                                }}>
                                <span style={{
                                    width: 20, height: 20, borderRadius: "50%",
                                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                                    fontSize: 11, fontWeight: 700,
                                    background: failed ? "var(--color-danger)" : done ? "var(--color-success)"
                                        : current ? "var(--color-accent)" : "var(--color-bg-elevated)",
                                    color: (done || current) ? "#0a1628" : "var(--color-text-3)",
                                    border: (done || current || failed) ? "none" : "1px solid var(--color-border-strong)",
                                }}>{done ? "✓" : failed ? "!" : i + 1}</span>
                                <span>{labels[s]}</span>
                            </button>
                        </React.Fragment>
                    );
                })}
                {/* UI-4c §3d — right-aligned ModeSwitch on the stepper bar. */}
                <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0, paddingLeft: 12 }}>
                    <ModeSwitch mode={uiMode} onChange={setUiMode} t={t} />
                </div>
            </div>
        );
    };

    // Page strip (below preview).
    const renderPageStrip = () => {
        if (!pdfRaster || pdfRaster.result.pagePngs.length <= 1) return null;
        return (
            <div style={{
                display: "flex", gap: 8, padding: "10px 12px",
                background: "var(--color-bg-panel)",
                borderTop: "1px solid var(--color-border)",
                overflowX: "auto",
            }}>
                {previews.map((src, i) => {
                    const pageNum = i + 1;
                    const selected = selectedPages.includes(pageNum);
                    const active = i === previewPage;
                    return (
                        <div key={i} onClick={() => setPreviewPage(i)}
                            style={{
                                position: "relative",
                                width: 56, height: 74, borderRadius: 8,
                                background: "#d0d7e2", color: "#0f172a",
                                border: active ? "2px solid var(--color-accent)" : "2px solid transparent",
                                boxShadow: active ? "0 0 0 3px var(--color-accent-dim)" : "none",
                                opacity: selected ? 1 : 0.35,
                                cursor: "pointer", flexShrink: 0,
                                display: "flex", alignItems: "flex-end", justifyContent: "center",
                                fontSize: 9.5, fontWeight: 700, paddingBottom: 3,
                                backgroundImage: `url(${src})`, backgroundSize: "cover", backgroundPosition: "top center",
                            }}
                            title={t("ocr.v2.strip.pageTitle", { n: pageNum })}
                        >
                            <span style={{ background: "rgba(255,255,255,0.85)", padding: "0 4px", borderRadius: 3 }}>{pageNum}</span>
                        </div>
                    );
                })}
            </div>
        );
    };

    // ─── Preview zone (LEFT) ─────────────────────────────────────────────
    // CRITICAL: this block renders unconditionally on every stage after
    // upload. Overlay layer stays MOUNTED — toggled by opacity + pointer
    // events only. See UI-4b report §Overlay-preservation.
    const renderPreview = () => {
        if (!file) return null;
        const src = previews[previewPage] || previews[0];
        const showOverlay = overlayEnabled && !!result && currentStage !== "run";
        return (
            <div style={{
                background: "var(--color-bg-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 12, padding: 12, minHeight: 460,
                display: "flex", flexDirection: "column", gap: 10,
            }}>
                {/* Preview toolbar — overlay + zoom controls */}
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-2)", fontSize: 12 }}>
                        {pdfRaster && pdfRaster.result.pagePngs.length > 1 && (
                            <span>{t("ocr.v2.preview.pageOf", { n: previewPage + 1, total: pdfRaster.result.pagePngs.length })}</span>
                        )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {/* Zoom controls (UI-4c 3c) — buttons drive the same
                            `zoom` state as the pan/wheel gestures. */}
                        <div style={{
                            display: "inline-flex", alignItems: "center", gap: 2,
                            background: "var(--color-bg-elevated)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 8, padding: "2px 4px",
                        }}>
                            <button onClick={() => setZoomClamped(zoom - 0.25)}
                                disabled={zoom <= 0.5} title={t("ocr.v2.zoom.out")}
                                style={miniZoomBtnStyle(zoom <= 0.5)}>−</button>
                            <button onClick={() => setZoom(1)} title={t("ocr.v2.zoom.reset")}
                                style={{ ...miniZoomBtnStyle(false), minWidth: 40, fontSize: 10.5 }}>
                                {Math.round(zoom * 100)}%
                            </button>
                            <button onClick={() => setZoomClamped(zoom + 0.25)}
                                disabled={zoom >= 3} title={t("ocr.v2.zoom.in")}
                                style={miniZoomBtnStyle(zoom >= 3)}>+</button>
                            <button onClick={() => setZoom(1)} title={t("ocr.v2.zoom.reset")}
                                style={miniZoomBtnStyle(false)}>⟳</button>
                        </div>
                        <button onClick={() => setOverlayEnabled(v => !v)}
                            title={t("ocr.v2.overlay.toggle")}
                            style={{
                                width: 32, height: 32, borderRadius: 8, cursor: "pointer",
                                background: overlayEnabled ? "var(--color-accent-dim)" : "var(--color-bg-elevated)",
                                color: overlayEnabled ? "var(--color-accent)" : "var(--color-text-2)",
                                border: `1px solid ${overlayEnabled ? "var(--color-accent-border)" : "var(--color-border)"}`,
                                fontSize: 14,
                            }}>👁</button>
                        <div style={{
                            display: "inline-flex",
                            background: "var(--color-bg-elevated)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 8, padding: 2,
                        }}>
                            {(["box", "underline"] as OverlayStyle[]).map(s => (
                                <button key={s} onClick={() => setOverlayStyle(s)}
                                    style={{
                                        padding: "4px 10px", fontSize: 11, fontWeight: 600,
                                        background: overlayStyle === s ? "var(--color-bg-card)" : "transparent",
                                        color: overlayStyle === s ? "var(--color-text-1)" : "var(--color-text-2)",
                                        border: overlayStyle === s ? "1px solid var(--color-border-strong)" : "none",
                                        borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                                    }}>{s === "box" ? t("ocr.v2.overlay.box") : t("ocr.v2.overlay.underline")}</button>
                            ))}
                        </div>
                    </div>
                </div>
                {/* Pan/zoom scrollable container. Same coordinate contract as v1:
                    the zoomed inner div holds BOTH <img> AND overlay layers as
                    siblings, so `width:100*zoom%` scales them together. Never
                    transform image without overlay — that decouples hint math. */}
                <div
                    {...panZoom.containerProps}
                    style={{
                        position: "relative", flex: 1, minHeight: 380,
                        background: "#f8fafc", borderRadius: 8,
                        overflow: "auto",
                        display: "flex",
                        alignItems: "safe center",
                        justifyContent: "safe center",
                        ...panZoom.containerProps.style,
                    }}
                >
                    {/* Scan-line: cheap CSS overlay, only visible while loading.
                        Absolute in container so it doesn't shift the coord space. */}
                    {ENABLE_OCR_SCAN_LINE && loading && (
                        <div className="docroom-scan-line" aria-hidden />
                    )}
                    <div style={{
                        width: `${100 * zoom}%`,
                        flexShrink: 0,
                        display: "block",
                        position: "relative", // anchor for overlay + hint layer
                    }}>
                        {src && <img src={src} alt="doc preview" draggable={false}
                            style={{ width: "100%", height: "auto", display: "block", pointerEvents: "none" }} />}
                        {/* Hint draw + stored-hint layer — ALWAYS in DOM
                            (OCR-6c invariant: mount stays; coord math is anchored
                            to this wrapper). UI-4c 3c-3: the 👁 toggle now gates
                            visibility for BOTH the result overlay AND the hint
                            layer via opacity + pointer-events, so one control
                            shows/hides everything. When a user is actively
                            drawing a hint, we force the layer visible so they
                            can complete the drag even if 👁 was previously off. */}
                        <div style={{
                            position: "absolute", inset: 0,
                            opacity: (overlayEnabled || hintEditingFieldId) ? 1 : 0,
                            pointerEvents: (overlayEnabled || hintEditingFieldId) ? "auto" : "none",
                            transition: "opacity 0.15s ease",
                        }}>
                            <BboxHintLayer
                                fields={extractFields}
                                currentPage={previewPage + 1}
                                editingFieldId={hintEditingFieldId}
                                draw={hintDraw}
                                onDrawUpdate={setHintDraw}
                                onDrawCommit={(fid, r) => {
                                    commitHintDraw(fid, r);
                                    setHintDraw(null);
                                    setHintEditingFieldId(null);
                                }}
                                drawLabel={t("ocr.v2.hint.dragTo")}
                            />
                        </div>
                        {/* Result-overlay layer — ALWAYS in DOM. Opacity + pointer-events
                            gate visibility so the coordinate space never remounts. */}
                        <div style={{
                            position: "absolute", inset: 0,
                            opacity: showOverlay ? 1 : 0,
                            pointerEvents: showOverlay ? "auto" : "none",
                            transition: "opacity 0.15s ease",
                        }}>
                        {resultEntries.map((e, i) => {
                            if (!e.bbox) return null;
                            const b = e.bbox;
                            if (b.page && b.page !== previewPage + 1) return null;
                            const color = TYPE_COLOR[extractFields.find(f => f.name === e.key)?.type || "text"] || "#06b6d4";
                            const isSelected = selectedFieldName === e.key;
                            if (overlayStyle === "underline") {
                                return (
                                    <div key={i} onClick={() => setSelectedFieldName(e.key)}
                                        style={{
                                            position: "absolute",
                                            left: `${b.x * 100}%`, top: `${(b.y + b.height) * 100}%`,
                                            width: `${b.width * 100}%`,
                                            borderBottom: `${isSelected ? 4 : 3}px solid ${color}`,
                                            cursor: "pointer",
                                        }} />
                                );
                            }
                            return (
                                <div key={i} onClick={() => setSelectedFieldName(e.key)}
                                    style={{
                                        position: "absolute",
                                        left: `${b.x * 100}%`, top: `${b.y * 100}%`,
                                        width: `${b.width * 100}%`, height: `${b.height * 100}%`,
                                        border: `${isSelected ? 3 : 2}px solid ${color}`,
                                        background: `${color}1a`,
                                        borderRadius: 3, cursor: "pointer",
                                        boxShadow: isSelected ? `0 0 0 4px ${color}33` : "none",
                                    }} />
                            );
                        })}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    // ─── Right-panel content by stage ────────────────────────────────────
    const renderUploadPanel = () => (
        <>
            <div style={panelTitleStyle}>
                <span style={stageNumStyle}>1</span>{t("ocr.v2.upload.title")}
            </div>
            {/* UI-4c 4a: when a file is already loaded and the user is on the
                upload stage (typically after jumping back from results), give
                a prominent "use existing" button as the primary path — the
                dropzone remains for a fresh drop. This fixes the deadlock
                where the user could get here but had no way forward. */}
            {file && (
                <div style={{
                    ...cardStyle,
                    borderColor: "var(--color-accent-border)",
                    background: "var(--color-accent-dim)",
                }}>
                    <h4 style={cardHeadStyle}>{t("ocr.v2.upload.existingHead")}</h4>
                    <p style={{ margin: "0 0 10px 0", fontSize: 12.5, color: "var(--color-text-2)" }}>
                        <b>{file.name}</b>
                        {previews.length > 1 && (
                            <span> · {previews.length} {t("common.page")}</span>
                        )}
                    </p>
                    <button style={{ ...primaryBtnStyle, width: "100%" }}
                        onClick={() => {
                            // Jump forward to the furthest completed stage,
                            // OR to the natural next stage (pages/fields).
                            const target: Stage = STAGE_ORDER.indexOf(maxReachedStage) > STAGE_ORDER.indexOf("upload")
                                ? maxReachedStage
                                : (pdfRaster && pdfRaster.result.pagePngs.length > 1 ? "pages" : "fields");
                            goToStage(target);
                        }}>
                        {t("ocr.v2.upload.useExisting")} →
                    </button>
                </div>
            )}
            <div style={cardStyle}>
                <h4 style={cardHeadStyle}>{t("ocr.v2.upload.tipsTitle")}</h4>
                <div style={{ fontSize: 12.5, color: "var(--color-text-2)", lineHeight: 1.6 }}>
                    {t("ocr.uploadSubtext")}
                </div>
            </div>
            <div style={cardStyle}>
                <h4 style={cardHeadStyle}>{t("ocr.v2.upload.nextTitle")}</h4>
                <ul style={{ padding: 0, margin: 0, listStyle: "none", fontSize: 12.5, color: "var(--color-text-2)" }}>
                    <li style={{ padding: "4px 0" }}>✓ {t("ocr.v2.upload.next1")}</li>
                    <li style={{ padding: "4px 0" }}>✓ {t("ocr.v2.upload.next2")}</li>
                    <li style={{ padding: "4px 0" }}>✓ {t("ocr.v2.upload.next3")}</li>
                </ul>
            </div>
        </>
    );

    const renderPagesPanel = () => {
        const total = pdfRaster?.result.pagePngs.length || 0;
        return (
            <>
                <div style={panelTitleStyle}>
                    <span style={stageNumStyle}>2</span>{t("ocr.v2.pages.title")}
                </div>
                <div style={cardStyle}>
                    <h4 style={cardHeadStyle}>{t("ocr.v2.pages.summary", { n: selectedPages.length, total })}</h4>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-2)" }}>
                        {t("ocr.v2.pages.tip", { max: PAGE_SELECTION_MAX })}
                    </p>
                    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                        <button style={miniBtnStyle} onClick={() => {
                            const n = Math.min(total, PAGE_SELECTION_MAX);
                            setSelectedPages(Array.from({ length: n }, (_, i) => i + 1));
                        }}>{t("ocr.v2.pages.selectAll")}</button>
                        <button style={miniBtnStyle} onClick={() => setSelectedPages([])}>{t("ocr.v2.pages.clear")}</button>
                    </div>
                </div>
                <button style={{ ...primaryBtnStyle, width: "100%" }}
                    onClick={() => goToStage("fields")}
                    disabled={selectedPages.length === 0}>
                    {t("ocr.v2.pages.next")} →
                </button>
            </>
        );
    };

    const renderFieldsPanel = () => (
        <>
            <div style={panelTitleStyle}>
                <span style={stageNumStyle}>3</span>{t("ocr.v2.fields.title")}
            </div>
            {/* Mode chooser (fulldoc vs field extract) */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                <button onClick={() => setExtractMode("field")}
                    style={{
                        ...cardStyle, marginBottom: 0, cursor: "pointer", textAlign: "left",
                        border: extractMode === "field" ? "1px solid var(--color-accent-border)" : "1px solid var(--color-border)",
                        background: extractMode === "field" ? "var(--color-accent-dim)" : "var(--color-bg-card)",
                    }}>
                    <div style={{ fontSize: 20 }}>📋</div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 4 }}>{t("ocr.v2.fields.modeField")}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>{t("ocr.v2.fields.modeFieldSub")}</div>
                </button>
                <button onClick={() => setExtractMode("fulldoc")}
                    style={{
                        ...cardStyle, marginBottom: 0, cursor: "pointer", textAlign: "left",
                        border: extractMode === "fulldoc" ? "1px solid var(--color-accent-border)" : "1px solid var(--color-border)",
                        background: extractMode === "fulldoc" ? "var(--color-accent-dim)" : "var(--color-bg-card)",
                    }}>
                    <div style={{ fontSize: 20 }}>📝</div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 4 }}>{t("ocr.v2.fields.modeFulldoc")}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>{t("ocr.v2.fields.modeFulldocSub")}</div>
                </button>
            </div>

            {extractMode === "field" && (
                <>
                    {/* Template picker panel — UI-6 §A: search + ⭐ Favorites +
                        🕐 Recent + 📋 All sections. Star toggle per row. */}
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

                    {/* Field chip composer */}
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}>{t("ocr.v2.fields.fieldsHead")} ({extractFields.length})</h4>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {extractFields.map(f => {
                                const isRenaming = renamingFieldId === f.id;
                                const dotColor = TYPE_COLOR[f.type] || "#94a3b8";
                                if (isRenaming) {
                                    return (
                                        <input key={f.id} autoFocus
                                            value={renameDraft}
                                            onChange={e => setRenameDraft(e.target.value)}
                                            onBlur={commitRename}
                                            onKeyDown={e => {
                                                if (e.key === "Enter") commitRename();
                                                if (e.key === "Escape") { setRenamingFieldId(null); setRenameDraft(""); }
                                            }}
                                            title={t("ocr.v2.fields.renameTooltip")}
                                            style={{
                                                fontSize: 12, padding: "5px 10px", borderRadius: 999,
                                                background: "var(--color-bg-panel)", color: "var(--color-text-1)",
                                                border: "1px solid var(--color-accent-border)",
                                            }} />
                                    );
                                }
                                return (
                                    <span key={f.id}
                                        onDoubleClick={() => startRename(f)}
                                        title={currentStage === "fields" ? t("ocr.v2.fields.dblClickToRename") : t("ocr.v2.fields.renameLocked")}
                                        style={{
                                            display: "inline-flex", alignItems: "center", gap: 6,
                                            padding: "5px 10px", borderRadius: 999,
                                            background: "var(--color-bg-panel)",
                                            border: "1px solid var(--color-border-strong)",
                                            fontSize: 12,
                                            cursor: currentStage === "fields" ? "text" : "default",
                                        }}>
                                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }} />
                                        {f.name}
                                        {/* UI-4c Chunk 1: 📍 pin toggle — click to
                                            enter hint-draw mode for this field. Shift-click
                                            clears an existing hint (mirrors v1). */}
                                        <button
                                            onClick={ev => {
                                                ev.stopPropagation();
                                                if (currentStage !== "fields") return;
                                                if (ev.shiftKey && f.bbox_hint) {
                                                    setExtractFields(prev => prev.map(x => x.id === f.id ? { ...x, bbox_hint: undefined } : x));
                                                    return;
                                                }
                                                setHintEditingFieldId(hintEditingFieldId === f.id ? null : f.id);
                                            }}
                                            title={f.bbox_hint
                                                ? t("ocr.v2.hint.pinFilled")
                                                : t("ocr.v2.hint.pinEmpty")}
                                            style={{
                                                background: hintEditingFieldId === f.id ? "#dc2626" : "transparent",
                                                color: hintEditingFieldId === f.id ? "#fff"
                                                    : f.bbox_hint ? "#dc2626" : "var(--color-text-4)",
                                                border: "none", cursor: currentStage === "fields" ? "pointer" : "default",
                                                fontSize: 11, padding: "0 3px", borderRadius: 3,
                                                opacity: (f.bbox_hint || hintEditingFieldId === f.id) ? 1 : 0.65,
                                            }}>📍</button>
                                        <button onClick={e => { e.stopPropagation(); removeField(f.id); }}
                                            title={t("ocr.v2.fields.remove")}
                                            style={{ background: "none", border: "none", color: "var(--color-text-3)", cursor: "pointer", fontSize: 12, padding: 0 }}>
                                            ✕
                                        </button>
                                    </span>
                                );
                            })}
                        </div>
                        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                            <input value={newFieldName}
                                onChange={e => setNewFieldName(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") addField(); }}
                                placeholder={t("ocr.v2.fields.newFieldPlaceholder")}
                                style={{
                                    flex: 1, fontSize: 12.5, padding: "8px 12px", borderRadius: 8,
                                    background: "var(--color-bg-panel)", color: "var(--color-text-1)",
                                    border: "1px solid var(--color-border-strong)", fontFamily: "inherit",
                                }} />
                            {/* UI-4c §3d — custom field-type dropdown. All 8
                                types from v1 are restored; native <select>
                                replaced with a token-styled panel that shows a
                                colored dot + Thai/EN label. Wire format is
                                unchanged (see runExtract line ~577). */}
                            <FieldTypeDropdown value={newFieldType} onChange={setNewFieldType} t={t} />
                            <button onClick={addField} style={{ ...miniBtnStyle, padding: "6px 12px" }}>
                                + {t("ocr.v2.fields.add")}
                            </button>
                        </div>

                        {/* "ปรับความแม่นยำ" expander — UI-4c §3e.
                            - Title renamed from "ตัวเลือกขั้นสูง" to "ปรับความแม่นยำ" per operator.
                            - One-line sub description below the toggle (always visible).
                            - Hint-drawing row now has an on/off toggle wired to the
                              SAME draw-mode state that the 📍 chip uses (`hintEditingFieldId`).
                              Turning ON arms the first field for drawing; the 📍 chips let
                              the user re-target which field the box is for. Turning OFF
                              clears the draw mode.
                            - The "บันทึกทับ template" row was removed — the dedicated save
                              button in TemplatePickerPanel (UI-6) covers this. */}
                        <div style={{ borderTop: "1px solid var(--color-border)", marginTop: 12, paddingTop: 8 }}>
                            <button onClick={() => setAdvancedOpen(v => !v)}
                                style={{
                                    background: "none", border: "none", color: "var(--color-text-2)",
                                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                                    fontFamily: "inherit", padding: "6px 0", textAlign: "left",
                                }}>
                                {advancedOpen ? "▾" : "▸"} {t("ocr.v2.fields.advanced")}
                            </button>
                            <div style={{ fontSize: 11, color: "var(--color-text-3)", paddingLeft: 16, marginTop: -4, marginBottom: 4 }}>
                                {t("ocr.v2.fields.advancedSub")}
                            </div>
                            {advancedOpen && (
                                <div style={{ fontSize: 12, color: "var(--color-text-2)", paddingLeft: 4 }}>
                                    <div style={{
                                        padding: "8px 0",
                                        display: "flex", alignItems: "flex-start", gap: 10,
                                    }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div>{t("ocr.v2.fields.advHintDraw")}</div>
                                            <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                                                {t("ocr.v2.fields.advHintDrawSub")}
                                            </div>
                                        </div>
                                        {(() => {
                                            const hintOn = !!hintEditingFieldId;
                                            const toggleHint = () => {
                                                if (hintOn) {
                                                    // Exit draw mode.
                                                    setHintEditingFieldId(null);
                                                    setHintDraw(null);
                                                } else {
                                                    // Enter draw mode — arm the first field
                                                    // so the same `hintEditingFieldId` state
                                                    // the 📍 chip drives is non-null.
                                                    const first = extractFields[0];
                                                    if (first) setHintEditingFieldId(first.id);
                                                }
                                            };
                                            const disabled = extractFields.length === 0;
                                            return (
                                                <button
                                                    type="button"
                                                    role="switch"
                                                    aria-checked={hintOn}
                                                    onClick={toggleHint}
                                                    disabled={disabled}
                                                    title={hintOn ? t("ocr.v2.fields.advHintDrawToggleOn") : t("ocr.v2.fields.advHintDrawToggleOff")}
                                                    style={{
                                                        flexShrink: 0,
                                                        display: "inline-flex", alignItems: "center", gap: 6,
                                                        padding: "4px 10px", fontSize: 11, fontWeight: 700,
                                                        background: hintOn ? "var(--color-accent-dim)" : "var(--color-bg-elevated)",
                                                        color: hintOn ? "var(--color-accent)" : "var(--color-text-2)",
                                                        border: `1px solid ${hintOn ? "var(--color-accent-border)" : "var(--color-border)"}`,
                                                        borderRadius: 999, cursor: disabled ? "not-allowed" : "pointer",
                                                        opacity: disabled ? 0.5 : 1,
                                                        fontFamily: "inherit",
                                                    }}>
                                                    <span aria-hidden style={{
                                                        width: 8, height: 8, borderRadius: "50%",
                                                        background: hintOn ? "var(--color-accent)" : "var(--color-text-4)",
                                                    }} />
                                                    {hintOn
                                                        ? t("ocr.v2.fields.advHintDrawToggleOn")
                                                        : t("ocr.v2.fields.advHintDrawToggleOff")}
                                                </button>
                                            );
                                        })()}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </>
            )}

            {extractMode === "fulldoc" && (
                <div style={cardStyle}>
                    <h4 style={cardHeadStyle}>{t("ocr.v2.fields.fulldocHead")}</h4>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-2)" }}>
                        {t("ocr.v2.fields.fulldocBody")}
                    </p>
                </div>
            )}

            <button style={{ ...primaryBtnStyle, width: "100%" }} onClick={() => setCurrentStage("run")}
                disabled={extractMode === "field" && extractFields.length === 0}>
                {t("ocr.v2.fields.next")} →
            </button>
        </>
    );

    const renderRunPanel = () => (
        <>
            <div style={panelTitleStyle}>
                <span style={stageNumStyle}>4</span>{t("ocr.v2.run.title")}
            </div>
            {loading && (
                // UI-4c §3d — replaces the 🤖 static glyph with v1's sequential
                // progress messaging. The `LOADING_STORY_STEPS` derivation is
                // ported verbatim from OCRWorkspace v1 L2028-L2051; each step
                // reads a `docroom-story-{state}` className whose CSS lives in
                // globals.css (L232-L268). i18n keys are the ORIGINAL v1 keys
                // (`ocr.stepUpload/Prepare/Reading/Extract/Format`) — do not
                // invent new ones per §3d spec.
                <div style={{ ...cardStyle, padding: 20 }}>
                    <h4 style={{ ...cardHeadStyle, marginBottom: 10 }}>
                        {t("ocr.extracting")}
                    </h4>
                    <div style={{
                        height: 8, borderRadius: 999, background: "var(--color-bg-elevated)",
                        overflow: "hidden", margin: "4px 0 8px",
                    }}>
                        <div style={{
                            height: "100%", width: `${progress}%`, borderRadius: 999,
                            background: "linear-gradient(90deg,var(--color-ocr,#6366f1),var(--color-accent))",
                            transition: "width 0.3s ease",
                        }} />
                    </div>
                    <p style={{ margin: 0, fontSize: 11.5, color: "var(--color-text-3)" }}>
                        {t("ocr.v2.run.percent", { n: progress })}
                    </p>
                    {ENABLE_LOADING_STORY && progress > 0 && (
                        <div style={{ marginTop: 12, padding: "4px 0" }}>
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
                                                <svg width={10} height={10} viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" strokeWidth={3}
                                                    strokeLinecap="round" strokeLinejoin="round">
                                                    <polyline points="20 6 9 17 4 12" />
                                                </svg>
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
            {!loading && (
                <>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}>{t("ocr.v2.run.costHead")}</h4>
                        <div style={{
                            display: "flex", alignItems: "center", gap: 12, padding: 12,
                            borderRadius: 10, border: "1px solid rgba(99,102,241,0.3)",
                            background: "linear-gradient(135deg,rgba(99,102,241,0.15),rgba(6,182,212,0.08))",
                        }}>
                            <div style={{ fontSize: 22 }}>⚡</div>
                            <div>
                                <div style={{ fontSize: 22, fontWeight: 800, color: TONE_COLOR[creditTone(estimate.credits)] }}>
                                    {estimate.credits} {t("ocr.v2.run.credits")}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--color-text-2)" }}>{creditLabel}</div>
                            </div>
                        </div>
                    </div>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}>{t("ocr.v2.run.doingHead")}</h4>
                        <ul style={{ padding: 0, margin: 0, listStyle: "none", fontSize: 12.5, color: "var(--color-text-2)" }}>
                            <li style={{ padding: "4px 0" }}>✓ {t("ocr.v2.run.doing1", { n: selectedPages.length || 1 })}</li>
                            <li style={{ padding: "4px 0" }}>
                                ✓ {extractMode === "fulldoc" ? t("ocr.v2.run.doing2Fulldoc") : t("ocr.v2.run.doing2Field", { n: extractFields.length })}
                            </li>
                            <li style={{ padding: "4px 0" }}>✓ {t("ocr.v2.run.doing3")}</li>
                        </ul>
                    </div>
                    <button style={{ ...primaryBtnStyle, width: "100%", padding: "12px 20px", fontSize: 14.5 }}
                        onClick={() => runExtract(false)}>
                        {t("ocr.v2.run.cta")}
                    </button>
                </>
            )}
        </>
    );

    const renderResultsPanel = () => {
        const numCorr = allCorrections.length;
        return (
            <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ ...panelTitleStyle, margin: 0 }}>
                        <span style={stageNumStyle}>5</span>{t("ocr.v2.results.title")}
                        {displayedAttempt === "retry" && (
                            <span style={{
                                marginLeft: 8, fontSize: 10, padding: "2px 6px", borderRadius: 4,
                                background: "var(--color-info,#3b82f6)", color: "#0a1628", fontWeight: 700,
                            }}>{t("ocr.v2.results.attemptRetry")}</span>
                        )}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                        <button style={{ ...ghostBtnStyle, padding: "6px 10px", fontSize: 12 }}
                            onClick={requestRetry} disabled={loading}>
                            ⟳ {t("ocr.v2.results.retryAll")}
                        </button>
                        <button style={{ ...primaryBtnStyle, padding: "6px 12px", fontSize: 12.5 }}
                            onClick={() => setCurrentStage("export")}>
                            {t("ocr.v2.results.toExport")} →
                        </button>
                    </div>
                </div>

                {extractMode === "fulldoc" && fulldocResult && (
                    <>
                        {fulldocResult.pages.map(pg => (
                            <div key={pg.page} style={cardStyle}>
                                <h4 style={{ ...cardHeadStyle }}>
                                    {t("ocr.v2.pageLabel", { n: pg.page })}
                                    <button style={miniBtnStyle} onClick={() => navigator.clipboard.writeText(pg.text)}>
                                        📋 {t("ocr.v2.results.copyValue")}
                                    </button>
                                </h4>
                                <pre style={{
                                    fontFamily: "inherit", fontSize: 12.5, whiteSpace: "pre-wrap",
                                    margin: 0, color: "var(--color-text-1)",
                                }}>{pg.text}</pre>
                            </div>
                        ))}
                    </>
                )}

                {extractMode === "field" && result && (
                    <>
                        {/* Tab bar */}
                        <div style={{
                            display: "flex", gap: 2, marginBottom: 12,
                            background: "var(--color-bg-elevated)",
                            border: "1px solid var(--color-border)", borderRadius: 10, padding: 3,
                        }}>
                            {([
                                ["fields", t("ocr.v2.results.tabFields")],
                                ["json", t("ocr.v2.results.tabJson")],
                                ["corrections", `${t("ocr.v2.results.tabCorrections")}${numCorr ? " · " + numCorr : ""}`],
                                ["positions", t("ocr.v2.results.tabPositions")],
                            ] as [ResultTab, string][]).map(([key, label]) => (
                                <button key={key} onClick={() => setResultTab(key)}
                                    style={{
                                        flex: 1, padding: "7px 10px", fontSize: 12, fontWeight: 600,
                                        background: resultTab === key ? "var(--color-bg-card)" : "transparent",
                                        color: resultTab === key ? "var(--color-text-1)" : "var(--color-text-2)",
                                        border: resultTab === key ? "1px solid var(--color-border-strong)" : "none",
                                        borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
                                    }}>{label}</button>
                            ))}
                        </div>

                        {lowConfidence && (
                            <div style={{
                                ...cardStyle,
                                borderColor: "rgba(245,158,11,0.35)",
                                background: "rgba(245,158,11,0.05)",
                            }}>
                                <p style={{ margin: 0, fontSize: 12, color: "var(--color-warning)" }}>
                                    ⚠ {t("ocr.v2.results.lowConfWarning")}
                                </p>
                            </div>
                        )}

                        {resultTab === "fields" && renderFieldsTab()}
                        {resultTab === "json" && renderJsonTab()}
                        {resultTab === "corrections" && renderCorrectionsTab()}
                        {resultTab === "positions" && renderPositionsTab()}
                    </>
                )}
            </>
        );
    };

    const renderFieldsTab = () => (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {resultEntries.map((e, i) => {
                const conf = e.confidence;
                const confClass = conf >= 80 ? "hi" : conf >= 60 ? "md" : "lo";
                const confBg = confClass === "hi" ? "rgba(16,185,129,0.15)" : confClass === "md" ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.15)";
                const confColor = confClass === "hi" ? "#34d399" : confClass === "md" ? "#fbbf24" : "#f87171";
                const isExpanded = expandedFieldName === e.key;
                const isSelected = selectedFieldName === e.key;
                return (
                    <div key={i}
                        onClick={() => setSelectedFieldName(e.key)}
                        style={{
                            padding: "10px 12px",
                            background: isSelected ? "var(--color-accent-dim)" : "var(--color-bg-card)",
                            border: `1px solid ${isSelected ? "var(--color-accent-border)" : "var(--color-border)"}`,
                            borderLeft: `3px solid ${isSelected ? "var(--color-accent)" : "transparent"}`,
                            borderRadius: 10, position: "relative", cursor: "pointer",
                        }}>
                        <div style={{
                            fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.05em",
                            color: "var(--color-text-3)", fontWeight: 600,
                        }}>{e.key}</div>
                        <div style={{ fontSize: 13.5, marginTop: 2, whiteSpace: "pre-wrap" }}>{e.value}</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                            {conf > 0 && (
                                <span style={{
                                    padding: "2px 8px", borderRadius: 999, fontSize: 10.5, fontWeight: 700,
                                    background: confBg, color: confColor, border: `1px solid ${confColor}55`,
                                }}>{conf}%</span>
                            )}
                            <span style={provenanceStyle}
                                title={t(`ocr.v2.provenance.${e.source}`)}>
                                {e.source === "crop" ? "✂ crop"
                                    : e.source === "crop_miss" ? "⚠ crop miss"
                                    : e.source === "crop_no_match" ? "⚠ crop no-match"
                                    : "🤖 AI"}
                            </span>
                            {e.corrections.length > 0 && (
                                <span style={{
                                    ...provenanceStyle,
                                    background: "rgba(245,158,11,0.15)", color: "#fbbf24",
                                    border: "1px solid rgba(245,158,11,0.3)",
                                }}>✎ corr {e.corrections.length}</span>
                            )}
                        </div>
                        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
                            <button onClick={ev => { ev.stopPropagation(); setExpandedFieldName(isExpanded ? null : e.key); }}
                                title={t("ocr.v2.results.overflow")}
                                style={{ background: "transparent", border: "none", color: "var(--color-text-3)", fontSize: 18, cursor: "pointer" }}>
                                ⋯
                            </button>
                        </div>
                        {isExpanded && (
                            <div style={{
                                marginTop: 10, padding: 10, borderRadius: 8,
                                background: "var(--color-bg-elevated)", fontSize: 11.5,
                            }}>
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    <button style={miniBtnStyle}
                                        onClick={ev => { ev.stopPropagation(); navigator.clipboard.writeText(e.value); }}>
                                        📋 {t("ocr.v2.results.copyValue")}
                                    </button>
                                    <button style={miniBtnStyle}
                                        onClick={ev => { ev.stopPropagation(); requestRetry(); }}
                                        title={t("ocr.v2.results.retryFieldNote")}>
                                        ⟳ {t("ocr.v2.results.retryField")}
                                    </button>
                                </div>
                                <pre style={{
                                    marginTop: 8, padding: 8, borderRadius: 6,
                                    background: "var(--color-bg-panel)",
                                    border: "1px solid var(--color-border)",
                                    fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11,
                                    overflowX: "auto", color: "var(--color-text-2)",
                                }}>{JSON.stringify(e.raw, null, 2)}</pre>
                            </div>
                        )}
                    </div>
                );
            })}
            {/* Inline editor for selected field (below list) */}
            {selectedFieldName && (
                <div style={{ ...cardStyle, marginTop: 8 }}>
                    <h4 style={cardHeadStyle}>{t("ocr.v2.results.editValue")}</h4>
                    <input
                        value={resultEntries.find(e => e.key === selectedFieldName)?.value || ""}
                        onChange={ev => updateFieldValue(selectedFieldName, ev.target.value)}
                        style={{
                            width: "100%", padding: "8px 12px", borderRadius: 8,
                            background: "var(--color-bg-panel)", color: "var(--color-text-1)",
                            border: "1px solid var(--color-border-strong)", fontSize: 13,
                        }} />
                </div>
            )}
        </div>
    );

    const renderJsonTab = () => {
        const raw = JSON.stringify(result, null, 2);
        return (
            <div>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginBottom: 8 }}>
                    <button style={miniBtnStyle} onClick={() => navigator.clipboard.writeText(raw)}>
                        📋 {t("ocr.v2.results.jsonCopy")}
                    </button>
                    <button style={miniBtnStyle} onClick={() => {
                        const blob = new Blob([raw], { type: "application/json" });
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = `OCR_${Date.now()}.json`;
                        a.click();
                    }}>⬇ {t("ocr.v2.results.jsonDownload")}</button>
                </div>
                {/* UI-4c: JSON background uses theme tokens so light mode
                    isn't hardcoded to dark bg + light text (invisible). Dark
                    tokens keep the previous look; light tokens flip fg/bg. */}
                <pre style={{
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 10, padding: 14, fontFamily: "ui-monospace,Menlo,monospace",
                    fontSize: 11.5, lineHeight: 1.7, overflowX: "auto",
                    color: "var(--color-text-1)", whiteSpace: "pre",
                }}>{raw}</pre>
            </div>
        );
    };

    const renderCorrectionsTab = () => {
        if (allCorrections.length === 0) {
            return <p style={{ fontSize: 12, color: "var(--color-text-3)" }}>{t("ocr.v2.results.noCorrections")}</p>;
        }
        return (
            <div>
                <p style={{ fontSize: 12, color: "var(--color-text-2)", marginBottom: 10 }}>
                    {t("ocr.v2.results.correctionsIntro", { n: allCorrections.length })}
                </p>
                {allCorrections.map((c, i) => (
                    <div key={i} style={cardStyle}>
                        <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--color-text-3)", fontWeight: 700, marginBottom: 6 }}>
                            {c.field}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13.5 }}>
                            <span style={{ color: "#f87171", textDecoration: "line-through", background: "rgba(239,68,68,0.08)", padding: "2px 8px", borderRadius: 6 }}>{c.original}</span>
                            →
                            <span style={{ color: "#34d399", background: "rgba(16,185,129,0.08)", padding: "2px 8px", borderRadius: 6, fontWeight: 600 }}>{c.corrected}</span>
                        </div>
                        {c.why && <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 6 }}>{c.why}</div>}
                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                            <button style={{ ...miniBtnStyle, color: "#34d399", borderColor: "rgba(16,185,129,0.35)" }}>
                                ✓ {t("ocr.v2.results.correctionAccept")}
                            </button>
                            <button style={miniBtnStyle} onClick={() => revertCorrection(c.field, c.original)}>
                                ↩ {t("ocr.v2.results.correctionRevert")}
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    const renderPositionsTab = () => (
        <div>
            <p style={{ fontSize: 12, color: "var(--color-text-2)", marginBottom: 10 }}>
                {t("ocr.v2.results.positionsIntro")}
            </p>
            {resultEntries.filter(e => e.bbox).map((e, i) => (
                <div key={i} style={{ ...cardStyle, cursor: "pointer" }}
                    onClick={() => {
                        setSelectedFieldName(e.key);
                        if (e.bbox?.page) setPreviewPage((e.bbox.page - 1));
                    }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{e.key}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-3)", fontFamily: "ui-monospace,Menlo,monospace" }}>
                        page {e.bbox?.page || 1} · ({(e.bbox.x ?? 0).toFixed(2)}, {(e.bbox.y ?? 0).toFixed(2)})
                    </div>
                </div>
            ))}
            {resultEntries.filter(e => e.bbox).length === 0 && (
                <p style={{ fontSize: 12, color: "var(--color-text-3)" }}>{t("ocr.v2.results.noPositions")}</p>
            )}
        </div>
    );

    const renderExportPanel = () => {
        const cards: { icon: string; name: string; sub: string; onClick: () => void; }[] = [
            { icon: "📊", name: "Excel", sub: ".xlsx", onClick: () => doExport("excel") },
            { icon: "📄", name: "CSV", sub: ".csv", onClick: () => doExport("csv") },
            { icon: "{ }", name: "JSON", sub: "raw", onClick: () => doExport("json") },
        ];
        if (extractMode === "fulldoc") {
            cards.length = 0;
            cards.push(
                { icon: "📝", name: ".txt", sub: t("ocr.v2.export.plainText"), onClick: () => doExport("csv") /* not used — see doExport branch */ },
                { icon: "📄", name: ".md", sub: t("ocr.v2.export.markdown"), onClick: () => doExport("csv") },
                { icon: "{ }", name: "JSON", sub: "raw", onClick: () => doExport("json") },
            );
        }
        return (
            <>
                <div style={panelTitleStyle}>
                    <span style={stageNumStyle}>6</span>{t("ocr.v2.export.title")}
                </div>
                {lowConfidence && (
                    <div style={{
                        ...cardStyle,
                        borderColor: "rgba(245,158,11,0.35)",
                        background: "rgba(245,158,11,0.05)",
                    }}>
                        <h4 style={{ ...cardHeadStyle, color: "var(--color-warning)" }}>⚠ {t("ocr.v2.export.warnHead")}</h4>
                        <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-2)" }}>
                            {t("ocr.v2.export.warnBody")}
                            <button style={{ ...miniBtnStyle, marginLeft: 6 }} onClick={() => setCurrentStage("results")}>
                                ← {t("ocr.v2.export.warnBack")}
                            </button>
                        </p>
                    </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {cards.map((c, i) => (
                        <button key={i} onClick={c.onClick}
                            style={{
                                ...cardStyle, marginBottom: 0, cursor: "pointer", textAlign: "center",
                                fontFamily: "inherit",
                            }}>
                            <div style={{ fontSize: 26, marginBottom: 6 }}>{c.icon}</div>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name}</div>
                            <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 2 }}>{c.sub}</div>
                        </button>
                    ))}
                </div>
                <div style={{ ...cardStyle, marginTop: 12 }}>
                    <h4 style={cardHeadStyle}>{t("ocr.v2.export.summary")}</h4>
                    <ul style={{ padding: 0, margin: 0, listStyle: "none", fontSize: 12.5, color: "var(--color-text-2)" }}>
                        <li style={{ padding: "4px 0" }}>✓ {t("ocr.v2.export.summary1", { n: extractFields.length, p: selectedPages.length || 1, c: estimate.credits })}</li>
                    </ul>
                </div>
                <button style={{ ...primaryBtnStyle, width: "100%", padding: "12px 20px", fontSize: 14.5, marginTop: 12 }}
                    onClick={resetAll}>
                    📄 {t("ocr.v2.export.next")}
                </button>
            </>
        );
    };

    // ─── RENDER ──────────────────────────────────────────────────────────
    // UI-4c Chunk 2: single vs batch mode switch. When batch is picked, the
    // whole body renders the legacy v1 workspace verbatim — no batch redesign.
    // v1 handles multi-file drop / batch UI itself. The mode switch persists
    // in v2 state so flipping back keeps v2 on its current stage.
    if (uiMode === "batch") {
        return (
            <div style={{
                display: "flex", flexDirection: "column",
                minHeight: "calc(100vh - 92px)",
                background: "var(--color-bg-surface)",
                color: "var(--color-text-1)",
                border: "1px solid var(--color-border)",
                borderRadius: 12, overflow: "hidden",
            }}>
                {/* UI-4c 3c-1 + 3c-2: dropped in-component "OCR Workspace"
                    title (app TopBar renders it already) and in-component credit
                    chip (duplicated TopBar "เครดิต"). Only the single/batch mode
                    switch remains, right-aligned. */}
                <div style={{
                    display: "flex", alignItems: "center", justifyContent: "flex-end",
                    gap: 10,
                    padding: "10px 20px", background: "var(--color-bg-panel)",
                    borderBottom: "1px solid var(--color-border)",
                }}>
                    <QuickModeToggle quickMode={quickMode} onChange={setQuickMode} t={t} />
                    <ModeSwitch mode={uiMode} onChange={setUiMode} t={t} />
                </div>
                <OCRWorkspaceV1
                    user={user}
                    balance={balance}
                    onDocumentProcessed={onDocumentProcessed}
                    onNavigateToBilling={onNavigateToBilling}
                />
            </div>
        );
    }

    return (
        <div ref={dropRef} style={{
            display: "flex", flexDirection: "column",
            minHeight: "calc(100vh - 92px)",
            background: "var(--color-bg-surface)",
            color: "var(--color-text-1)",
            border: "1px solid var(--color-border)",
            borderRadius: 12, overflow: "hidden",
        }}>
            {/* UI-4c §3d: previous header row was deleted — ModeSwitch now
                lives inline on the stepper row (see renderStepper). Title and
                credit chip already removed in §3c. */}
            {renderStepper()}

            {/* Error toast */}
            {error && (
                <div style={{
                    padding: "10px 20px", background: "rgba(239,68,68,0.1)",
                    borderBottom: "1px solid rgba(239,68,68,0.3)",
                    color: "var(--color-danger)", fontSize: 13,
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                    <span>⚠ {error}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                        {currentStage === "upload" && (
                            <button style={miniBtnStyle} onClick={() => setError(null)}>
                                {t("ocr.v2.error.retry")}
                            </button>
                        )}
                        <button style={miniBtnStyle} onClick={() => setError(null)}>✕</button>
                    </div>
                </div>
            )}

            {/* Zones — flex row */}
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                {/* LEFT: preview OR upload dropzone */}
                <div style={{
                    flex: 1, padding: 20, borderRight: "1px solid var(--color-border)",
                    display: "flex", flexDirection: "column", gap: 10,
                    overflow: "hidden",
                }}>
                    {!file ? (
                        // UI-4c 3b: restored v1's dropzone look (SVG cloud icon,
                        // rounded tile, hover animation) verbatim so operator
                        // muscle memory holds.
                        <label
                            className="ocr-dropzone"
                            style={{
                                flex: 1, display: "flex", flexDirection: "column",
                                alignItems: "center", justifyContent: "center", gap: 14,
                                cursor: "pointer",
                                border: `2px dashed var(--color-border-strong)`,
                                borderRadius: 10, transition: "all 0.3s ease",
                            }}>
                            <input type="file" style={{ display: "none" }}
                                accept="application/pdf,image/*,.docx,.xlsx,.xls"
                                onChange={e => {
                                    const f = e.target.files?.[0];
                                    if (f) processFile(f);
                                    e.target.value = "";
                                }} />
                            <div className="ocr-dropzone-icon"
                                style={{
                                    width: 80, height: 80, borderRadius: 20,
                                    background: "rgba(6,182,212,0.08)",
                                    border: "2px dashed rgba(6,182,212,0.35)",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    transition: "transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.3s, border-color 0.3s",
                                }}>
                                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9" />
                                    <path d="M15 13l-3-3m0 0l-3 3m3-3v12" />
                                </svg>
                            </div>
                            <div style={{ textAlign: "center" }}>
                                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-1)" }}>
                                    {converting === "docx" ? t("ocr.convertingDocx") : t("ocr.uploadHeadline")}
                                </div>
                                <div style={{ fontSize: 12, color: "var(--color-text-3)", marginTop: 4 }}>
                                    {t("ocr.uploadSubtext")}
                                </div>
                            </div>
                            <style>{`
                                .ocr-dropzone:hover { border-color: rgba(6,182,212,0.55); background: rgba(6,182,212,0.05); }
                                .ocr-dropzone:hover .ocr-dropzone-icon {
                                    transform: scale(1.1) rotate(3deg);
                                    background: rgba(6,182,212,0.15);
                                    border-color: var(--color-accent);
                                }
                            `}</style>
                        </label>
                    ) : (
                        <>
                            {/* Preview always mounted after upload — overlay stays in DOM */}
                            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                                {currentStage === "pages" && pdfRaster && pdfRaster.result.pagePngs.length > 1 ? (
                                    // Page-select grid (specific to pages stage)
                                    <div style={{
                                        background: "var(--color-bg-card)",
                                        border: "1px solid var(--color-border)",
                                        borderRadius: 12, padding: 12, flex: 1, overflow: "auto",
                                    }}>
                                        <div style={{ marginBottom: 10, fontSize: 13, fontWeight: 700 }}>
                                            {t("ocr.pagePicker.title")}
                                        </div>
                                        <div style={{
                                            display: "grid",
                                            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                                            gap: 12,
                                        }}>
                                            {previews.map((src, i) => {
                                                const pageNum = i + 1;
                                                const sel = selectedPages.includes(pageNum);
                                                return (
                                                    <div key={i} onClick={() => {
                                                        setSelectedPages(prev => {
                                                            if (prev.includes(pageNum)) return prev.filter(p => p !== pageNum);
                                                            if (prev.length >= PAGE_SELECTION_MAX) return prev;
                                                            return [...prev, pageNum].sort((a, b) => a - b);
                                                        });
                                                    }} style={{
                                                        position: "relative", aspectRatio: "3/4",
                                                        borderRadius: 10, cursor: "pointer",
                                                        border: sel ? "3px solid var(--color-accent)" : "3px solid transparent",
                                                        backgroundImage: `url(${src})`,
                                                        backgroundSize: "cover", backgroundPosition: "top center",
                                                        backgroundColor: "#d0d7e2",
                                                        display: "flex", alignItems: "flex-end", justifyContent: "center",
                                                    }}>
                                                        {sel && (
                                                            <span style={{
                                                                position: "absolute", top: 6, right: 8,
                                                                background: "var(--color-accent)", color: "#0a1628",
                                                                width: 20, height: 20, borderRadius: "50%",
                                                                display: "flex", alignItems: "center", justifyContent: "center",
                                                                fontWeight: 800,
                                                            }}>✓</span>
                                                        )}
                                                        <span style={{ background: "rgba(255,255,255,0.85)", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700, color: "#0f172a", marginBottom: 6 }}>
                                                            {t("ocr.v2.pages.pageLabel", { n: pageNum })}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ) : (
                                    renderPreview()
                                )}
                            </div>
                            {renderPageStrip()}
                        </>
                    )}
                </div>

                {/* RIGHT: single content panel — swaps by stage */}
                <div style={{
                    width: 400, padding: 20, background: "var(--color-bg-panel)",
                    overflowY: "auto",
                }}>
                    {currentStage === "upload" && renderUploadPanel()}
                    {currentStage === "pages" && renderPagesPanel()}
                    {currentStage === "fields" && renderFieldsPanel()}
                    {currentStage === "run" && renderRunPanel()}
                    {currentStage === "results" && renderResultsPanel()}
                    {currentStage === "export" && renderExportPanel()}
                </div>
            </div>

            {/* Non-blocking unsaved-edits toast (UI-6 §A2) */}
            {unsavedToast && (
                <div style={{
                    position: "fixed", bottom: 24, left: "50%",
                    transform: "translateX(-50%)",
                    background: "var(--color-bg-elevated)",
                    color: "var(--color-warning)",
                    border: "1px solid var(--color-warning)",
                    borderRadius: 10, padding: "10px 16px", fontSize: 12.5,
                    zIndex: 60, boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
                }}>⚠ {unsavedToast}</div>
            )}

            {/* Delete-template notice toast (UI-6 §delete) */}
            {noticeToast && (
                <div style={{
                    position: "fixed", bottom: 24, left: "50%",
                    transform: "translateX(-50%)",
                    background: "var(--color-bg-elevated)",
                    color: noticeToast.tone === "success" ? "var(--color-success)" : "var(--color-danger)",
                    border: `1px solid ${noticeToast.tone === "success" ? "var(--color-success)" : "var(--color-danger)"}`,
                    borderRadius: 10, padding: "10px 16px", fontSize: 12.5,
                    zIndex: 60, boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
                }}>
                    {noticeToast.tone === "success" ? "✓ " : "⚠ "}{noticeToast.text}
                </div>
            )}

            {/* Save-as-new template dialog (UI-6 §A2) */}
            {saveAsNewOpen && (
                <ModalScrim onClose={() => setSaveAsNewOpen(false)}>
                    <div style={modalCardStyle}>
                        <h3 style={{ margin: 0, marginBottom: 12, fontSize: 15 }}>
                            {t("ocr.v2.templatePicker.saveAsNewTitle")}
                        </h3>
                        <input value={newTemplateName}
                            autoFocus
                            onChange={e => setNewTemplateName(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter" && newTemplateName.trim()) saveAsNewTemplate(); }}
                            placeholder={t("ocr.v2.templatePicker.newNamePh")}
                            style={{
                                width: "100%", padding: "8px 12px", borderRadius: 8,
                                background: "var(--color-bg-panel)", color: "var(--color-text-1)",
                                border: "1px solid var(--color-border-strong)", fontSize: 13,
                                fontFamily: "inherit",
                            }} />
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                            <button style={ghostBtnStyle} onClick={() => setSaveAsNewOpen(false)}>
                                {t("ocr.v2.templatePicker.cancel")}
                            </button>
                            <button style={primaryBtnStyle}
                                disabled={!newTemplateName.trim() || savingTemplate}
                                onClick={saveAsNewTemplate}>
                                {savingTemplate ? "…" : t("ocr.v2.templatePicker.save")}
                            </button>
                        </div>
                    </div>
                </ModalScrim>
            )}

            {/* Quick-mode one-time template picker (UI-6 §B) */}
            {quickPickerOpen && (
                <ModalScrim onClose={() => setQuickPickerOpen(false)}>
                    <div style={{ ...modalCardStyle, maxWidth: 480 }}>
                        <h3 style={{ margin: 0, marginBottom: 8, fontSize: 15 }}>
                            ⚡ {t("ocr.v2.quickMode.pickerTitle")}
                        </h3>
                        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--color-text-2)" }}>
                            {t("ocr.v2.quickMode.pickerBody")}
                        </p>
                        <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--color-border)", borderRadius: 8 }}>
                            {templates.length === 0 && (
                                <p style={{ margin: 0, padding: 12, fontSize: 12, color: "var(--color-text-3)" }}>
                                    {t("ocr.v2.templatePicker.empty")}
                                </p>
                            )}
                            {templates.map(tpl => (
                                <button key={tpl.id}
                                    onClick={() => {
                                        applyTemplate(tpl.id);
                                        if (quickSetAsDefault) persistDefaultTemplate(tpl.id);
                                        setQuickPickerOpen(false);
                                        // Re-arm auto-run — the effect will now find defaultOcrTemplateId + fire.
                                        quickFiredRef.current = false;
                                    }}
                                    style={{
                                        display: "block", width: "100%", textAlign: "left",
                                        padding: "8px 12px", background: "transparent",
                                        border: "none",
                                        borderBottom: "1px solid var(--color-border)",
                                        color: "var(--color-text-1)", fontSize: 12.5,
                                        cursor: "pointer", fontFamily: "inherit",
                                    }}>
                                    {tpl.name}
                                </button>
                            ))}
                        </div>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 12, color: "var(--color-text-2)" }}>
                            <input type="checkbox" checked={quickSetAsDefault}
                                onChange={e => setQuickSetAsDefault(e.target.checked)} />
                            {t("ocr.v2.quickMode.setAsDefault")}
                        </label>
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                            <button style={ghostBtnStyle} onClick={() => setQuickPickerOpen(false)}>
                                {t("ocr.v2.templatePicker.cancel")}
                            </button>
                        </div>
                    </div>
                </ModalScrim>
            )}

            {confirmDialog && (
                <CreditConfirmDialog
                    open={true}
                    onConfirm={() => { const cb = confirmDialog.onProceed; setConfirmDialog(null); cb(); }}
                    onCancel={() => setConfirmDialog(null)}
                    credits={confirmDialog.credits}
                    balance={balance}
                    reasons={confirmDialog.reasons}
                    steps={confirmDialog.steps}
                    fingerprint={confirmDialog.fingerprint}
                />
            )}
        </div>
    );
}

// ─── Style helpers (inline objects to keep the file self-contained) ────
const TONE_COLOR: Record<string, string> = {
    green: "var(--color-success)", amber: "var(--color-warning)",
    orange: "#f97316", red: "var(--color-danger)",
};
const panelTitleStyle: React.CSSProperties = {
    fontSize: 11.5, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.1em", color: "var(--color-text-2)",
    marginBottom: 12, display: "flex", alignItems: "center", gap: 8,
};
const stageNumStyle: React.CSSProperties = {
    width: 20, height: 20, borderRadius: "50%", background: "var(--color-accent)",
    color: "#0a1628", fontSize: 11, fontWeight: 800,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
};
const cardStyle: React.CSSProperties = {
    background: "var(--color-bg-card)", border: "1px solid var(--color-border)",
    borderRadius: 12, padding: 14, marginBottom: 12,
};
const cardHeadStyle: React.CSSProperties = {
    fontSize: 13, margin: 0, marginBottom: 8, display: "flex",
    justifyContent: "space-between", alignItems: "center",
};
const primaryBtnStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    padding: "10px 16px", borderRadius: 10, fontSize: 13.5, fontWeight: 600,
    border: "1px solid transparent", cursor: "pointer",
    background: "var(--color-accent)", color: "#0a1628",
    fontFamily: "inherit",
};
const ghostBtnStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    padding: "10px 16px", borderRadius: 10, fontSize: 13.5, fontWeight: 600,
    border: "1px solid var(--color-border)", cursor: "pointer",
    background: "var(--color-bg-elevated)", color: "var(--color-text-1)",
    fontFamily: "inherit",
};
const miniBtnStyle: React.CSSProperties = {
    padding: "3px 10px", borderRadius: 6, fontSize: 11,
    background: "var(--color-bg-elevated)", color: "var(--color-text-2)",
    border: "1px solid var(--color-border)", cursor: "pointer",
    fontFamily: "inherit",
};
const provenanceStyle: React.CSSProperties = {
    display: "inline-flex", gap: 3, padding: "2px 7px", borderRadius: 4,
    fontSize: 10, fontWeight: 700, textTransform: "uppercase",
    background: "var(--color-bg-elevated)", color: "var(--color-text-2)",
    border: "1px solid var(--color-border)",
};

const miniZoomBtnStyle = (disabled: boolean): React.CSSProperties => ({
    background: "transparent", border: "none",
    color: "var(--color-text-2)",
    padding: "2px 8px", borderRadius: 4,
    fontSize: 12, fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    fontFamily: "inherit",
});

// ─── UI-6 §B: ⚡ Quick mode topbar toggle ────────────────────────────────
// Persist (via localStorage) is handled in the parent effect. When ON, the
// parent's `quickFiredRef` auto-run effect drives the file → run pipeline.
function QuickModeToggle({ quickMode, onChange, t }: {
    quickMode: boolean;
    onChange: (v: boolean) => void;
    t: (k: string, vars?: any) => string;
}) {
    return (
        <button
            onClick={() => onChange(!quickMode)}
            title={quickMode ? t("ocr.v2.quickMode.tooltipOn") : t("ocr.v2.quickMode.tooltipOff")}
            style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 12px", fontSize: 11.5, fontWeight: 700,
                background: quickMode ? "var(--color-accent-dim)" : "var(--color-bg-elevated)",
                color: quickMode ? "var(--color-accent)" : "var(--color-text-2)",
                border: `1px solid ${quickMode ? "var(--color-accent-border)" : "var(--color-border)"}`,
                borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
            }}>
            ⚡ {t("ocr.v2.quickMode.label")}
            <span style={{
                fontSize: 9.5, padding: "1px 6px", borderRadius: 999,
                background: quickMode ? "var(--color-accent)" : "var(--color-bg-panel)",
                color: quickMode ? "#0a1628" : "var(--color-text-3)",
                fontWeight: 800,
            }}>{quickMode ? t("ocr.v2.quickMode.on") : t("ocr.v2.quickMode.off")}</span>
        </button>
    );
}

// ─── UI-6 §A: Template picker panel ──────────────────────────────────────
// Replaces the flat <select>: search + ⭐ Favorites + 🕐 Recent + 📋 All
// sections. Every row shows a star toggle. Currently-loaded template is
// highlighted; a "● แก้ไข" pill shows if fields diverge from the snapshot.
interface TemplatePickerPanelProps {
    templates: { id: string; name: string; fields_json: string; user_id?: string }[];
    activeTemplateId: string | null;
    activeTemplateName: string | null;
    favoriteIds: string[];
    recentIds: string[];
    defaultTemplateId: string | null;
    dirty: boolean;
    search: string;
    onSearch: (s: string) => void;
    onApply: (id: string | null) => void;
    onToggleFavorite: (id: string) => void;
    onSetDefault: (id: string | null) => void;
    onSaveAsNew: () => void;
    onUpdateActive: () => void;
    onDelete: (id: string) => void;
    savingTemplate: boolean;
    t: (k: string, vars?: any) => string;
}
function TemplatePickerPanel(p: TemplatePickerPanelProps) {
    const q = p.search.trim().toLowerCase();
    const matches = (n: string) => q === "" || n.toLowerCase().includes(q);
    // Inline delete confirmation — id of the row currently prompting.
    const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
    const isSystemTemplate = (tpl: { id: string; user_id?: string }) =>
        tpl.user_id === "system" || tpl.id.startsWith("global-");

    const favTemplates = p.templates.filter(x => p.favoriteIds.includes(x.id) && matches(x.name));
    const recentTemplates = p.recentIds
        .map(id => p.templates.find(x => x.id === id))
        .filter((x): x is NonNullable<typeof x> => !!x && matches(x.name));
    const allTemplates = p.templates.filter(x => matches(x.name));

    const renderRow = (tpl: { id: string; name: string; user_id?: string }) => {
        const isActive = tpl.id === p.activeTemplateId;
        const isFav = p.favoriteIds.includes(tpl.id);
        const isDefault = tpl.id === p.defaultTemplateId;
        const isSystem = isSystemTemplate(tpl);
        const isConfirming = confirmingDeleteId === tpl.id;
        return (
            <div key={tpl.id}
                onClick={() => { if (!isConfirming) p.onApply(tpl.id); }}
                className="ocr-v2-tpl-row"
                style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "6px 8px", borderRadius: 8, cursor: "pointer",
                    background: isActive ? "var(--color-accent-dim)" : "transparent",
                    border: isActive ? "1px solid var(--color-accent-border)" : "1px solid transparent",
                    fontSize: 12.5,
                }}>
                <button
                    onClick={e => { e.stopPropagation(); p.onToggleFavorite(tpl.id); }}
                    title={isFav ? p.t("ocr.v2.templatePicker.unfavorite") : p.t("ocr.v2.templatePicker.favorite")}
                    style={{
                        background: "transparent", border: "none",
                        color: isFav ? "#f59e0b" : "var(--color-text-4)",
                        cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1,
                    }}>{isFav ? "★" : "☆"}</button>
                <span style={{ flex: 1, color: "var(--color-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {tpl.name}
                </span>
                {isDefault && (
                    <span style={{
                        fontSize: 9.5, padding: "1px 6px", borderRadius: 4,
                        background: "var(--color-accent)", color: "#0a1628", fontWeight: 700,
                    }}>{p.t("ocr.v2.templatePicker.default")}</span>
                )}
                {isActive && (
                    <span style={{ fontSize: 12, color: "var(--color-accent)" }}>✓</span>
                )}
                {/* 🗑 delete button — hidden for system templates. Ghost by
                    default; hover reveals full contrast via the .ocr-v2-tpl-row
                    hover CSS below. Click enters inline-confirm mode which
                    replaces the delete glyph with ✓/✗ actions. */}
                {isSystem ? (
                    <span
                        title={p.t("ocr.v2.templatePicker.delete.systemLocked")}
                        aria-label={p.t("ocr.v2.templatePicker.delete.systemLocked")}
                        style={{
                            fontSize: 12, color: "var(--color-text-4)",
                            opacity: 0.35, padding: "0 2px", lineHeight: 1,
                        }}>🔒</span>
                ) : isConfirming ? (
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
                        onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: 10.5, color: "var(--color-danger)", marginRight: 2 }}>
                            {p.t("ocr.v2.templatePicker.delete.confirm")}
                        </span>
                        <button
                            onClick={e => {
                                e.stopPropagation();
                                setConfirmingDeleteId(null);
                                p.onDelete(tpl.id);
                            }}
                            style={{
                                background: "var(--color-danger)", color: "#fff",
                                border: "none", borderRadius: 4,
                                padding: "1px 6px", fontSize: 10.5, fontWeight: 700,
                                cursor: "pointer", fontFamily: "inherit",
                            }}>{p.t("ocr.v2.templatePicker.delete.yes")}</button>
                        <button
                            onClick={e => { e.stopPropagation(); setConfirmingDeleteId(null); }}
                            style={{
                                background: "var(--color-bg-elevated)",
                                color: "var(--color-text-2)",
                                border: "1px solid var(--color-border)", borderRadius: 4,
                                padding: "1px 6px", fontSize: 10.5, fontWeight: 700,
                                cursor: "pointer", fontFamily: "inherit",
                            }}>{p.t("ocr.v2.templatePicker.delete.no")}</button>
                    </span>
                ) : (
                    <button
                        className="ocr-v2-tpl-delete"
                        onClick={e => {
                            e.stopPropagation();
                            setConfirmingDeleteId(tpl.id);
                        }}
                        title={p.t("ocr.v2.templatePicker.delete.button")}
                        aria-label={p.t("ocr.v2.templatePicker.delete.button")}
                        style={{
                            background: "transparent", border: "none",
                            color: "var(--color-text-4)",
                            cursor: "pointer", fontSize: 12, padding: "0 2px",
                            lineHeight: 1, opacity: 0.4,
                            transition: "opacity 0.15s ease, color 0.15s ease",
                        }}>🗑</button>
                )}
            </div>
        );
    };

    return (
        <div style={cardStyle}>
            {/* Hover reveals the ghost delete button at full contrast. */}
            <style>{`
                .ocr-v2-tpl-row:hover .ocr-v2-tpl-delete { opacity: 1; color: var(--color-danger); }
                .ocr-v2-tpl-delete:hover { opacity: 1 !important; color: var(--color-danger) !important; }
            `}</style>
            <h4 style={cardHeadStyle}>
                <span>{p.t("ocr.v2.templatePicker.head")}</span>
                {p.activeTemplateId && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {p.dirty && (
                            <span style={{
                                fontSize: 10, padding: "1px 6px", borderRadius: 4,
                                background: "rgba(245,158,11,0.15)",
                                color: "var(--color-warning)",
                                border: "1px solid rgba(245,158,11,0.35)", fontWeight: 700,
                            }}>● {p.t("ocr.v2.templatePicker.dirty")}</span>
                        )}
                        <button
                            onClick={() => p.onApply(null)}
                            style={{
                                background: "transparent", border: "none",
                                color: "var(--color-text-3)", fontSize: 11, cursor: "pointer",
                                fontFamily: "inherit",
                            }}>
                            {p.t("ocr.v2.templatePicker.clear")}
                        </button>
                    </span>
                )}
            </h4>
            <input value={p.search}
                onChange={e => p.onSearch(e.target.value)}
                placeholder={p.t("ocr.v2.templatePicker.searchPh")}
                style={{
                    width: "100%", padding: "6px 10px", borderRadius: 8,
                    background: "var(--color-bg-panel)", color: "var(--color-text-1)",
                    border: "1px solid var(--color-border)", fontSize: 12,
                    fontFamily: "inherit", marginBottom: 8,
                }} />
            <div style={{ maxHeight: 240, overflowY: "auto" }}>
                {favTemplates.length > 0 && (
                    <div>
                        <div style={pickerSectionHead}>⭐ {p.t("ocr.v2.templatePicker.favSection")}</div>
                        {favTemplates.map(renderRow)}
                    </div>
                )}
                {recentTemplates.length > 0 && (
                    <div>
                        <div style={pickerSectionHead}>🕐 {p.t("ocr.v2.templatePicker.recentSection")}</div>
                        {recentTemplates.map(renderRow)}
                    </div>
                )}
                <div>
                    <div style={pickerSectionHead}>📋 {p.t("ocr.v2.templatePicker.allSection")}</div>
                    {allTemplates.length === 0
                        ? <p style={{ margin: 0, padding: "6px 8px", fontSize: 11.5, color: "var(--color-text-3)" }}>
                            {p.t("ocr.v2.templatePicker.empty")}
                          </p>
                        : allTemplates.map(renderRow)}
                </div>
            </div>
            {/* Save semantics — UI-6 §A2 */}
            <div style={{ display: "flex", gap: 6, marginTop: 10, borderTop: "1px solid var(--color-border)", paddingTop: 10 }}>
                <button style={{ ...miniBtnStyle, flex: 1, padding: "6px 10px" }}
                    disabled={p.savingTemplate}
                    onClick={p.onSaveAsNew}>
                    + {p.t("ocr.v2.templatePicker.saveAsNew")}
                </button>
                <button style={{
                        ...miniBtnStyle, flex: 1, padding: "6px 10px",
                        color: p.activeTemplateId ? "var(--color-accent)" : "var(--color-text-4)",
                        borderColor: p.activeTemplateId ? "var(--color-accent-border)" : "var(--color-border)",
                    }}
                    disabled={!p.activeTemplateId || p.savingTemplate}
                    title={!p.activeTemplateId ? p.t("ocr.v2.templatePicker.updateDisabledTip") : ""}
                    onClick={p.onUpdateActive}>
                    ↻ {p.activeTemplateName
                        ? p.t("ocr.v2.templatePicker.updateActive", { name: p.activeTemplateName })
                        : p.t("ocr.v2.templatePicker.updateDisabled")}
                </button>
            </div>
        </div>
    );
}

// ─── Simple modal scrim ────────────────────────────────────────────────
function ModalScrim({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
    return (
        <div
            onClick={onClose}
            style={{
                position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
                display: "flex", alignItems: "center", justifyContent: "center",
                zIndex: 50, padding: 16,
            }}>
            <div onClick={e => e.stopPropagation()}>{children}</div>
        </div>
    );
}

const modalCardStyle: React.CSSProperties = {
    background: "var(--color-bg-card)",
    border: "1px solid var(--color-border-strong)",
    borderRadius: 12, padding: 18, minWidth: 320, maxWidth: 420,
    boxShadow: "0 24px 60px rgba(0,0,0,0.4)",
    color: "var(--color-text-1)",
};

const pickerSectionHead: React.CSSProperties = {
    fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em",
    color: "var(--color-text-3)", fontWeight: 700,
    padding: "6px 8px 2px",
};

// ─── Mode switch (single / batch topbar segmented control, UI-4c 2) ──────
function ModeSwitch({ mode, onChange, t }: {
    mode: "single" | "batch";
    onChange: (m: "single" | "batch") => void;
    t: (k: string) => string;
}) {
    return (
        <div style={{
            display: "inline-flex",
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 8, padding: 2,
        }}>
            {(["single", "batch"] as const).map(m => (
                <button key={m} onClick={() => onChange(m)}
                    style={{
                        padding: "4px 12px", fontSize: 11.5, fontWeight: 600,
                        background: mode === m ? "var(--color-bg-card)" : "transparent",
                        color: mode === m ? "var(--color-text-1)" : "var(--color-text-2)",
                        border: mode === m ? "1px solid var(--color-border-strong)" : "1px solid transparent",
                        borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                    }}>
                    {m === "single" ? t("ocr.v2.modeSingle") : t("ocr.v2.modeBatch")}
                </button>
            ))}
        </div>
    );
}

// ─── UI-4c §3d: Field-type dropdown (custom, all 8 v1 types) ──────────────
// Custom control (NOT native <select>, NOT segmented — 8 options too wide).
// Rounded 10px, hover states, custom chevron. Each row = color dot + label.
// Colors mirror TYPE_COLOR (v1 L87-98). i18n labels under
// `ocr.v2.fields.type.<key>` — both th/en.
const FIELD_TYPES: ExtractField["type"][] = [
    "text", "number", "currency", "date", "address", "email", "table", "raw_text",
];
function FieldTypeDropdown({ value, onChange, t }: {
    value: ExtractField["type"];
    onChange: (v: ExtractField["type"]) => void;
    t: (k: string, vars?: any) => string;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDoc);
        window.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            window.removeEventListener("keydown", onKey);
        };
    }, [open]);
    const label = (v: ExtractField["type"]) => t(`ocr.v2.fields.type.${v}`);
    const rowStyle = (active: boolean, hover: boolean): React.CSSProperties => ({
        display: "flex", alignItems: "center", gap: 8,
        padding: "7px 10px", fontSize: 12,
        cursor: "pointer",
        background: active ? "var(--color-accent-dim)" : hover ? "var(--color-bg-elevated)" : "transparent",
        color: active ? "var(--color-text-1)" : "var(--color-text-2)",
        borderRadius: 6,
        fontFamily: "inherit",
    });
    return (
        <div ref={rootRef} style={{ position: "relative", minWidth: 128 }}>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    width: "100%", padding: "8px 10px",
                    borderRadius: 10,
                    background: "var(--color-bg-panel)",
                    color: "var(--color-text-1)",
                    border: `1px solid ${open ? "var(--color-accent-border)" : "var(--color-border-strong)"}`,
                    fontSize: 12, fontFamily: "inherit",
                    cursor: "pointer", justifyContent: "space-between",
                }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{
                        width: 8, height: 8, borderRadius: "50%",
                        background: TYPE_COLOR[value] || "#94a3b8",
                        flexShrink: 0,
                    }} />
                    {label(value)}
                </span>
                <span style={{
                    display: "inline-block",
                    transform: open ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.15s ease",
                    color: "var(--color-text-3)", fontSize: 10, lineHeight: 1,
                }}>▾</span>
            </button>
            {open && (
                <div role="listbox"
                    style={{
                        position: "absolute", top: "calc(100% + 4px)", right: 0,
                        zIndex: 20, minWidth: "100%",
                        background: "var(--color-bg-card)",
                        border: "1px solid var(--color-border-strong)",
                        borderRadius: 10, padding: 4,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
                    }}>
                    {FIELD_TYPES.map(tp => (
                        <FieldTypeRow key={tp} tp={tp} active={tp === value}
                            label={label(tp)}
                            onSelect={() => { onChange(tp); setOpen(false); }}
                            rowStyle={rowStyle} />
                    ))}
                </div>
            )}
        </div>
    );
}
function FieldTypeRow({ tp, active, label, onSelect, rowStyle }: {
    tp: ExtractField["type"];
    active: boolean;
    label: string;
    onSelect: () => void;
    rowStyle: (active: boolean, hover: boolean) => React.CSSProperties;
}) {
    const [hover, setHover] = useState(false);
    return (
        <div role="option" aria-selected={active}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onClick={onSelect}
            style={rowStyle(active, hover)}>
            <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: TYPE_COLOR[tp] || "#94a3b8",
                flexShrink: 0,
            }} />
            <span style={{ flex: 1 }}>{label}</span>
            {active && <span style={{ color: "var(--color-accent)", fontSize: 11 }}>✓</span>}
        </div>
    );
}

// ─── Bbox hint layer (ported from OCRWorkspace v1) ────────────────────────
// Overlays the preview so the user can (a) see stored bbox_hint rectangles per
// field, and (b) drag a new rectangle when a field is selected for editing.
// Uses percentage coords so it scales with the parent wrapper's zoom width.
// pointer-events fall through unless a field is being edited.
interface FieldForHint {
    id: string;
    name: string;
    bbox_hint?: FieldBboxHint;
}
function BboxHintLayer({ fields, currentPage, editingFieldId, draw, onDrawUpdate, onDrawCommit, drawLabel }: {
    fields: FieldForHint[];
    currentPage: number;
    editingFieldId: string | null;
    draw: { x0: number; y0: number; x1: number; y1: number } | null;
    onDrawUpdate: (d: { x0: number; y0: number; x1: number; y1: number } | null) => void;
    onDrawCommit: (fieldId: string, r: { x0: number; y0: number; x1: number; y1: number }) => void;
    drawLabel: string;
}) {
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
                background: isEditing ? "rgba(0,0,0,0.12)" : "transparent",
            }}
        >
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
                        borderRadius: 2, pointerEvents: "none",
                    }}>
                        <span style={{
                            position: "absolute", top: -18, left: 0,
                            fontSize: 9, fontWeight: 700, background: "rgba(220,38,38,0.9)",
                            color: "#fff", padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap",
                        }}>📍 {f.name}</span>
                    </div>
                );
            })}
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
            {isEditing && !draw && (
                <div style={{
                    position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
                    background: "rgba(220,38,38,0.92)", color: "#fff",
                    padding: "4px 12px", borderRadius: 12,
                    fontSize: 11.5, fontWeight: 600, pointerEvents: "none",
                    whiteSpace: "nowrap",
                }}>
                    📍 {drawLabel} · Esc
                </div>
            )}
        </div>
    );
}
