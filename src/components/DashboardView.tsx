"use client";
import React, { useState } from "react";
import { UsageStats } from "@/lib/types";
import { exportOCRResult, exportTableRows } from "@/lib/exportUtils";

interface DashboardViewProps {
    usageStats: UsageStats;
    userName?: string;
    userPlan?: string;
}


const renderExtractedData = (data: any, docName: string = "export") => {
    if (!data || typeof data !== 'object') return <p className="text-sm text-slate-500">No data available</p>;

    const scalars: { key: string; value: string; conf: number | null }[] = [];
    const tables: { key: string; rows: any[]; conf: number | null }[] = [];

    Object.entries(data).forEach(([key, item]: [string, any]) => {
        const value = "-";
        const conf = null;

        if (item && typeof item === 'object') {
            if (Array.isArray(item)) {
                if (item.length > 0 && typeof item[0] === 'object') {
                    tables.push({ key, rows: item, conf: null });
                } else {
                    scalars.push({ key, value: `[Array: ${item.length} items]`, conf: null });
                }
            } else if ('value' in item) {
                if (Array.isArray(item.value)) {
                    if (item.value.length > 0 && typeof item.value[0] === 'object') {
                        tables.push({ key, rows: item.value, conf: item.confidence });
                    } else {
                        scalars.push({ key, value: `[Array: ${item.value.length} items]`, conf: item.confidence });
                    }
                } else if (item.value !== null && typeof item.value === 'object') {
                    scalars.push({ key, value: `[Complex Object]`, conf: item.confidence });
                } else {
                    scalars.push({ key, value: item.value === null || item.value === undefined ? "-" : String(item.value), conf: item.confidence });
                }
            } else {
                scalars.push({ key, value: JSON.stringify(item), conf: null });
            }
        } else if (item !== null && item !== undefined) {
            scalars.push({ key, value: String(item), conf: null });
        }
    });

    return (
        <div className="space-y-6 mt-2">
            {scalars.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {scalars.map(({ key, value, conf }) => (
                        <div key={key} className="flex flex-col bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
                            <span className="text-[10px] uppercase font-black tracking-wider text-slate-400 mb-1.5 truncate">{key.replace(/_/g, ' ')}</span>
                            <div className="flex items-start justify-between gap-2">
                                <span className="text-sm font-bold text-slate-700 dark:text-slate-200 break-words">{value !== "-" ? value : <span className="text-slate-300 dark:text-slate-600 italic">Not found</span>}</span>
                                {conf !== null && conf !== undefined && (
                                    <span className={`flex-shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded-md ${conf >= 80 ? "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30" :
                                        conf >= 60 ? "text-amber-600 bg-amber-50 dark:bg-amber-900/30" :
                                            "text-rose-600 bg-rose-50 dark:bg-rose-900/30"
                                        }`}>{conf}%</span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {tables.length > 0 && tables.map(({ key, rows, conf }) => {
                const headKeys = rows.length > 0 ? Object.keys(rows[0]) : [];
                return (
                    <div key={key} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
                        <div className="bg-slate-50 dark:bg-slate-800/50 px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                                <h5 className="text-[11px] font-black uppercase tracking-wider text-slate-700 dark:text-slate-200 flex items-center gap-2">
                                    <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                    {key.replace(/_/g, ' ')}
                                </h5>
                                {conf !== null && conf !== undefined && (
                                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-md ${conf >= 80 ? "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30" :
                                        conf >= 60 ? "text-amber-600 bg-amber-50 dark:bg-amber-900/30" :
                                            "text-rose-600 bg-rose-50 dark:bg-rose-900/30"
                                        }`}>{conf}%</span>
                                )}
                                <span className="text-[10px] font-bold text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">{rows.length} rows</span>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => exportTableRows(rows, `${docName}_${key}`, "excel")} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 hover:bg-emerald-100 transition-colors rounded-lg text-[10px] font-black uppercase tracking-wider">
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                    Excel
                                </button>
                                <button onClick={() => exportTableRows(rows, `${docName}_${key}`, "csv")} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 hover:bg-blue-100 transition-colors rounded-lg text-[10px] font-black uppercase tracking-wider">
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                    CSV
                                </button>
                            </div>
                        </div>
                        <div className="overflow-x-auto max-h-64 overflow-y-auto custom-scrollbar">
                            <table className="w-full text-left text-[11px] whitespace-nowrap">
                                <thead className="text-[9px] uppercase font-black text-slate-400 bg-slate-50/50 dark:bg-slate-800/30 sticky top-0 backdrop-blur-sm z-10">
                                    <tr>
                                        {headKeys.map(hk => (
                                            <th key={hk} className="px-4 py-2 opacity-80">{hk}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                    {rows.map((r, rIdx) => (
                                        <tr key={rIdx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                            {headKeys.map(hk => (
                                                <td key={hk} className="px-4 py-2 text-slate-600 dark:text-slate-300">
                                                    {r[hk] !== null && r[hk] !== undefined ? String(r[hk]) : "-"}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default function DashboardView({ usageStats, userName = "User", userPlan = "Free" }: DashboardViewProps) {
    const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
    const [chartTimeframe, setChartTimeframe] = useState<"weekly" | "monthly" | "yearly">("weekly");

    const usedPct = usageStats.limit > 0 ? Math.round((usageStats.totalDocs / usageStats.limit) * 100) : 0;
    const creditPct = usageStats.limit > 0 ? Math.round((usageStats.creditsRemaining / usageStats.limit) * 100) : 100;

    let displayData = usageStats.weeklyData || [0, 0, 0, 0, 0, 0, 0];
    let displayLabels = usageStats.weekLabels || ["", "", "", "", "", "", ""];
    let chartTitle = "Weekly Volume";

    if (chartTimeframe === "monthly") {
        displayData = usageStats.monthlyData || [0, 0, 0, 0, 0, 0];
        displayLabels = usageStats.monthLabels || ["", "", "", "", "", ""];
        chartTitle = "Monthly Volume";
    } else if (chartTimeframe === "yearly") {
        displayData = usageStats.yearlyData || [0, 0, 0, 0, 0];
        displayLabels = usageStats.yearLabels || ["", "", "", "", ""];
        chartTitle = "Yearly Volume";
    }

    const maxVal = Math.max(...displayData, 1); // fallback to 1 to avoid div by zero
    const recentActivity = usageStats.recentActivity || [];

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">

            {/* Welcome Banner */}
            <div className="relative overflow-hidden bg-slate-900 rounded-[2.5rem] p-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                <div className="absolute inset-0 bg-gradient-to-br from-blue-600/20 via-transparent to-purple-600/10 pointer-events-none" />
                <div className="absolute -top-16 -right-16 h-64 w-64 bg-blue-500/10 rounded-full blur-3xl" />
                <div className="relative space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-400">Good evening</p>
                    <h2 className="text-3xl font-black text-white tracking-tight">Welcome back, {userName} 👋</h2>
                    <p className="text-slate-400 text-sm max-w-md">
                        You've processed <span className="text-white font-bold">{usageStats.totalDocs} documents</span> this month.
                        {creditPct > 20
                            ? " Your plan is running smoothly."
                            : " Your credits are running low — consider upgrading."}
                    </p>
                </div>
                <div className="relative flex items-center gap-4">
                    <div className="text-right">
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest font-black">Plan</p>
                        <p className="text-white font-black text-lg">{userPlan}</p>
                    </div>
                    <div className="h-14 w-14 rounded-2xl bg-blue-600 flex items-center justify-center shadow-xl shadow-blue-500/30">
                        <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3l14 9-14 9V3z" /></svg>
                    </div>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
                {[
                    {
                        label: "Docs Processed", value: usageStats.totalDocs, sub: "+12% vs last month",
                        color: "blue", icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />,
                    },
                    {
                        label: "Credits Remaining",
                        value: usageStats.limit >= 999999 ? "Unlimited" : usageStats.creditsRemaining,
                        sub: usageStats.limit >= 999999 ? "No limit applied" : `${creditPct}% of ${usageStats.limit} limit`,
                        color: "emerald", icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />,
                    },
                    {
                        label: "Avg. Confidence", value: `${usageStats.avgConfidence || 89}%`, sub: "Quality score across all docs",
                        color: "violet", icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />,
                    },
                    {
                        label: "Avg. Speed", value: usageStats.avgSpeedMs ? `${(usageStats.avgSpeedMs / 1000).toFixed(1)}s` : "-", sub: "Per document extraction",
                        color: "amber", icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
                    },
                ].map((kpi) => (
                    <div key={kpi.label} className="bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-200 dark:border-slate-800 p-6 shadow-sm hover:shadow-md transition-all group">
                        <div className={`inline-flex p-3 rounded-xl mb-4 bg-${kpi.color}-50 dark:bg-${kpi.color}-900/20 text-${kpi.color}-600`}>
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">{kpi.icon}</svg>
                        </div>
                        <p className="text-2xl md:text-3xl font-black tracking-tight dark:text-white">{kpi.value}</p>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-1">{kpi.label}</p>
                        <p className="text-[11px] text-slate-500 mt-2">{kpi.sub}</p>
                    </div>
                ))}
            </div>

            {/* Middle Row: Chart + API Health */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Volume Chart */}
                <div className="lg:col-span-3 bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 p-8 shadow-sm">
                    <div className="flex items-center justify-between mb-8">
                        <div>
                            <h3 className="font-black text-lg dark:text-white">{chartTitle}</h3>
                            <p className="text-xs text-slate-400 mt-0.5">Documents extracted</p>
                        </div>
                        <div className="flex items-center bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                            <button
                                onClick={() => setChartTimeframe("weekly")}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${chartTimeframe === "weekly" ? "bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}
                            >Weekly</button>
                            <button
                                onClick={() => setChartTimeframe("monthly")}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${chartTimeframe === "monthly" ? "bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}
                            >Monthly</button>
                            <button
                                onClick={() => setChartTimeframe("yearly")}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${chartTimeframe === "yearly" ? "bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}
                            >Yearly</button>
                        </div>
                    </div>
                    <div className="flex items-end justify-between gap-2 h-36">
                        {displayData.map((val, i) => (
                            <div key={i} className="flex-1 flex flex-col items-center gap-2">
                                <span className="text-[10px] font-bold text-slate-400">{val}</span>
                                <div className="w-full rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800" style={{ height: "80px" }}>
                                    <div
                                        className="w-full bg-blue-600 rounded-lg transition-all duration-700 hover:bg-blue-500"
                                        style={{ height: `${(val / maxVal) * 100}%`, marginTop: `${100 - (val / maxVal) * 100}%` }}
                                    />
                                </div>
                                <span className="text-[9px] font-black uppercase text-slate-400">{displayLabels[i]}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Bottom Row: Activity Feed + Plan Usage */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Recent Activity */}
                <div className="lg:col-span-2 bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
                    <div className="flex items-center justify-between px-8 py-6 border-b border-slate-100 dark:border-slate-800">
                        <h3 className="font-black text-base dark:text-white">Recent Activity</h3>
                        <button className="text-xs font-bold text-blue-600 hover:underline">View All →</button>
                    </div>
                    <div className="divide-y divide-slate-50 dark:divide-slate-800">
                        {recentActivity.length > 0 ? recentActivity.map((doc: any) => (
                            <div key={doc.id} className="flex flex-col border-b border-slate-50 dark:border-slate-800 last:border-0 group">
                                <div
                                    className="flex items-center justify-between px-8 py-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-all"
                                    onClick={() => setExpandedDocId(expandedDocId === doc.id ? null : doc.id)}
                                >
                                    <div className="flex items-center gap-4 min-w-0">
                                        <div className={`flex-shrink-0 h-10 w-10 rounded-xl flex items-center justify-center ${doc.status === "error" ? "bg-rose-50 dark:bg-rose-900/20 text-rose-500" : "bg-blue-50 dark:bg-blue-900/20 text-blue-600"}`}>
                                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-sm font-bold truncate dark:text-white">{doc.name}</p>
                                            <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider">{doc.template} · {new Date(doc.time).toLocaleString()}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                                        {doc.status === "error" ? (
                                            <span className="text-[9px] font-black uppercase px-2.5 py-1 rounded-full bg-rose-50 dark:bg-rose-900/20 text-rose-500">Error</span>
                                        ) : doc.status === "pending" || doc.status === "processing" ? (
                                            <span className="text-[9px] font-black uppercase px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-600">Processing</span>
                                        ) : (
                                            <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full ${doc.confidence >= 80 ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600"
                                                : doc.confidence >= 60 ? "bg-amber-50 dark:bg-amber-900/20 text-amber-600"
                                                    : "bg-rose-50 dark:bg-rose-900/20 text-rose-500"
                                                }`}>{doc.confidence}%</span>
                                        )}
                                        <svg className={`w-4 h-4 text-slate-400 transition-transform ${expandedDocId === doc.id ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                        </svg>
                                    </div>
                                </div>
                                {expandedDocId === doc.id && doc.data_extracted && (
                                    <div className="px-8 pb-4 animate-in slide-in-from-top-2 duration-300">
                                        <div className="bg-slate-50 dark:bg-slate-950/50 rounded-2xl p-5 border border-slate-100 dark:border-slate-800">
                                            <div className="flex items-center justify-between mb-4">
                                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                                                    <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                                    Extracted Data Breakdown
                                                </h4>
                                                <div className="flex gap-2">
                                                    <button onClick={(e) => { e.stopPropagation(); exportOCRResult(doc.data_extracted, doc.name ? doc.name.replace(/\.[^/.]+$/, "") : "document", "excel"); }} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 hover:bg-emerald-100 transition-colors rounded-lg text-[10px] font-black uppercase tracking-wider">
                                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                                        Export All (Excel)
                                                    </button>
                                                    <button onClick={(e) => { e.stopPropagation(); exportOCRResult(doc.data_extracted, doc.name ? doc.name.replace(/\.[^/.]+$/, "") : "document", "csv"); }} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 hover:bg-blue-100 transition-colors rounded-lg text-[10px] font-black uppercase tracking-wider">
                                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                                        Export All (CSV)
                                                    </button>
                                                </div>
                                            </div>
                                            {renderExtractedData(doc.data_extracted, doc.name ? doc.name.replace(/\.[^/.]+$/, "") : "document")}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )) : (
                            <div className="px-8 py-10 text-center">
                                <p className="text-slate-400 font-bold text-sm">No recent documents</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Plan Usage + Quick Actions */}
                <div className="space-y-5">
                    {/* Plan Usage */}
                    <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 p-8 shadow-sm">
                        <h3 className="font-black text-base dark:text-white mb-6">Plan Usage</h3>
                        <div className="space-y-5">
                            <div>
                                <div className="flex justify-between text-[11px] font-bold mb-2">
                                    <span className="text-slate-500">Documents</span>
                                    <span className="dark:text-white">{usageStats.totalDocs} / {usageStats.limit >= 999999 ? "Unlimited" : usageStats.limit}</span>
                                </div>
                                <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full transition-all duration-700 ${usedPct > 80 ? "bg-rose-500" : "bg-blue-500"}`} style={{ width: `${usedPct}%` }} />
                                </div>
                            </div>

                        </div>
                        <div className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800">
                            <p className="text-[10px] text-slate-400 mb-3 font-black uppercase tracking-widest">Renews on Mar 31, 2026</p>
                            <button className="w-full py-3 rounded-xl bg-blue-600 text-white text-[10px] font-black uppercase tracking-[0.15em] hover:bg-blue-500 transition-all shadow-md shadow-blue-500/10">
                                Upgrade Plan
                            </button>
                        </div>
                    </div>


                </div>
            </div>

        </div>
    );
}
