"use client";
import React, { useState, useRef, useEffect } from "react";
import { User } from "@/lib/types";

interface Props {
    user: User | null;
}

interface CompareLine {
    is_diff: boolean;
    text?: string;
    doc1?: string | null;
    doc2?: string | null;
    doc3?: string | null;
}

interface CompareResult {
    summary: string[];
    lines: CompareLine[];
}

export default function CompareWorkspace({ user }: Props) {
    // ── Local State ──
    const [files, setFiles] = useState<(File | null)[]>([null, null]);
    const [previews, setPreviews] = useState<(string | null)[]>([null, null]);
    const [targetModelId, setTargetModelId] = useState<string>("");
    const [aiModels, setAiModels] = useState<any[]>([]);

    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<CompareResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Fetch AI Models on mount
    useEffect(() => {
        fetch("/api/admin/settings")
            .then(r => r.json())
            .then((data: any) => {
                if (data.configs && data.configs.length > 0) {
                    setAiModels(data.configs);
                    // attempt to default to a 'pro' model if available
                    const pro = data.configs.find((c: any) => c.model.includes('pro'));
                    setTargetModelId(pro ? pro.id : data.configs[0].id);
                }
            })
            .catch(console.error);
    }, []);

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
        }
    };

    const addFileSlot = () => {
        if (files.length < 3) {
            setFiles([...files, null]);
            setPreviews([...previews, null]);
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
    };

    const runComparison = async () => {
        const validFiles = files.filter(f => f !== null) as File[];
        if (validFiles.length < 2) return;

        setLoading(true);
        setError(null);
        setResult(null);

        const formData = new FormData();
        if (user) formData.append("userId", user.id);
        if (targetModelId) formData.append("selectedModelId", targetModelId);
        validFiles.forEach((file, idx) => {
            formData.append(`file${idx + 1}`, file);
        });

        try {
            const res = await fetch("/api/compare", { method: "POST", body: formData });
            const data = await res.json() as any;

            if (!res.ok || !data.success) {
                throw new Error(data.error || "Comparison failed");
            }
            if (data.extracted_data && Array.isArray(data.extracted_data.lines)) {
                setResult(data.extracted_data);
            } else {
                setResult({ summary: [], lines: [] }); // no diffs found
            }
        } catch (err: any) {
            setError(err.message || "An error occurred during comparison.");
        } finally {
            setLoading(false);
        }
    };

    // renderBox removed as we do text diffing now

    const validFilesCount = files.filter(f => f !== null).length;

    return (
        <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
            {/* Header Area */}
            <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 p-6 flex flex-col md:flex-row items-center justify-between gap-4 shadow-sm">
                 <div>
                    <h2 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                        <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                        Document Comparison
                    </h2>
                    <p className="text-sm text-slate-500 mt-1 font-medium">Upload Documents (Image or PDF) to find differences line-by-line automatically using AI.</p>
                </div>
                
                <div className="flex items-center gap-4">
                    {files.length === 2 && (
                        <button onClick={addFileSlot} className="px-4 py-2 border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 rounded-xl text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                            + Add 3rd Document
                        </button>
                    )}
                    <button 
                        onClick={runComparison} 
                        disabled={loading || validFilesCount < 2}
                        className={`px-8 py-3 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-md flex items-center gap-3 ${loading || validFilesCount < 2 ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-500 hover:shadow-blue-500/20 hover:-translate-y-0.5'}`}
                    >
                        {loading ? (
                            <><div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> Scanning...</>
                        ) : 'Run AI Compare'}
                    </button>
                </div>
            </div>

            {error && (
                <div className="p-4 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl space-x-2 text-sm font-bold flex items-center">
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span>{error}</span>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                {/* ── Documents Grid ── */}
                <div className={`col-span-1 ${result ? 'xl:col-span-9 lg:col-span-8' : 'lg:col-span-12'} grid grid-cols-1 ${files.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-4`}>
                    {files.map((file, idx) => (
                        <div key={idx} className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col h-[82vh]">
                            {/* Header */}
                            <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/50">
                                <span className="text-xs font-black uppercase text-slate-500 tracking-widest">Document #{idx + 1}</span>
                                <div className="flex gap-2">
                                    <label className="text-[10px] font-bold text-blue-600 cursor-pointer hover:bg-blue-50 px-2 py-1 rounded-md transition-all">
                                        {file ? 'Replace' : 'Browse'}
                                        <input type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => handleFileInput(idx, e)} />
                                    </label>
                                    {idx > 1 && (
                                        <button onClick={() => removeFileSlot(idx)} className="text-[10px] font-bold text-rose-500 hover:bg-rose-50 px-2 py-1 rounded-md transition-all">
                                            Remove
                                        </button>
                                    )}
                                </div>
                            </div>
                            
                            {/* Preview Area */}
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
                                    <div className="relative shadow-sm mx-auto w-full h-full min-h-[50vh]">
                                        {files[idx]?.type === 'application/pdf' ? (
                                             <iframe src={`${previews[idx]}#toolbar=0&navpanes=0`} className="w-full h-full min-h-[60vh] rounded-sm border border-slate-200 dark:border-slate-800" />
                                        ) : (
                                             <img src={previews[idx] as string} alt={`Doc ${idx+1}`} className="w-full h-auto pointer-events-none rounded-sm border border-slate-200 dark:border-slate-800" />
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                {/* ── Results Panel ── */}
                {result && (
                    <div className="col-span-1 xl:col-span-3 lg:col-span-4 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col h-[82vh]">
                        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                            <h3 className="text-sm font-black flex items-center gap-2 text-slate-800 dark:text-white">
                                <div className="h-6 w-6 rounded-md bg-blue-100 flex items-center justify-center text-blue-600">
                                   <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                                </div>
                                {result.summary?.length > 0 && ` (${result.summary.length} จุดหลักที่พบ)`}
                            </h3>
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

                           {(!result.lines || result.lines.length === 0) ? (
                               <div className="text-center py-10 opacity-50 font-sans">
                                   <svg className="w-10 h-10 mx-auto text-slate-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" /></svg>
                                   <p className="text-sm font-bold">Documents are identical!</p>
                                   <p className="text-xs">No differences found.</p>
                               </div>
                           ) : (
                               result.lines.map((line, i) => (
                                   line.is_diff ? (
                                       <div key={i} className="flex flex-col gap-1.5 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 shadow-sm transition-all hover:border-blue-300 mt-4 mb-4">
                                           <div className="flex items-start gap-3">
                                                <span className="shrink-0 w-12 text-[10px] font-black tracking-wider uppercase text-rose-500 bg-rose-100 dark:bg-rose-900/50 px-2 py-1 rounded text-center">Doc 1</span>
                                                <span className="text-rose-700 dark:text-rose-300 break-words pt-0.5">{line.doc1 || <em className="opacity-40 line-through">(ไม่มีข้อมูล)</em>}</span>
                                           </div>
                                           <div className="flex items-start gap-3">
                                                <span className="shrink-0 w-12 text-[10px] font-black tracking-wider uppercase text-emerald-600 bg-emerald-100 dark:bg-emerald-900/50 px-2 py-1 rounded text-center">Doc 2</span>
                                                <span className="text-emerald-700 dark:text-emerald-300 break-words font-medium pt-0.5">{line.doc2 || <em className="opacity-40 line-through">(ไม่มีข้อมูล)</em>}</span>
                                           </div>
                                           {files.length === 3 && (
                                               <div className="flex items-start gap-3 mt-1 pt-1 border-t border-slate-200 dark:border-slate-700">
                                                    <span className="shrink-0 w-12 text-[10px] font-black tracking-wider uppercase text-amber-600 bg-amber-100 dark:bg-amber-900/50 px-2 py-1 rounded text-center">Doc 3</span>
                                                    <span className="text-amber-700 dark:text-amber-300 break-words pt-0.5">{line.doc3 || <em className="opacity-40 line-through">(ไม่มีข้อมูล)</em>}</span>
                                               </div>
                                           )}
                                       </div>
                                   ) : (
                                       <div key={i} className="px-2 py-0.5 text-slate-500 dark:text-slate-400 opacity-60 hover:opacity-100 transition-opacity">
                                            {line.text}
                                       </div>
                                   )
                               ))
                           )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
