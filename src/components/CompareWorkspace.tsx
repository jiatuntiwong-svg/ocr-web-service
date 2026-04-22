"use client";
import React, { useState, useRef, useEffect } from "react";
import { User } from "@/lib/types";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

// pdfjs-dist v5 worker (installed locally)
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
).toString();

// ─── Shared Types ──────────────────────────────────
import { extractTokensOnFrontend } from "@/lib/frontend-ocr";
interface ExtractField { id: string; name: string; type: "text" | "number" | "currency" | "date" | "address" | "email" | "table"; }
interface Template { id: string; name: string; fields_json: string; user_id?: string; }

interface HighlightBox {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
}

interface CompareField {
    key: string;
    is_diff: boolean;
    doc1?: string | null;
    doc2?: string | null;
    doc3?: string | null;
    locations?: {
        doc1?: HighlightBox[];
        doc2?: HighlightBox[];
        doc3?: HighlightBox[];
    };
}

interface CompareResult {
    summary: string[];
    fields: CompareField[];
}

interface Props {
    user: User | null;
}

// ─── Field type badges ─────────────────────────────────────────────────────────
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


// Helper to compute exact rendered rect of an image ignoring letterbox
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

// ─── Preview Component ────────────────────────────────────────────────────────
const DocumentPreviewWithHighlights = ({ file, url, idx, highlights = [], selectedFieldKey }: any) => {
    const [numPages, setNumPages] = useState<number>();
    const [pageNumber, setPageNumber] = useState<number>(1);
    const containerRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const [imageRects, setImageRects] = useState<React.CSSProperties[]>([]);

    const activeHighlights = highlights
        .filter((h: any) => !selectedFieldKey || h.key === selectedFieldKey)
        .flatMap((h: any) => h.boxes || []);

    // Auto-jump to the page containing the first highlight for the selected field
    useEffect(() => {
        if (selectedFieldKey && activeHighlights.length > 0) {
            const firstBox = activeHighlights[0];
            if (firstBox && firstBox.page) {
                setPageNumber(firstBox.page);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedFieldKey, highlights]);

    // Recalculate pixel coordinates for images
    const recalculateImageHighlights = React.useCallback(() => {
        if (!imgRef.current || file?.type === "application/pdf") return;
        const el = imgRef.current;
        if (!el.naturalWidth) return;

        const { renderedW, renderedH, offsetX, offsetY } = getImageRenderedRect(el);

        const rects = activeHighlights.map((box: any) => ({
            position: 'absolute' as const,
            left: offsetX + box.x * renderedW + "px",
            top: offsetY + box.y * renderedH + "px",
            width: box.width * renderedW + "px",
            height: box.height * renderedH + "px",
            border: '2px solid rgba(59, 130, 246, 0.9)',
            backgroundColor: 'rgba(59, 130, 246, 0.2)',
            boxShadow: '0 0 8px rgba(59,130,246,0.5)',
            pointerEvents: 'none' as const,
            transition: 'all 0.15s ease',
            zIndex: 20
        }));
        setImageRects(rects);
    }, [activeHighlights, file?.type]);

    useEffect(() => {
        recalculateImageHighlights();
        const container = containerRef.current;
        if (!container || file?.type === "application/pdf") return;
        
        const ro = new ResizeObserver(() => recalculateImageHighlights());
        ro.observe(container);
        return () => ro.disconnect();
    }, [recalculateImageHighlights, file?.type]);

    if (!file) return null;

    const renderPdfHighlightBox = (box: any, i: number) => (
        <div
            key={i}
            className="absolute border-2 border-blue-500 bg-blue-500/20 shadow-[0_0_8px_rgba(59,130,246,0.6)] z-20 pointer-events-none transition-all duration-300 animate-in fade-in zoom-in-95"
            style={{
                left: (box.x * 100).toFixed(4) + "%",
                top: (box.y * 100).toFixed(4) + "%",
                width: (box.width * 100).toFixed(4) + "%",
                height: (box.height * 100).toFixed(4) + "%",
            }}
        />
    );

    return (
        <div className="relative shadow-sm mx-auto w-full h-full min-h-[50vh] overflow-auto bg-slate-200/50 dark:bg-slate-900/50 flex justify-center p-4 custom-scrollbar" ref={containerRef}>
            {file.type === "application/pdf" ? (
                <div className="relative inline-block bg-white shadow-xl">
                    <Document
                        file={file}
                        onLoadSuccess={({ numPages: np }) => setNumPages(np)}
                        loading={<div className="w-full h-64 flex items-center justify-center text-slate-400 text-xs font-bold">กำลังโหลด PDF...</div>}
                    >
                        <Page
                            pageNumber={pageNumber}
                            renderTextLayer={false}
                            renderAnnotationLayer={false}
                            className="shadow-md transition-all relative"
                        >
                            {activeHighlights
                                .filter((h: any) => h.page === pageNumber)
                                .map(renderPdfHighlightBox)}
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
            ) : (
                <div className="relative inline-block w-full h-full flex items-center justify-center">
                    <img ref={imgRef} src={url} alt={"Doc " + (idx + 1)} onLoad={recalculateImageHighlights} className="max-w-full max-h-[80vh] h-auto object-contain pointer-events-none rounded-sm border border-slate-200 dark:border-slate-800 shadow-md block relative" />
                    {imageRects.map((style, i) => (
                        <div key={i} style={style} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default function CompareWorkspace({ user }: Props) {
    // ── Local State ──
    const [files, setFiles] = useState<(File | null)[]>([null, null]);
    const [previews, setPreviews] = useState<(string | null)[]>([null, null]);
    const [targetModelId, setTargetModelId] = useState<string>("");
    const [aiModels, setAiModels] = useState<any[]>([]);

    const [loading, setLoading] = useState(false);
    const [processStep, setProcessStep] = useState<string>("");
    const [result, setResult] = useState<CompareResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isExpandedView, setIsExpandedView] = useState(false);

    // Templates
    const [templates, setTemplates] = useState<Template[]>([]);
    const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
    const [templateName, setTemplateName] = useState("");
    const [templateSearch, setTemplateSearch] = useState("");
    const [bookmarkedIds, setBookmarkedIds] = useState<string[]>([]);
    const [showOnlyBookmarks, setShowOnlyBookmarks] = useState(false);
    const [savingTemplate, setSavingTemplate] = useState(false);

    // Fields
    const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);
    const [extractFields, setExtractFields] = useState<ExtractField[]>([
        { id: "1", name: "ประเภทเอกสาร", type: "text" },
        { id: "2", name: "เลขที่เอกสาร", type: "number" },
        { id: "3", name: "วันที่", type: "date" },
        { id: "4", name: "ชื่อผู้ออก", type: "text" },
        { id: "5", name: "เลขผู้เสียภาษี", type: "number" },
        { id: "6", name: "เงื่อนไขชำระเงิน", type: "text" },
        { id: "7", name: "ยอดรวม", type: "currency" },
        { id: "8", name: "รายการสินค้า", type: "table" }
    ]);
    const [newFieldName, setNewFieldName] = useState("");
    const [newFieldType, setNewFieldType] = useState<ExtractField["type"]>("text");
    const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);

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

    // ── Fetch templates & Models on load ──────────────────────────────────────────────────
    useEffect(() => {
        if (!user) return;
        fetch(`/api/templates?userId=${user.id}`)
            .then(r => r.json())
            .then((d: any) => { if (Array.isArray(d)) setTemplates(d); })
            .catch(console.error);

        fetch("/api/admin/settings")
            .then(r => r.json())
            .then((data: any) => {
                if (data.configs && data.configs.length > 0) {
                    const activeConfigs = data.configs.filter((c: any) => c.isActive !== false);
                    setAiModels(activeConfigs);
                    if (activeConfigs.length > 0) {
                        const pro = activeConfigs.find((c: any) => c.model.includes('pro'));
                        setTargetModelId(pro ? pro.id : activeConfigs[0].id);
                    }
                }
            })
            .catch(console.error);
    }, [user]);

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

    // ── File Management ───────────────────────────────────────────────────────────
    const handleFileInput = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const newFiles = [...files];
            const newPreviews = [...previews];
            newFiles[index] = file;
            if (newPreviews[index]) URL.revokeObjectURL(newPreviews[index] as string);
            newPreviews[index] = URL.createObjectURL(file);
            setFiles(newFiles);
            setPreviews(newPreviews);
            setResult(null); // Reset results on new upload
            setSelectedFieldKey(null);
            setIsExpandedView(false);
        }
    };

    const addFileSlot = () => {
        if (files.length < 3) {
            setFiles([...files, null]);
            setPreviews([...previews, null]);
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
        setResult(null);
        setIsExpandedView(false);
    };

    const runComparison = async () => {
        const validFiles = files.filter(f => f !== null) as File[];
        if (validFiles.length < 2) return;

        setLoading(true);
        setProcessStep("Analyzing AI and extracting accurate coordinates...");
        setError(null);
        setResult(null);
        setSelectedFieldKey(null);

        const formData = new FormData();
        if (user) formData.append("userId", user.id);
        if (targetModelId) formData.append("selectedModelId", targetModelId);
        
        const stringifiedFields = extractFields.map(f => f.type !== "text" ? `${f.name} (${f.type})` : f.name).join(", ");
        if (stringifiedFields) formData.append("fields", stringifiedFields);

        const tokenPromises = validFiles.map(file => extractTokensOnFrontend(file));
        const allTokens = await Promise.all(tokenPromises);

        validFiles.forEach((file, idx) => {
            formData.append(`file${idx + 1}`, file);
            formData.append(`docTokens${idx + 1}`, JSON.stringify(allTokens[idx]));
        });

        try {
            const res = await fetch("/api/compare", { method: "POST", body: formData });
            const data = await res.json() as any;

            if (!data.success) {
                throw new Error(data.error || "Comparison failed");
            }

            if (data.extracted_data && Array.isArray(data.extracted_data.fields)) {
                setResult(data.extracted_data);
                setIsExpandedView(true);
            } else {
                setResult({ summary: [], fields: [] }); // no diffs found
                setIsExpandedView(true);
            }
        } catch (err: any) {
            setError(err.message || "An error occurred during comparison.");
        } finally {
            setLoading(false);
            setProcessStep("");
        }
    };

    const validFilesCount = files.filter(f => f !== null).length;

    // Helper to get highlights per document
    const getHighlightsForDoc = (docIndex: number) => {
        if (!result || !result.fields) return [];
        return result.fields.map(field => {
            const docKey = `doc${docIndex + 1}` as keyof NonNullable<CompareField['locations']>;
            const boxes = field.locations && field.locations[docKey] ? field.locations[docKey] : [];
            return {
                key: field.key,
                boxes
            };
        }).filter(h => h.boxes && h.boxes.length > 0);
    };

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

    const showExpandedWorkspace = Boolean(result) && isExpandedView;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-in fade-in slide-in-from-bottom-4 duration-700">
            
            {/* ── COLUMN 1: Template Sidebar ─────────────────────────────────────── */}
            <aside className="lg:col-span-3 lg:sticky lg:top-6 space-y-4 order-3 lg:order-1">
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
                        {bookmarkedTemplates.length > 0 && !showOnlyBookmarks && (
                            <div>
                                <p className="text-[9px] font-black uppercase tracking-widest text-amber-500 px-2 mb-2 flex items-center gap-1.5">
                                    <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                                    Favorites
                                </p>
                                <div className="space-y-1">
                                    {bookmarkedTemplates.map(t => (
                                        <div key={`fav-${t.id}`} className="group relative">
                                            <button onClick={() => applyTemplate(t)} className={`w-full text-left pl-3 pr-8 py-2.5 rounded-xl text-[11px] font-bold transition-all flex items-center gap-2 border border-transparent ${activeTemplateId === t.id ? "bg-blue-600 text-white shadow-md shadow-blue-500/20" : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"}`}>
                                                <div className={`w-1 h-1 rounded-full flex-shrink-0 ${activeTemplateId === t.id ? "bg-white" : "bg-amber-400"}`} />
                                                <span className="truncate">{t.name.split(" (")[0]}</span>
                                            </button>
                                            <button onClick={(e) => toggleBookmark(t.id, e)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 opacity-0 group-hover:opacity-100 text-amber-500 transition-all hover:scale-125">
                                                <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        {systemTemplates.length > 0 && (
                            <div>
                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 px-2 mb-2">Standard AI</p>
                                <div className="space-y-1">
                                    {systemTemplates.map(t => (
                                        <div key={t.id} className="group relative">
                                            <button onClick={() => applyTemplate(t)} className={`w-full text-left pl-3 pr-8 py-2.5 rounded-xl text-[11px] font-bold transition-all flex items-center gap-2 ${activeTemplateId === t.id ? "bg-blue-600 text-white shadow-md shadow-blue-500/20" : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"}`}>
                                                <div className={`w-1.5 h-1.5 rounded-sm rotate-45 flex-shrink-0 ${activeTemplateId === t.id ? "bg-white" : "bg-blue-500"}`} />
                                                <span className="truncate">{t.name.split(" (")[0]}</span>
                                            </button>
                                            <button onClick={(e) => toggleBookmark(t.id, e)} className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 opacity-0 group-hover:opacity-100 transition-all hover:scale-125 ${bookmarkedIds.includes(t.id) ? "text-amber-500" : "text-slate-300 hover:text-amber-400"}`}>
                                                <svg className={`w-3.5 h-3.5 ${bookmarkedIds.includes(t.id) ? "fill-current" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        {myTemplates.length > 0 && (
                            <div>
                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 px-2 mb-2">My Library</p>
                                <div className="space-y-1">
                                    {myTemplates.map(t => (
                                        <div key={t.id} className="group relative">
                                            <button onClick={() => applyTemplate(t)} className={`w-full text-left pl-3 pr-12 py-2.5 rounded-xl text-[11px] font-bold transition-all flex items-center gap-2 ${activeTemplateId === t.id ? "bg-slate-900 dark:bg-slate-700 text-white" : "hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"}`}>
                                                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${activeTemplateId === t.id ? "bg-blue-400 animate-pulse" : "bg-slate-400"}`} />
                                                <span className="truncate">{t.name}</span>
                                            </button>
                                            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 transition-all">
                                                <button onClick={(e) => toggleBookmark(t.id, e)} className={`p-1.5 transition-all hover:scale-125 ${bookmarkedIds.includes(t.id) ? "text-amber-500" : "text-slate-300 hover:text-amber-400"}`}>
                                                    <svg className={`w-3 h-3 ${bookmarkedIds.includes(t.id) ? "fill-current" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.518 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.921-.755 1.688-1.54 1.118l-3.976-2.888a1 1 0 00-1.175 0l-3.976 2.888c-.784.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.49 10.101c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                                                </button>
                                                <button onClick={(e) => deleteTemplate(t.id, e)} className="p-1.5 hover:text-rose-500 transition-all text-slate-300">
                                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                    {/* Sidebar Footer: Save Tool */}
                    <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                        <div className="space-y-2">
                            <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 px-1">New Template</p>
                            <input value={templateName} onChange={e => setTemplateName(e.target.value)} onKeyDown={e => e.key === "Enter" && saveTemplate()} placeholder="Name..." className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[10px] font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all shadow-sm" />
                            <button onClick={saveTemplate} disabled={savingTemplate || !templateName.trim()} className="w-full py-2.5 rounded-xl bg-blue-600 text-white text-[9px] font-black uppercase tracking-[0.1em] hover:bg-blue-500 disabled:opacity-50 transition-all shadow-lg shadow-blue-500/10 flex items-center justify-center gap-2">
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" /></svg>
                                {savingTemplate ? "Saving..." : "Create Template"}
                            </button>
                        </div>
                    </div>
                </div>
            </aside>

            {/* ── COLUMN 2: Main Workspace ─────────────────────────────────────── */}
            <section className="lg:col-span-9 space-y-6 order-1 lg:order-2">

                {/* Header */}
                <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 p-6 flex items-center justify-between gap-4 shadow-sm">
                    <div>
                        <h2 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                            <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                            Document Comparison
                        </h2>
                        <p className="text-sm text-slate-500 mt-1 font-medium">Upload Documents and select fields to find exact semantic differences using AI.</p>
                    </div>
                    <div className="flex items-center gap-4">
                        {files.length === 2 && (
                            <button onClick={addFileSlot} className="px-4 py-2 border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 rounded-xl text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                                + Add 3rd Document
                            </button>
                        )}
                        <button 
                            onClick={runComparison} 
                            disabled={loading || validFilesCount < 2 || extractFields.length === 0}
                            className={`px-8 py-3 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-md flex items-center gap-3 ${(loading || validFilesCount < 2 || extractFields.length === 0) ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-500 hover:shadow-blue-500/20 hover:-translate-y-0.5'}`}
                        >
                            {loading ? (
                                <><div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> {processStep || "Scanning..."}</>
                            ) : 'Run Comparison'}
                        </button>
                        {result && (
                            <button 
                                onClick={() => setIsExpandedView(!isExpandedView)}
                                className="px-4 py-3 rounded-xl font-black text-xs uppercase tracking-widest border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all flex items-center gap-2"
                                title={isExpandedView ? "Collapse View" : "Expand Results"}
                            >
                                {isExpandedView ? (
                                    <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg> Close Expanded View</>
                                ) : (
                                    <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg> Expand Results</>
                                )}
                            </button>
                        )}
                    </div>
                </div>

                {error && (
                    <div className="p-4 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl space-x-2 text-sm font-bold flex items-center">
                        <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <span>{error}</span>
                    </div>
                )}

                {/* ─ Field Mapping Card ─ */}
                <div className={`${showExpandedWorkspace ? 'hidden' : 'bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm relative z-20'}`}>
                    <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                            <span className="text-[11px] font-black uppercase tracking-widest text-slate-500">Comparison Fields</span>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="text-[10px] font-bold text-slate-400">{extractFields.length} fields active</span>
                            {extractFields.length > 0 && (
                                <button onClick={() => setExtractFields([])} className="text-[10px] font-bold text-rose-500 hover:text-rose-600 bg-rose-50 dark:bg-rose-900/10 px-2 py-1 rounded-md transition-colors">
                                    Clear All
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="p-5 space-y-4">
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
                                <p className="text-xs text-slate-400 italic">No fields — add some below or pick a template from the sidebar.</p>
                            )}
                        </div>

                        <div className="flex gap-2">
                            <input value={newFieldName} onChange={e => setNewFieldName(e.target.value)} onKeyDown={e => e.key === "Enter" && addField()} placeholder="Field name..." className="flex-1 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all" />
                            <div className="relative">
                                <button onClick={() => setIsTypeDropdownOpen(!isTypeDropdownOpen)} className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition-all min-w-[110px] justify-between ${TYPE_COLORS[newFieldType]}`}>
                                    <div className="flex items-center gap-2"><span className="opacity-70">{TYPE_ICONS[newFieldType]}</span><span className="capitalize">{newFieldType}</span></div>
                                    <svg className={`w-3 h-3 opacity-50 transition-transform ${isTypeDropdownOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                </button>
                                {isTypeDropdownOpen && (
                                    <>
                                        <div className="fixed inset-0 z-[60]" onClick={() => setIsTypeDropdownOpen(false)} />
                                        <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl shadow-slate-900/10 z-[70] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                                            <div className="p-1.5 grid grid-cols-1 gap-0.5">
                                                {Object.keys(TYPE_COLORS).map((type) => (
                                                    <button key={type} onClick={() => { setNewFieldType(type as ExtractField["type"]); setIsTypeDropdownOpen(false); }} className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-xs font-bold transition-all ${newFieldType === type ? TYPE_COLORS[type].split(" ").map(c => c.replace("text-", "bg-").replace("bg-", "text-")).join(" ") : "text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50"}`}>
                                                        <span className={newFieldType === type ? "text-current" : TYPE_COLORS[type].split(" ").find(c => c.startsWith("text-"))}>{TYPE_ICONS[type]}</span><span className="capitalize">{type}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                            <button onClick={addField} className="px-4 py-2 rounded-xl bg-slate-900 dark:bg-blue-600 text-white hover:bg-blue-600 dark:hover:bg-blue-500 transition-all shadow-sm">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
                            </button>
                        </div>
                    </div>
                </div>

                {/* ── Documents & Results Split Grid ── */}
                <div className={showExpandedWorkspace ? "fixed inset-0 z-[100] bg-slate-100 dark:bg-slate-950 p-2 md:p-6 grid grid-cols-1 xl:grid-cols-12 gap-4 md:gap-6 w-screen h-screen overflow-hidden animate-in zoom-in-95 duration-300" : "grid grid-cols-1 xl:grid-cols-12 gap-6 w-full"}>
                    {/* Documents Grid */}
                    <div className={`col-span-1 ${result ? 'xl:col-span-8' : 'xl:col-span-12'} grid grid-cols-1 ${files.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-4 ${showExpandedWorkspace ? 'h-full overflow-hidden' : ''}`}>
                        {files.map((file, idx) => (
                            <div key={idx} className={`bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col ${showExpandedWorkspace ? 'h-full' : 'h-[70vh]'}`}>
                                <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/50">
                                    <span className="text-xs font-black uppercase text-slate-500 tracking-widest">Document #{idx + 1}</span>
                                    <div className="flex gap-2">
                                        <label className="text-[10px] font-bold text-blue-600 cursor-pointer hover:bg-blue-50 px-2 py-1 rounded-md transition-all">
                                            {file ? 'Replace' : 'Browse'}
                                            <input type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => handleFileInput(idx, e)} />
                                        </label>
                                        {idx > 1 && (
                                            <button onClick={() => removeFileSlot(idx)} className="text-[10px] font-bold text-rose-500 hover:bg-rose-50 px-2 py-1 rounded-md transition-all">Remove</button>
                                        )}
                                    </div>
                                </div>
                                <div className="flex-1 relative bg-slate-100 dark:bg-slate-900/50 flex p-4 overflow-auto custom-scrollbar group items-start justify-center">
                                    {!file ? (
                                        <label className="flex flex-col items-center justify-center cursor-pointer opacity-40 hover:opacity-100 transition-opacity p-10 h-full w-full">
                                            <div className="h-16 w-16 bg-white dark:bg-slate-800 rounded-full shadow-sm flex items-center justify-center mb-4 border border-dashed border-slate-300">
                                                <svg className="w-8 h-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
                                            </div>
                                            <span className="text-xs font-bold text-slate-500">Upload Image {idx + 1}</span>
                                            <input type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => handleFileInput(idx, e)} />
                                        </label>
                                    ) : (
                                        <DocumentPreviewWithHighlights
                                            file={files[idx]}
                                            url={previews[idx]}
                                            idx={idx}
                                            highlights={getHighlightsForDoc(idx)}
                                            selectedFieldKey={selectedFieldKey}
                                        />
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Results Panel */}
                    {result && (
                        <div className={`col-span-1 xl:col-span-4 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col ${showExpandedWorkspace ? 'h-full shadow-2xl' : 'h-[70vh]'}`}>
                            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex items-center justify-between">
                                <h3 className="text-sm font-black flex items-center gap-2 text-slate-800 dark:text-white">
                                    <div className="h-6 w-6 rounded-md bg-blue-100 flex items-center justify-center text-blue-600">
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                                    </div>
                                    {result.summary?.length > 0 && ` (${result.summary.length} จุดหลักที่พบ)`}
                                </h3>
                                {showExpandedWorkspace && (
                                    <button onClick={() => setIsExpandedView(false)} className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-white bg-rose-500 hover:bg-rose-600 transition-colors p-2 px-3 rounded-lg shadow-md" title="Close Expanded View">
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                        ปิดโหมดเต็มจอ
                                    </button>
                                )}
                            </div>
                            
                            <div className="flex-1 p-4 overflow-y-auto space-y-2 custom-scrollbar font-mono text-sm leading-relaxed">
                                {result.summary && result.summary.length > 0 && (
                                    <div className="mb-6 p-4 bg-blue-50/50 dark:bg-blue-900/10 rounded-xl border border-blue-100 dark:border-blue-800/50">
                                        <h4 className="font-bold text-blue-800 dark:text-blue-300 mb-2 flex items-center gap-2">
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                            สรุปภาพรวม
                                        </h4>
                                        <ul className="list-disc pl-5 space-y-1 text-slate-700 dark:text-slate-300 font-sans text-xs sm:text-sm">
                                            {result.summary.map((s, i) => <li key={i}>{s}</li>)}
                                        </ul>
                                    </div>
                                )}

                                {(!result.fields || result.fields.length === 0) ? (
                                    <div className="text-center py-10 opacity-50 font-sans">
                                        <svg className="w-10 h-10 mx-auto text-slate-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" /></svg>
                                        <p className="text-sm font-bold">Documents are identical!</p>
                                        <p className="text-xs">No differences found based on the provided fields.</p>
                                    </div>
                                ) : (
                                    result.fields.map((field, i) => (
                                        field.is_diff ? (
                                            <div key={i} 
                                                 onClick={() => setSelectedFieldKey(selectedFieldKey === field.key ? null : field.key)}
                                                 className={`flex flex-col gap-1.5 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border shadow-sm transition-all cursor-pointer hover:-translate-y-0.5 mt-4 mb-4 ${selectedFieldKey === field.key ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50/30 dark:bg-blue-900/10' : 'border-slate-200 dark:border-slate-700 hover:border-blue-300'}`}>
                                                <div className="text-xs font-black uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-1 border-b border-slate-200 dark:border-slate-700 pb-2 flex justify-between items-center">
                                                    <span>{field.key}</span>
                                                    {selectedFieldKey === field.key && <span className="text-[9px] bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full">Viewing Highlights</span>}
                                                </div>
                                                <div className="flex items-start gap-3 mt-1">
                                                        <span className="shrink-0 w-12 text-[10px] font-black tracking-wider uppercase text-rose-500 bg-rose-100 dark:bg-rose-900/50 px-2 py-1 rounded text-center">Doc 1</span>
                                                        <span className="text-rose-700 dark:text-rose-300 break-words pt-0.5 whitespace-pre-line">{field.doc1 || <em className="opacity-40 line-through">(ไม่มีข้อมูล)</em>}</span>
                                                </div>
                                                <div className="flex items-start gap-3 mt-1 border-t border-slate-100 dark:border-slate-700/50 pt-2">
                                                        <span className="shrink-0 w-12 text-[10px] font-black tracking-wider uppercase text-emerald-600 bg-emerald-100 dark:bg-emerald-900/50 px-2 py-1 rounded text-center">Doc 2</span>
                                                        <span className="text-emerald-700 dark:text-emerald-300 break-words font-medium pt-0.5 whitespace-pre-line">{field.doc2 || <em className="opacity-40 line-through">(ไม่มีข้อมูล)</em>}</span>
                                                </div>
                                                {files.length === 3 && (
                                                    <div className="flex items-start gap-3 mt-1 pt-2 border-t border-slate-100 dark:border-slate-700/50">
                                                            <span className="shrink-0 w-12 text-[10px] font-black tracking-wider uppercase text-amber-600 bg-amber-100 dark:bg-amber-900/50 px-2 py-1 rounded text-center">Doc 3</span>
                                                            <span className="text-amber-700 dark:text-amber-300 break-words pt-0.5 whitespace-pre-line">{field.doc3 || <em className="opacity-40 line-through">(ไม่มีข้อมูล)</em>}</span>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <div key={i} 
                                                 onClick={() => setSelectedFieldKey(selectedFieldKey === field.key ? null : field.key)}
                                                 className={`px-3 py-2 flex items-start justify-between gap-4 text-slate-500 dark:text-slate-400 opacity-70 hover:opacity-100 transition-all cursor-pointer rounded-xl mb-1 border ${selectedFieldKey === field.key ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20 shadow-sm opacity-100' : 'border-transparent bg-slate-50/50 dark:bg-slate-800/20 hover:border-slate-300 dark:hover:border-slate-600'}`}>
                                                    <span className="font-bold text-xs shrink-0 pt-0.5 flex items-center gap-2">
                                                        {field.key}
                                                        {selectedFieldKey === field.key && <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />}
                                                    </span>
                                                    <span className="text-xs truncate break-all max-w-[60%] text-right">{field.doc1}</span>
                                            </div>
                                        )
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
