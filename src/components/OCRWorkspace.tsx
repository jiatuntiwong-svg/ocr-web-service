"use client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { PDFDocument } from "pdf-lib";
import { exportOCRResult } from "@/lib/exportUtils";
import { User } from "@/lib/types";

// ─── Local Types (OCR workspace-specific) ─────────────────────────────────────
interface ExtractField { id: string; name: string; type: "text" | "number" | "currency" | "date" | "address" | "email" | "table"; }
interface Template { id: string; name: string; fields_json: string; user_id?: string; }
interface OCRResult { [key: string]: any; }

interface Props {
    user: User | null;
    onDocumentProcessed?: () => void;
}

// ─── Field type badge ─────────────────────────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
    text: "bg-blue-100 dark:bg-blue-900/40 text-blue-600 border-blue-200 dark:border-blue-800",
    number: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 border-emerald-200 dark:border-emerald-800",
    currency: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 border-emerald-200 dark:border-emerald-800",
    date: "bg-violet-100 dark:bg-violet-900/40 text-violet-600 border-violet-200 dark:border-violet-800",
    address: "bg-amber-100 dark:bg-amber-900/40 text-amber-600 border-amber-200 dark:border-amber-800",
    email: "bg-rose-100 dark:bg-rose-900/40 text-rose-600 border-rose-200 dark:border-rose-800",
    table: "bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600",
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
    text: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" /></svg>,
    number: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>,
    currency: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    date: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
    address: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.242-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    email: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>,
    table: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>,
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function OCRWorkspace({ user, onDocumentProcessed }: Props) {
    // File & Preview
    const [file, setFile] = useState<File | null>(null);
    const [previews, setPreviews] = useState<string[]>([]);
    const [previewPage, setPreviewPage] = useState(0);
    const dropRef = useRef<HTMLDivElement>(null);

    // Processing
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [processingStep, setProcessingStep] = useState("");
    const [result, setResult] = useState<OCRResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Templates
    const [templates, setTemplates] = useState<Template[]>([]);
    const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
    const [templateName, setTemplateName] = useState("");
    const [templateSearch, setTemplateSearch] = useState("");
    const [bookmarkedIds, setBookmarkedIds] = useState<string[]>([]);
    const [showOnlyBookmarks, setShowOnlyBookmarks] = useState(false);
    const [savingTemplate, setSavingTemplate] = useState(false);

    // AI Models
    const [aiModels, setAiModels] = useState<any[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>("");

    // Fields
    const [extractFields, setExtractFields] = useState<ExtractField[]>([
        { id: "1", name: "ชื่อบริษัท", type: "text" },
        { id: "2", name: "เลขผู้เสียภาษี", type: "number" },
        { id: "3", name: "ที่อยู่ติดต่อ", type: "address" },
        { id: "4", name: "ยอดรวม", type: "currency" },
        { id: "5", name: "วันที่", type: "date" },
    ]);
    const [newFieldName, setNewFieldName] = useState("");
    const [newFieldType, setNewFieldType] = useState<ExtractField["type"]>("text");
    const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);

    // Session info
    const [docId, setDocId] = useState<string | null>(null);

    // ── Load bookmarks from localStorage ───────────────────────────────────────
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

    // ── Fetch templates on load ──────────────────────────────────────────────────
    useEffect(() => {
        if (!user) return;
        fetch(`/api/templates?userId=${user.id}`)
            .then(r => r.json())
            .then((d: any) => { if (Array.isArray(d)) setTemplates(d); })
            .catch(console.error);

        // Fetch AI Models
        fetch("/api/admin/settings")
            .then(r => r.json())
            .then((data: any) => {
                if (data.configs && data.configs.length > 0) {
                    setAiModels(data.configs);
                    setSelectedModelId(data.configs[0].id);
                }
            })
            .catch(console.error);
    }, [user]);

    // Deduplicate AI models for the UI (same model/provider = group)
    const displayModels = React.useMemo(() => {
        const unique = new Map();
        aiModels.forEach(m => {
            const key = `${m.provider}-${m.model}`;
            if (!unique.has(key)) unique.set(key, m);
        });
        return Array.from(unique.values());
    }, [aiModels]);

    // ── Drag & Drop ──────────────────────────────────────────────────────────────
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

    // ── File processing ──────────────────────────────────────────────────────────
    const processFile = useCallback(async (f: File) => {
        setFile(f);
        setResult(null);
        setError(null);
        previews.forEach(p => URL.revokeObjectURL(p));
        setPreviews([]);
        setPreviewPage(0);

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

    // ── Template actions ─────────────────────────────────────────────────────────
    const applyTemplate = (t: Template) => {
        setExtractFields(JSON.parse(t.fields_json));
        setActiveTemplateId(t.id);
    };

    const saveTemplate = async () => {
        if (!user || !templateName.trim()) return;
        setSavingTemplate(true);
        try {
            const res = await fetch("/api/templates", {
                method: "POST",
                body: JSON.stringify({ userId: user.id, name: templateName, fields: extractFields }),
            });
            const d = await res.json() as { success: boolean };
            if (d.success) {
                setTemplateName("");
                const r = await fetch(`/api/templates?userId=${user.id}`);
                const data = await r.json() as any[];
                if (Array.isArray(data)) setTemplates(data);
            }
        } finally {
            setSavingTemplate(false);
        }
    };

    const deleteTemplate = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!user || !confirm("Delete this template?")) return;
        await fetch(`/api/templates?id=${id}&userId=${user.id}`, { method: "DELETE" });
        setTemplates(prev => prev.filter(t => t.id !== id));
        if (activeTemplateId === id) setActiveTemplateId(null);
    };

    // ── Field management ─────────────────────────────────────────────────────────
    const addField = () => {
        if (!newFieldName.trim()) return;
        setExtractFields(prev => [...prev, { id: crypto.randomUUID(), name: newFieldName, type: newFieldType }]);
        setNewFieldName("");
    };

    // ── Upload & Poll ────────────────────────────────────────────────────────────
    const handleUpload = async () => {
        if (!file) return;
        setLoading(true);
        setResult(null);
        setError(null);
        setProgress(10);
        setProcessingStep("Uploading document...");

        const formData = new FormData();
        formData.append("file", file);
        if (user) formData.append("userId", user.id);
        formData.append("fields", extractFields.map(f => f.type !== "text" ? `${f.name} (${f.type})` : f.name).join(", "));
        formData.append("selectedModelId", selectedModelId);

        try {
            setProgress(30);
            const res = await fetch("/api/upload", { method: "POST", body: formData });
            const data = await res.json() as { success: boolean; documentId?: string; error?: string };

            if (!data.success || !data.documentId) {
                throw new Error(data.error || "Upload failed");
            }
            setDocId(data.documentId);
            setProgress(50);
            setProcessingStep("AI extraction in progress...");
            poll(data.documentId);
        } catch (err: any) {
            setError(err.message || "Upload failed");
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
                    setProgress(100);
                    setProcessingStep("Complete!");
                    if (onDocumentProcessed) onDocumentProcessed();
                    setTimeout(() => { setLoading(false); setProgress(0); }, 600);
                } else if (data.status === "error") {
                    clearInterval(interval);
                    setError(data.data?.error || "Processing failed");
                    setLoading(false);
                    setProgress(0);
                }
            } catch { /* keep polling */ }
        }, 2000);
    };

    // ── Result editing ───────────────────────────────────────────────────────────
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

    // ── Export ───────────────────────────────────────────────────────────────────
    const exportData = (format: "excel" | "csv") => {
        if (!result) return;
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        exportOCRResult(result, `OCR_${ts}`, format);
    };

    // ─── Confidence helpers ───────────────────────────────────────────────────────
    const confStyle = (c: number) =>
        c >= 80 ? "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800"
            : c >= 60 ? "text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800"
                : "text-rose-600 bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800";

    const hasLowConfidence = result &&
        Object.values(result).some((item: any) => item?.confidence !== undefined && Number(item.confidence) < 70);

    // ── Filtered Templates ──────────────────────────────────────────────────────
    const filteredTemplates = templates.filter(t => {
        const matchesSearch = t.name.toLowerCase().includes(templateSearch.toLowerCase());
        const isBookmarked = bookmarkedIds.includes(t.id);
        if (showOnlyBookmarks) return isBookmarked && matchesSearch;
        return matchesSearch;
    });

    const systemTemplates = filteredTemplates.filter(t => (t as any).user_id === "system");
    const myTemplates = filteredTemplates.filter(t => (t as any).user_id !== "system");
    const bookmarkedTemplates = filteredTemplates.filter(t => bookmarkedIds.includes(t.id));

    // ────────────────────────────────────────────────────────────────────────────
    return (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-in fade-in slide-in-from-bottom-4 duration-700">

            {/* ── COLUMN 1: Template Sidebar ─────────────────────────────────────── */}
            <aside className="lg:col-span-2 lg:sticky lg:top-6 space-y-4 order-3 lg:order-1">
                <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden flex flex-col max-h-[calc(100vh-100px)]">
                    <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 space-y-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                                <span className="text-[11px] font-black uppercase tracking-widest text-slate-500">Templates</span>
                            </div>
                            <button
                                onClick={() => setShowOnlyBookmarks(!showOnlyBookmarks)}
                                className={`p-1.5 rounded-lg transition-all ${showOnlyBookmarks ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30" : "text-slate-400 hover:bg-slate-100"}`}
                                title={showOnlyBookmarks ? "Show all" : "Show only bookmarks"}
                            >
                                <svg className={`w-3.5 h-3.5 ${showOnlyBookmarks ? "fill-current" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                            </button>
                        </div>

                        {/* Search Input */}
                        <div className="relative">
                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 font-bold" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                            <input
                                value={templateSearch}
                                onChange={e => setTemplateSearch(e.target.value)}
                                placeholder="Search templates..."
                                className="w-full pl-8 pr-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border-0 text-[10px] font-bold placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/20 transition-all"
                            />
                        </div>
                    </div>

                    <div className="p-3 space-y-5 overflow-y-auto flex-1 custom-scrollbar">
                        {/* Bookmarks Section (Only if bookmarks exist and not filtered out) */}
                        {bookmarkedTemplates.length > 0 && !showOnlyBookmarks && (
                            <div>
                                <p className="text-[9px] font-black uppercase tracking-widest text-amber-500 px-2 mb-2 flex items-center gap-1.5">
                                    <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                                    Favorites
                                </p>
                                <div className="space-y-1">
                                    {bookmarkedTemplates.map(t => (
                                        <div key={`fav-${t.id}`} className="group relative">
                                            <button
                                                onClick={() => applyTemplate(t)}
                                                className={`w-full text-left pl-3 pr-8 py-2.5 rounded-xl text-[11px] font-bold transition-all flex items-center gap-2 border border-transparent ${activeTemplateId === t.id
                                                    ? "bg-blue-600 text-white shadow-md shadow-blue-500/20"
                                                    : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                                                    }`}
                                            >
                                                <div className={`w-1 h-1 rounded-full flex-shrink-0 ${activeTemplateId === t.id ? "bg-white" : "bg-amber-400"}`} />
                                                <span className="truncate">{t.name.split(" (")[0]}</span>
                                            </button>
                                            <button
                                                onClick={(e) => toggleBookmark(t.id, e)}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 opacity-0 group-hover:opacity-100 text-amber-500 transition-all hover:scale-125"
                                            >
                                                <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* System Templates Section */}
                        {systemTemplates.length > 0 && (
                            <div>
                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 px-2 mb-2">Standard AI</p>
                                <div className="space-y-1">
                                    {systemTemplates.map(t => (
                                        <div key={t.id} className="group relative">
                                            <button
                                                onClick={() => applyTemplate(t)}
                                                className={`w-full text-left pl-3 pr-8 py-2.5 rounded-xl text-[11px] font-bold transition-all flex items-center gap-2 ${activeTemplateId === t.id
                                                    ? "bg-blue-600 text-white shadow-md shadow-blue-500/20"
                                                    : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                                                    }`}
                                            >
                                                <div className={`w-1.5 h-1.5 rounded-sm rotate-45 flex-shrink-0 ${activeTemplateId === t.id ? "bg-white" : "bg-blue-500"}`} />
                                                <span className="truncate">{t.name.split(" (")[0]}</span>
                                            </button>
                                            <button
                                                onClick={(e) => toggleBookmark(t.id, e)}
                                                className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 opacity-0 group-hover:opacity-100 transition-all hover:scale-125 ${bookmarkedIds.includes(t.id) ? "text-amber-500" : "text-slate-300 hover:text-amber-400"}`}
                                            >
                                                <svg className={`w-3.5 h-3.5 ${bookmarkedIds.includes(t.id) ? "fill-current" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* My Templates Section */}
                        {myTemplates.length > 0 && (
                            <div>
                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 px-2 mb-2">My Library</p>
                                <div className="space-y-1">
                                    {myTemplates.map(t => (
                                        <div key={t.id} className="group relative">
                                            <button
                                                onClick={() => applyTemplate(t)}
                                                className={`w-full text-left pl-3 pr-12 py-2.5 rounded-xl text-[11px] font-bold transition-all flex items-center gap-2 ${activeTemplateId === t.id
                                                    ? "bg-slate-900 dark:bg-slate-700 text-white"
                                                    : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                                                    }`}
                                            >
                                                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${activeTemplateId === t.id ? "bg-blue-400 animate-pulse" : "bg-slate-400"}`} />
                                                <span className="truncate">{t.name}</span>
                                            </button>
                                            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 transition-all">
                                                <button
                                                    onClick={(e) => toggleBookmark(t.id, e)}
                                                    className={`p-1.5 transition-all hover:scale-125 ${bookmarkedIds.includes(t.id) ? "text-amber-500" : "text-slate-300 hover:text-amber-400"}`}
                                                >
                                                    <svg className={`w-3 h-3 ${bookmarkedIds.includes(t.id) ? "fill-current" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                                                </button>
                                                <button
                                                    onClick={(e) => deleteTemplate(t.id, e)}
                                                    className="p-1.5 hover:text-rose-500 transition-all text-slate-300"
                                                >
                                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {filteredTemplates.length === 0 && (
                            <div className="py-10 text-center space-y-2 opacity-50">
                                <svg className="w-8 h-8 mx-auto text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>
                                <p className="text-[10px] font-bold">No templates found</p>
                            </div>
                        )}
                    </div>

                    {/* Sidebar Footer: Save Tool */}
                    <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                        <div className="space-y-2">
                            <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 px-1">New Template</p>
                            <input
                                value={templateName}
                                onChange={e => setTemplateName(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && saveTemplate()}
                                placeholder="Name..."
                                className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[10px] font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all shadow-sm"
                            />
                            <button
                                onClick={saveTemplate}
                                disabled={savingTemplate || !templateName.trim()}
                                className="w-full py-2.5 rounded-xl bg-blue-600 text-white text-[9px] font-black uppercase tracking-[0.1em] hover:bg-blue-500 disabled:opacity-50 transition-all shadow-lg shadow-blue-500/10 flex items-center justify-center gap-2"
                            >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" /></svg>
                                {savingTemplate ? "Saving..." : "Create Template"}
                            </button>
                        </div>
                    </div>
                </div>
            </aside>


            {/* ── COLUMN 2: Configuration & Upload ───────────────────────────────── */}
            <section className="lg:col-span-5 space-y-5 order-1 lg:order-2" ref={dropRef}>

                {/* ─ Field Mapping Card ─ */}
                <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm relative z-20">
                    <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                            <span className="text-[11px] font-black uppercase tracking-widest text-slate-500">Extraction Fields</span>
                        </div>
                        <span className="text-[10px] font-bold text-slate-400">{extractFields.length} fields active</span>
                    </div>

                    <div className="p-5 space-y-4">
                        {/* Active fields */}
                        <div className="flex flex-wrap gap-2 min-h-[40px]">
                            {extractFields.map(f => (
                                <div key={f.id} className={`group flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-lg border text-xs font-bold transition-all hover:scale-[1.02] shadow-sm ${TYPE_COLORS[f.type]}`}>
                                    <span className="flex-shrink-0 opacity-70">{TYPE_ICONS[f.type]}</span>
                                    <span>{f.name}</span>
                                    <div className="h-3 w-px bg-current opacity-20 mx-1" />
                                    <span className="opacity-50 text-[9px] uppercase tracking-wider">{f.type}</span>
                                    <button onClick={() => setExtractFields(prev => prev.filter(x => x.id !== f.id))} className="ml-1 opacity-0 group-hover:opacity-100 hover:scale-125 hover:text-rose-500 transition-all">
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                </div>
                            ))}
                            {extractFields.length === 0 && (
                                <p className="text-xs text-slate-400 italic">No fields — add some below or pick a template</p>
                            )}
                        </div>

                        {/* Add field row */}
                        <div className="flex gap-2">
                            <input
                                value={newFieldName}
                                onChange={e => setNewFieldName(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && addField()}
                                placeholder="Field name..."
                                className="flex-1 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                            />
                            <div className="relative">
                                <button
                                    onClick={() => setIsTypeDropdownOpen(!isTypeDropdownOpen)}
                                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition-all min-w-[110px] justify-between ${TYPE_COLORS[newFieldType]}`}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="opacity-70">{TYPE_ICONS[newFieldType]}</span>
                                        <span className="capitalize">{newFieldType}</span>
                                    </div>
                                    <svg className={`w-3 h-3 opacity-50 transition-transform ${isTypeDropdownOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                </button>

                                {isTypeDropdownOpen && (
                                    <>
                                        <div className="fixed inset-0 z-[60]" onClick={() => setIsTypeDropdownOpen(false)} />
                                        <div className="absolute top-full left-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl shadow-slate-900/10 z-[70] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                                            <div className="p-1.5 grid grid-cols-1 gap-0.5">
                                                {Object.keys(TYPE_COLORS).map((type) => (
                                                    <button
                                                        key={type}
                                                        onClick={() => {
                                                            setNewFieldType(type as ExtractField["type"]);
                                                            setIsTypeDropdownOpen(false);
                                                        }}
                                                        className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-xs font-bold transition-all ${newFieldType === type
                                                            ? TYPE_COLORS[type].split(" ").map(c => c.replace("text-", "bg-").replace("bg-", "text-")).join(" ")
                                                            : "text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                                                            }`}
                                                    >
                                                        <span className={newFieldType === type ? "text-current" : TYPE_COLORS[type].split(" ").find(c => c.startsWith("text-"))}>
                                                            {TYPE_ICONS[type]}
                                                        </span>
                                                        <span className="capitalize">{type}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                            <button
                                onClick={addField}
                                className="px-4 py-2 rounded-xl bg-slate-900 dark:bg-blue-600 text-white hover:bg-blue-600 dark:hover:bg-blue-500 transition-all shadow-sm"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
                            </button>
                        </div>
                    </div>
                </div>

                {/* ─ Upload / Preview Card ─ */}
                <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden relative z-10">
                    {previews.length === 0 ? (
                        /* Drop Zone */
                        <label className="flex flex-col items-center justify-center gap-5 p-12 cursor-pointer group min-h-[280px]">
                            <input type="file" className="hidden" onChange={handleFileInput} accept="application/pdf,image/*" />
                            <div className="h-20 w-20 rounded-3xl bg-slate-50 dark:bg-slate-800 border-2 border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center group-hover:border-blue-500 group-hover:bg-blue-50 dark:group-hover:bg-blue-900/20 transition-all duration-500 group-hover:scale-110 group-hover:rotate-3">
                                <svg className="w-9 h-9 text-slate-400 group-hover:text-blue-600 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                            </div>
                            <div className="text-center space-y-1">
                                <p className="font-black text-slate-800 dark:text-slate-200">Drop your document here</p>
                                <p className="text-sm text-slate-400">or <span className="text-blue-600 font-bold">click to browse</span> · PDF or Image</p>
                            </div>
                            <div className="flex gap-2">
                                {["PDF", "JPG", "PNG", "JPEG", "TIFF"].map(ext => (
                                    <span key={ext} className="text-[9px] font-black uppercase bg-slate-100 dark:bg-slate-800 text-slate-400 px-2 py-1 rounded-md">{ext}</span>
                                ))}
                            </div>
                        </label>
                    ) : (
                        /* File Preview */
                        <div>
                            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                                <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600">
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                    </div>
                                    <div>
                                        <p className="text-xs font-bold dark:text-white truncate max-w-[160px]">{file?.name}</p>
                                        <p className="text-[10px] text-slate-400">{previews.length} page{previews.length > 1 ? "s" : ""} · {((file?.size ?? 0) / 1024).toFixed(0)} KB</p>
                                    </div>
                                </div>
                                <label className="cursor-pointer px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-[10px] font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                                    Replace
                                    <input type="file" className="hidden" onChange={handleFileInput} accept="application/pdf,image/*" />
                                </label>
                            </div>

                            {/* Page thumbnails */}
                            {previews.length > 1 && (
                                <div className="flex gap-2 px-4 py-2 overflow-x-auto border-b border-slate-100 dark:border-slate-800">
                                    {previews.map((_, i) => (
                                        <button key={i} onClick={() => setPreviewPage(i)}
                                            className={`flex-shrink-0 w-8 h-8 rounded-lg text-[10px] font-black transition-all ${i === previewPage ? "bg-blue-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200"}`}
                                        >{i + 1}</button>
                                    ))}
                                </div>
                            )}

                            <div className="max-h-[420px] overflow-y-auto">
                                {previews[previewPage] && (
                                    file?.type === "application/pdf"
                                        ? <iframe src={`${previews[previewPage]}#toolbar=0&navpanes=0`} className="w-full h-[420px] border-0" />
                                        : <img src={previews[previewPage]} alt="Preview" className="w-full h-auto object-contain" />
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* ─ AI Power Selector ─ */}
                {aiModels.length > 0 && (
                    <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 p-5 flex items-center gap-6 relative group/model z-30">
                        <div className="flex-1 space-y-2">
                            <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest px-1">AI Intelligence Core</label>

                            <div className="relative">
                                <button
                                    onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                                    className="w-full flex items-center justify-between bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 p-4 rounded-2xl hover:border-blue-500/50 transition-all group"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className={`h-8 w-8 rounded-xl flex items-center justify-center ${aiModels.find(m => m.id === selectedModelId)?.provider === 'gemini' ? 'bg-blue-100 text-blue-600' :
                                            aiModels.find(m => m.id === selectedModelId)?.provider === 'openai' ? 'bg-emerald-100 text-emerald-600' : 'bg-violet-100 text-violet-600'
                                            }`}>
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                        </div>
                                        <div className="text-left">
                                            <p className="text-xs font-black dark:text-white uppercase tracking-tight">
                                                {aiModels.find(m => m.id === selectedModelId)?.model || "Select Model"}
                                            </p>
                                            <p className="text-[10px] font-bold text-slate-400 font-mono">
                                                Intelligence Core
                                            </p>
                                        </div>
                                    </div>
                                    <svg className={`w-4 h-4 text-slate-300 transition-transform ${isModelDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                                </button>

                                {isModelDropdownOpen && (
                                    <>
                                        <div className="fixed inset-0 z-[60]" onClick={() => setIsModelDropdownOpen(false)} />
                                        <div className="absolute bottom-full left-0 mb-4 w-full bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-2xl z-[70] overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
                                            <div className="p-2 space-y-1">
                                                <p className="text-[9px] font-black uppercase text-slate-400 px-4 py-2 tracking-widest">Available AI Engines</p>
                                                {displayModels.map(m => (
                                                    <button
                                                        key={m.id}
                                                        onClick={() => { setSelectedModelId(m.id); setIsModelDropdownOpen(false); }}
                                                        className={`w-full flex items-center justify-between p-4 rounded-2xl transition-all ${aiModels.find(curr => curr.id === selectedModelId)?.model === m.model ? 'bg-blue-50 dark:bg-blue-900/20 ring-1 ring-blue-500/20' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                                                    >
                                                        <div className="flex items-center gap-3">
                                                            <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${m.provider === 'gemini' ? 'bg-blue-100 text-blue-600' :
                                                                m.provider === 'openai' ? 'bg-emerald-100 text-emerald-600' : 'bg-violet-100 text-violet-600'
                                                                }`}>
                                                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                                            </div>
                                                            <div className="text-left">
                                                                <p className={`text-sm font-black ${aiModels.find(curr => curr.id === selectedModelId)?.model === m.model ? 'text-blue-600' : 'dark:text-white'}`}>{m.model}</p>
                                                                <p className="text-[10px] font-bold text-slate-400 font-mono uppercase tracking-widest">{m.provider}</p>
                                                            </div>
                                                        </div>
                                                        {aiModels.find(curr => curr.id === selectedModelId)?.model === m.model && (
                                                            <div className="h-5 w-5 bg-blue-600 rounded-full flex items-center justify-center">
                                                                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                                            </div>
                                                        )}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* ─ Action Bar ─ */}
                <div className="flex items-center gap-3 relative z-10">
                    <button
                        onClick={handleUpload}
                        disabled={loading || !file || extractFields.length === 0}
                        className={`flex-1 py-4 rounded-2xl font-black text-[11px] uppercase tracking-[0.15em] transition-all duration-300 flex items-center justify-center gap-3 shadow-lg ${loading || !file || extractFields.length === 0
                            ? "bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed"
                            : "bg-slate-900 hover:bg-blue-600 text-white shadow-blue-500/10 hover:-translate-y-0.5"
                            }`}
                    >
                        {loading ? (
                            <>
                                <div className="h-4 w-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                                <span>{processingStep || "Processing..."}</span>
                            </>
                        ) : (
                            <>
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                Run OCR Extraction
                            </>
                        )}
                    </button>
                    {file && !loading && (
                        <button
                            onClick={() => { setFile(null); setPreviews([]); setResult(null); setError(null); }}
                            className="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 hover:bg-rose-50 hover:border-rose-200 dark:hover:bg-rose-900/20 dark:hover:border-rose-800 text-slate-400 hover:text-rose-500 transition-all"
                            title="Clear"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                    )}
                </div>

                {/* Progress Bar */}
                {loading && progress > 0 && (
                    <div className="space-y-2">
                        <div className="flex justify-between text-[10px] font-bold text-slate-400">
                            <span>{processingStep}</span>
                            <span>{progress}%</span>
                        </div>
                        <div className="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-600 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
                        </div>
                    </div>
                )}
            </section>

            {/* ── COLUMN 3: Results ──────────────────────────────────────────────── */}
            <section className="lg:col-span-5 space-y-5 order-2 lg:order-3 lg:sticky lg:top-6 lg:max-h-[calc(100vh-100px)] lg:overflow-y-auto">

                {/* Empty / Error / Loading / Result states */}
                {!result && !loading && !error && (
                    <div className="flex flex-col items-center justify-center min-h-[420px] bg-white/70 dark:bg-slate-900/70 backdrop-blur-md rounded-[1.75rem] border-2 border-dashed border-slate-200 dark:border-slate-800 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-violet-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                        <div className="relative text-center space-y-5 p-10">
                            <div className="h-24 w-24 mx-auto bg-gradient-to-br from-blue-50 to-violet-50 dark:from-blue-900/20 dark:to-violet-900/20 rounded-3xl flex items-center justify-center ring-8 ring-blue-500/5 group-hover:scale-110 transition-transform duration-700">
                                <svg className="w-12 h-12 text-blue-600/50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                            </div>
                            <div>
                                <p className="font-black text-lg text-slate-700 dark:text-slate-300">Ready to Extract</p>
                                <p className="text-sm text-slate-400 mt-1">Upload a document and configure fields,<br />then click <strong className="text-blue-600">Run OCR Extraction</strong></p>
                            </div>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-[1.75rem] p-6 flex items-start gap-4">
                        <div className="h-10 w-10 rounded-xl bg-rose-500 flex items-center justify-center flex-shrink-0 shadow-lg shadow-rose-500/30">
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </div>
                        <div>
                            <p className="font-black text-rose-700 dark:text-rose-400">Processing Error</p>
                            <p className="text-sm text-rose-600/70 dark:text-rose-400/70 mt-1">{error}</p>
                            <button onClick={() => setError(null)} className="mt-3 text-[10px] font-black uppercase text-rose-500 hover:underline">Dismiss</button>
                        </div>
                    </div>
                )}

                {loading && (
                    <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 p-8 space-y-4">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="h-8 w-8 rounded-xl bg-blue-600 flex items-center justify-center">
                                <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            </div>
                            <p className="text-xs font-black uppercase tracking-widest text-blue-600">AI Processing</p>
                        </div>
                        {[1, 2, 3, 4].map(i => (
                            <div key={i} className="space-y-2 animate-pulse">
                                <div className="h-2 w-1/3 bg-slate-100 dark:bg-slate-800 rounded-full" />
                                <div className="h-8 w-full bg-slate-50 dark:bg-slate-800/50 rounded-xl" />
                            </div>
                        ))}
                    </div>
                )}

                {result && !loading && (
                    <div className="space-y-4">
                        {/* Result header */}
                        <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-[1.75rem] p-6 flex items-center justify-between relative overflow-hidden">
                            <div className="absolute inset-0 bg-gradient-to-br from-blue-600/10 to-violet-600/10" />
                            <div className="relative">
                                <p className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-0.5">Extraction Complete</p>
                                <p className="text-xl font-black text-white">{Object.keys(result).length} Fields Extracted</p>
                                {docId && <p className="text-[10px] text-white/30 mt-1 font-mono">ID: {docId.slice(0, 16)}…</p>}
                            </div>
                            <div className="relative flex items-center gap-2">
                                <button onClick={() => exportData("excel")} title="Export Excel" className="p-3 rounded-xl bg-white/10 hover:bg-white hover:text-slate-900 text-white transition-all group/btn">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                </button>
                                <button onClick={() => exportData("csv")} title="Export CSV" className="p-3 rounded-xl bg-white/10 hover:bg-white hover:text-slate-900 text-white transition-all">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                </button>
                            </div>
                        </div>

                        {/* Low confidence warning */}
                        {hasLowConfidence && (
                            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 flex items-start gap-3">
                                <div className="h-8 w-8 rounded-xl bg-amber-500 flex items-center justify-center flex-shrink-0">
                                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                                </div>
                                <div>
                                    <p className="text-xs font-black text-amber-800 dark:text-amber-400 uppercase tracking-wider">Review Required</p>
                                    <p className="text-xs text-amber-700/70 dark:text-amber-400/60 mt-0.5">Some fields have low confidence. Please verify highlighted data before exporting.</p>
                                </div>
                            </div>
                        )}

                        {/* Fields */}
                        <div className="space-y-3">
                            {Object.entries(result).map(([key, item]: [string, any]) => {
                                const val = (item && typeof item === "object" && "value" in item) ? item.value : item;
                                const conf = (item && typeof item === "object" && "confidence" in item) ? Number(item.confidence) : null;
                                const low = conf !== null && conf < 70;

                                const formatValue = (v: any): string => {
                                    if (v === null || v === undefined) return "";
                                    if (Array.isArray(v)) return v.map(formatValue).join(", ");
                                    if (typeof v === "object") {
                                        return Object.values(v).filter(x => x !== null && x !== undefined).map(formatValue).join(" / ");
                                    }
                                    return String(v);
                                };

                                return (
                                    <div key={key} className={`bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm rounded-2xl border transition-all shadow-sm hover:shadow-md ${low ? "border-amber-300 dark:border-amber-700 ring-2 ring-amber-500/10" : "border-slate-200 dark:border-slate-700"}`}>
                                        <div className="px-5 pt-4 pb-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{key.replace(/_/g, " ")}</span>
                                                    {low && <span className="text-[8px] font-black bg-amber-500 text-white px-1.5 py-0.5 rounded-full uppercase animate-pulse">Review</span>}
                                                </div>
                                                {conf !== null && (
                                                    <div className={`text-[9px] font-black px-2 py-1 rounded-full border ${confStyle(conf)}`}>
                                                        {conf}% confidence
                                                    </div>
                                                )}
                                            </div>

                                            {Array.isArray(val) ? (
                                                <div className="overflow-x-auto rounded-xl border border-slate-100 dark:border-slate-800 mt-2">
                                                    <table className="w-full text-[11px] border-collapse">
                                                        <thead>
                                                            <tr className="bg-slate-50 dark:bg-slate-800">
                                                                {val.length > 0 && Object.keys(val[0]).map(h => (
                                                                    <th key={h} className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">{h}</th>
                                                                ))}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {val.map((row: any, ri: number) => (
                                                                <tr key={ri} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                                                                    {Object.entries(row).map(([ck, cv], ci) => (
                                                                        <td key={ci} className="border-b border-slate-50 dark:border-slate-800 px-1 py-1">
                                                                            <input
                                                                                type="text"
                                                                                value={formatValue(cv)}
                                                                                onChange={e => updateCell(key, ri, ck, e.target.value)}
                                                                                className="w-full bg-transparent border-0 focus:ring-2 focus:ring-blue-500/20 rounded-lg px-2 py-1.5 font-semibold dark:text-slate-300 text-[11px]"
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
                                                    value={formatValue(val)}
                                                    onChange={e => updateField(key, e.target.value)}
                                                    placeholder="—"
                                                    className="w-full bg-transparent border-0 focus:ring-0 p-0 text-base font-black dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600"
                                                />
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Re-extract */}
                        <button
                            onClick={() => { setResult(null); setError(null); }}
                            className="w-full py-3 rounded-2xl border border-slate-200 dark:border-slate-700 text-xs font-black uppercase tracking-widest text-slate-400 hover:text-slate-700 dark:hover:text-white hover:border-slate-400 transition-all"
                        >
                            ← New Extraction
                        </button>
                    </div>
                )}
            </section>
        </div>
    );
}
