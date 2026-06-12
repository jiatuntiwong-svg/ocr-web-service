"use client";
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { PDFDocument } from "pdf-lib";
import { exportOCRResult } from "@/lib/exportUtils";
import { User } from "@/lib/types";
import { Icon } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { apiError } from "@/lib/friendlyError";
import { fetchJson } from "@/lib/fetchJson";
import { ErrorCode } from "@/lib/errorCodes";
import { isExcelFile, type ExcelCellRef } from "@/lib/excel-parser";
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

// ─── Local Types ──────────────────────────────────────────────────────────────
interface ExtractField { id: string; name: string; type: "text" | "number" | "currency" | "date" | "address" | "email" | "table"; }
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
};

const ACCENT = "#6366f1"; // OCR zone accent

// ─── Component ────────────────────────────────────────────────────────────────
export default function OCRWorkspace({ user, onDocumentProcessed, onNavigateToBilling, balance = 0 }: Props) {
    const { t } = useTranslation();

    // ─── File & Preview ───
    const [file, setFile] = useState<File | null>(null);
    const [previews, setPreviews] = useState<string[]>([]);
    const [previewPage, setPreviewPage] = useState(0);
    const dropRef = useRef<HTMLDivElement>(null);

    // ─── Processing ───
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [processingStep, setProcessingStep] = useState("");
    const [result, setResult] = useState<OCRResult | null>(null);
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
    const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);

    // ─── Session ───
    const [docId, setDocId] = useState<string | null>(null);

    // ─── Credit confirm dialog ───
    const [confirmDialog, setConfirmDialog] = useState<{
        reasons: ConfirmReason[];
        fingerprint: string;
    } | null>(null);

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
            const f = e.dataTransfer?.files[0];
            if (f) processFile(f);
        };
        el.addEventListener("dragover", prevent);
        el.addEventListener("drop", onDrop);
        return () => { el.removeEventListener("dragover", prevent); el.removeEventListener("drop", onDrop); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── File processing (PDF → per-page previews via pdf-lib) ──
    const processFile = useCallback(async (f: File) => {
        setFile(f);
        setResult(null);
        setError(null);
        previews.forEach(p => URL.revokeObjectURL(p));
        setPreviews([]);
        setPreviewPage(0);

        if (isExcelFile(f)) {
            // ExcelPreview parses the file directly — no blob URL needed.
            setPreviews([]);
            return;
        }

        if (f.type === "application/pdf") {
            try {
                const ab = await f.arrayBuffer();
                const pdf = await PDFDocument.load(ab);
                const pages: string[] = [];
                for (let i = 0; i < pdf.getPageCount(); i++) {
                    const sub = await PDFDocument.create();
                    const [p] = await sub.copyPages(pdf, [i]);
                    sub.addPage(p);
                    const bytes = await sub.save();
                    pages.push(URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: "application/pdf" })));
                }
                setPreviews(pages);
            } catch {
                setPreviews([URL.createObjectURL(f)]);
            }
        } else {
            setPreviews([URL.createObjectURL(f)]);
        }
    }, [previews]);

    const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (f) processFile(f);
    };

    // ── Template actions ──
    const applyTemplate = (tpl: Template) => {
        setExtractFields(JSON.parse(tpl.fields_json));
        setActiveTemplateId(tpl.id);
    };

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

    // ── Upload + Poll ──
    const handleUpload = async () => {
        if (!file) return;
        setLoading(true);
        setResult(null);
        setError(null);
        setProgress(10);
        setProcessingStep(t("ocr.extracting"));

        const formData = new FormData();
        formData.append("file", file);
        if (user) formData.append("userId", user.id);
        formData.append("fields", extractFields.map(f => f.type !== "text" ? `${f.name} (${f.type})` : f.name).join(", "));

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
                    setIsExpandedView(true);
                    setProgress(100);
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
        setPreviews([]);
        setResult(null);
        setError(null);
        setDocId(null);
        setIsExpandedView(false);
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
                            return (
                                <button
                                    key={f.id}
                                    className="ocr-field-chip"
                                    onClick={() => setExtractFields(prev => prev.filter(x => x.id !== f.id))}
                                    style={{
                                        display: "inline-flex", alignItems: "center", gap: 5,
                                        padding: "5px 10px", borderRadius: 6, cursor: "pointer",
                                        border: `1px solid ${c}55`, background: `${c}18`,
                                        color: c, fontSize: 12.5, fontWeight: 600,
                                        ["--chip-color" as any]: c,
                                        transition: "background 0.15s, border-color 0.15s, transform 0.15s, box-shadow 0.15s",
                                    }}
                                    title="Click to remove"
                                >
                                    <span style={{ fontSize: 9, opacity: 0.8, textTransform: "uppercase" }}>{f.type}</span>
                                    {f.name}
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
                                {newFieldType} <Icon.ChevronDown width={10} height={10} />
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
                                                {typ}
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
                        {!file ? (
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
                                <input type="file" style={{ display: "none" }} onChange={handleFileInput} accept="application/pdf,image/*,.xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" />
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

                                <div style={{
                                    flex: 1, position: "relative", overflow: "hidden",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    background: "var(--color-bg-body)",
                                }}>
                                    {file && isExcelFile(file) ? (
                                        <div style={{ position: "absolute", inset: 0 }}>
                                            <ExcelPreview file={file} highlights={excelHighlights} />
                                        </div>
                                    ) : previews[previewPage] && (
                                        file?.type === "application/pdf"
                                            ? <iframe
                                                src={`${previews[previewPage]}#toolbar=0&navpanes=0&view=FitH`}
                                                style={{ width: "100%", height: "100%", border: 0 }}
                                            />
                                            : <img
                                                src={previews[previewPage]}
                                                alt="Preview"
                                                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                                            />
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

                                {/* Extract CTA — only when no result yet */}
                                {!result && (
                                    <div style={{
                                        padding: "10px 12px",
                                        borderTop: "1px solid var(--color-border)",
                                        flexShrink: 0,
                                    }}>
                                        <button
                                            onClick={tryRun}
                                            disabled={loading || extractFields.length === 0}
                                            style={{
                                                width: "100%", padding: "10px 16px",
                                                background: loading || extractFields.length === 0 ? "var(--color-bg-elevated)" : ACCENT,
                                                color: loading || extractFields.length === 0 ? "var(--color-text-3)" : "#fff",
                                                border: "none", borderRadius: 8,
                                                fontSize: 13, fontWeight: 700,
                                                cursor: loading || extractFields.length === 0 ? "not-allowed" : "pointer",
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
                                            {Object.entries(result).map(([key, item]: [string, any]) => {
                                                const val = (item && typeof item === "object" && "value" in item) ? item.value : item;
                                                const conf = (item && typeof item === "object" && "confidence" in item) ? Number(item.confidence) : null;
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
                                                    <tr key={key} style={{ borderTop: "1px solid var(--color-border)" }}>
                                                        <td style={{ padding: "9px 12px", verticalAlign: "top" }}>
                                                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                                <span style={{
                                                                    fontSize: 9.5, background: `${c}22`, color: c,
                                                                    padding: "2px 6px", borderRadius: 4,
                                                                    fontWeight: 600, textTransform: "uppercase",
                                                                }}>{typeHint}</span>
                                                                <span style={{ color: "var(--color-text-2)" }}>{key.replace(/_/g, " ")}</span>
                                                            </div>
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
                                                            ) : (
                                                                <input
                                                                    type="text"
                                                                    value={fmt(val)}
                                                                    onChange={e => updateField(key, e.target.value)}
                                                                    placeholder="—"
                                                                    style={{
                                                                        width: "100%",
                                                                        background: "transparent",
                                                                        border: "1px solid transparent",
                                                                        padding: "3px 6px", borderRadius: 4,
                                                                        color: "var(--color-text-1)",
                                                                        fontSize: 12.5, outline: "none",
                                                                    }}
                                                                />
                                                            )}
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
