import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { fetchJson } from "@/lib/fetchJson";
import { apiError } from "@/lib/friendlyError";
import { ErrorCode } from "@/lib/errorCodes";

// ─── Types mirroring /api/admin/ai-usage ──────────────────────────────────
interface FnSummary {
    fn: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    avgInput: number;
    avgOutput: number;
    avgCost: number;
}
interface ByModelRow {
    fn: string; provider: string; model: string;
    calls: number; inputTokens: number; outputTokens: number;
    cost: number; rated: boolean;
}
interface DailyRow {
    day: string; fn: string; calls: number;
    inputTokens: number; outputTokens: number; cost: number;
}
interface RawRow {
    id: string; created_at: string; fn: string; provider: string; model: string;
    input_tokens: number; output_tokens: number; doc_id: string | null;
    file_name: string | null; user_email: string | null;
}
interface ModelRow { provider: string; model: string; input: number; output: number }
interface UserReportRow {
    userId: string | null; email: string | null; name: string | null;
    ocrCalls: number; compareCalls: number; apiCalls: number; totalCalls: number;
    inputTokens: number; outputTokens: number; cost: number;
}
interface UsageData {
    summary: FnSummary[];
    byModel: ByModelRow[];
    daily: DailyRow[];
    raw: RawRow[];
    models: ModelRow[];
    report: { month: string; users: UserReportRow[] };
    availableMonths: string[];
}

const FN_LABEL: Record<string, string> = {
    ocr: "OCR", compare: "Compare", api_extract: "Public API",
};
// Full static class strings — Tailwind cannot see dynamically-built names.
interface FnStyle { card: string; label: string }
const FN_STYLES: Record<string, FnStyle> = {
    ocr: {
        card: "bg-blue-50/50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800",
        label: "text-blue-600 dark:text-blue-400",
    },
    compare: {
        card: "bg-amber-50/50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800",
        label: "text-amber-600 dark:text-amber-400",
    },
    api_extract: {
        card: "bg-violet-50/50 dark:bg-violet-900/10 border-violet-200 dark:border-violet-800",
        label: "text-violet-600 dark:text-violet-400",
    },
};
const FN_STYLE_DEFAULT: FnStyle = {
    card: "bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700",
    label: "text-slate-600 dark:text-slate-300",
};

const nf = (n: number) => (n || 0).toLocaleString("en-US");

export default function AdminAIUsageView({ userId }: { userId: string }) {
    const { t } = useTranslation();
    const [data, setData] = useState<UsageData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [rateDraft, setRateDraft] = useState<Record<string, { input: string; output: string }>>({});
    const [usdThb, setUsdThb] = useState<number>(35);
    const [fxDraft, setFxDraft] = useState<string>("35");
    const [saving, setSaving] = useState(false);
    const [savedMsg, setSavedMsg] = useState<string | null>(null);
    const [month, setMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));

    // Provider rates are in USD; display every cost converted to Baht.
    const thb = (usdAmount: number) =>
        "฿" + ((usdAmount || 0) * usdThb).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/admin/ai-usage?userId=${userId}&month=${month}`);
            const json = await res.json() as any;
            if (!json.success) throw new Error(json.error || "Failed to load");
            const d: UsageData = {
                summary: json.summary || [], byModel: json.byModel || [],
                daily: json.daily || [], raw: json.raw || [], models: json.models || [],
                report: json.report || { month, users: [] },
                availableMonths: json.availableMonths || [],
            };
            setData(d);
            const draft: Record<string, { input: string; output: string }> = {};
            for (const m of d.models) draft[m.model] = { input: String(m.input), output: String(m.output) };
            setRateDraft(draft);
            const fx = Number(json.usdThb) || 35;
            setUsdThb(fx);
            setFxDraft(String(fx));
        } catch (err: any) {
            setError(apiError(err?.code || ErrorCode.GENERIC, err?.vars, t));
        } finally {
            setLoading(false);
        }
    }, [userId, month]);

    useEffect(() => { fetchData(); }, [fetchData]);

    const saveRates = async () => {
        setSaving(true);
        setSavedMsg(null);
        try {
            const rates: Record<string, { input: number; output: number }> = {};
            for (const [model, r] of Object.entries(rateDraft)) {
                rates[model] = { input: Number(r.input) || 0, output: Number(r.output) || 0 };
            }
            const res = await fetch(`/api/admin/ai-usage?userId=${userId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rates, usdThb: Number(fxDraft) || 35 }),
            });
            const json = await res.json() as any;
            if (!json.success) throw new Error(json.error || "Save failed");
            setSavedMsg(t("admin.aiSaved"));
            await fetchData();
            setSavedMsg(t("admin.aiSavedDone"));
        } catch (err: any) {
            setError(apiError(err?.code || ErrorCode.GENERIC, err?.vars, t));
        } finally {
            setSaving(false);
        }
    };

    // Export the monthly per-user report as a CSV (UTF-8 BOM for Excel/Thai).
    const downloadCsv = () => {
        const users = data?.report.users || [];
        const esc = (v: any) => {
            const s = String(v ?? "");
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const header = ["Email", "Name", "OCR Calls", "Compare Calls", "API Calls",
            "Total Calls", "Input Tokens", "Output Tokens", "Cost (THB)"];
        const lines = [header.join(",")];
        for (const u of users) {
            lines.push([
                esc(u.email || ""), esc(u.name || ""),
                u.ocrCalls, u.compareCalls, u.apiCalls, u.totalCalls,
                u.inputTokens, u.outputTokens, (u.cost * usdThb).toFixed(2),
            ].join(","));
        }
        const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `ai-usage-report-${data?.report.month || month}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    };

    const totals = (data?.summary || []).reduce(
        (a, s) => ({
            calls: a.calls + s.calls,
            inputTokens: a.inputTokens + s.inputTokens,
            outputTokens: a.outputTokens + s.outputTokens,
            cost: a.cost + s.cost,
        }),
        { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
    );

    const fmtTime = (ts: string) => new Intl.DateTimeFormat("en-GB", {
        month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(new Date(ts.includes("Z") ? ts : ts.replace(" ", "T") + "Z"));

    return (
        <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-6 md:p-8 space-y-8">
                {/* Header */}
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                            <div className="p-2.5 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
                                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                            </div>
                            AI Token Usage & Cost
                        </h2>
                        <p className="text-sm text-slate-500 mt-2 font-medium">{t("admin.aiSubtitle")}</p>
                    </div>
                    <button
                        onClick={fetchData}
                        disabled={loading}
                        className="px-5 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 transition flex items-center gap-2 text-sm font-bold disabled:opacity-50"
                    >
                        <svg className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        Refresh
                    </button>
                </div>

                {error && (
                    <div className="p-4 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl text-sm font-bold">{error}</div>
                )}

                {/* Grand totals */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                        { label: t("admin.aiTotalCalls"), val: nf(totals.calls) },
                        { label: "Input Tokens", val: nf(totals.inputTokens) },
                        { label: "Output Tokens", val: nf(totals.outputTokens) },
                        { label: t("admin.aiTotalCost"), val: thb(totals.cost), accent: true },
                    ].map((c) => (
                        <div key={c.label} className={`p-5 rounded-2xl border ${c.accent ? "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800" : "bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700"}`}>
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{c.label}</p>
                            <p className={`text-2xl font-black mt-1 ${c.accent ? "text-emerald-600 dark:text-emerald-400" : "text-slate-800 dark:text-white"}`}>{c.val}</p>
                        </div>
                    ))}
                </div>

                {/* Per-function summary */}
                <div>
                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-400 mb-3">{t("admin.aiPerFunction")}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {(data?.summary || []).length === 0 && !loading && (
                            <div className="col-span-3 text-center text-slate-400 py-8 text-sm">{t("admin.aiNoTokens")}</div>
                        )}
                        {(data?.summary || []).map((s) => {
                            const st = FN_STYLES[s.fn] || FN_STYLE_DEFAULT;
                            return (
                                <div key={s.fn} className={`p-5 rounded-2xl border ${st.card}`}>
                                    <div className="flex items-center justify-between">
                                        <span className={`text-sm font-black ${st.label}`}>{FN_LABEL[s.fn] || s.fn}</span>
                                        <span className="text-[10px] font-bold text-slate-400">{nf(s.calls)} calls</span>
                                    </div>
                                    <div className="mt-3 space-y-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                                        <Row k="Input tokens" v={nf(s.inputTokens)} />
                                        <Row k="Output tokens" v={nf(s.outputTokens)} />
                                        <Row k={t("admin.aiAvgInput")} v={nf(s.avgInput)} />
                                        <Row k={t("admin.aiAvgOutput")} v={nf(s.avgOutput)} />
                                        <div className="border-t border-slate-200 dark:border-slate-700 my-1.5" />
                                        <Row k={t("admin.aiCostTotal")} v={thb(s.cost)} strong />
                                        <Row k={t("admin.aiCostAvg")} v={thb(s.avgCost)} strong />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Monthly per-user report */}
                <div>
                    <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 mb-3">
                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-400">{t("admin.aiMonthlyReport")}</h3>
                        <div className="flex items-center gap-2">
                            <select
                                value={month}
                                onChange={(e) => setMonth(e.target.value)}
                                className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold"
                            >
                                {!(data?.availableMonths || []).includes(month) && <option value={month}>{month}</option>}
                                {(data?.availableMonths || []).map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                            <button
                                onClick={downloadCsv}
                                disabled={!(data?.report.users || []).length}
                                className="px-4 py-2 bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 rounded-xl hover:opacity-90 transition text-xs font-bold disabled:opacity-40 flex items-center gap-2"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                {t("admin.aiDownloadCsv")}
                            </button>
                        </div>
                    </div>
                    <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-x-auto max-h-96 overflow-y-auto custom-scrollbar">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead className="bg-slate-50/50 dark:bg-slate-900/50 text-slate-400 font-bold uppercase tracking-wider text-[10px] sticky top-0">
                                <tr>
                                    <th className="px-4 py-3">{t("admin.aiColUser")}</th>
                                    <th className="px-4 py-3 text-right">OCR</th>
                                    <th className="px-4 py-3 text-right">Compare</th>
                                    <th className="px-4 py-3 text-right">API</th>
                                    <th className="px-4 py-3 text-right">{t("admin.aiColTotalCalls")}</th>
                                    <th className="px-4 py-3 text-right">Input tok</th>
                                    <th className="px-4 py-3 text-right">Output tok</th>
                                    <th className="px-4 py-3 text-right">{t("admin.aiColCost")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium">
                                {(data?.report.users || []).length === 0 && (
                                    <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-400">{t("admin.aiNoMonthData")}</td></tr>
                                )}
                                {(data?.report.users || []).map((u, i) => (
                                    <tr key={u.userId || i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                        <td className="px-4 py-2.5">
                                            <div className="flex flex-col">
                                                <span className="font-bold text-slate-700 dark:text-slate-200 text-xs">{u.name || "—"}</span>
                                                <span className="text-[10px] text-slate-400">{u.email || u.userId || t("admin.notSpecified")}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5 text-right text-xs">{nf(u.ocrCalls)}</td>
                                        <td className="px-4 py-2.5 text-right text-xs">{nf(u.compareCalls)}</td>
                                        <td className="px-4 py-2.5 text-right text-xs">{nf(u.apiCalls)}</td>
                                        <td className="px-4 py-2.5 text-right text-xs font-bold">{nf(u.totalCalls)}</td>
                                        <td className="px-4 py-2.5 text-right text-xs">{nf(u.inputTokens)}</td>
                                        <td className="px-4 py-2.5 text-right text-xs">{nf(u.outputTokens)}</td>
                                        <td className="px-4 py-2.5 text-right text-xs font-bold text-emerald-600">{thb(u.cost)}</td>
                                    </tr>
                                ))}
                                {(data?.report.users || []).length > 0 && (() => {
                                    const tot = (data?.report.users || []).reduce((a, u) => ({
                                        ocr: a.ocr + u.ocrCalls, cmp: a.cmp + u.compareCalls, api: a.api + u.apiCalls,
                                        tot: a.tot + u.totalCalls, inp: a.inp + u.inputTokens,
                                        out: a.out + u.outputTokens, cost: a.cost + u.cost,
                                    }), { ocr: 0, cmp: 0, api: 0, tot: 0, inp: 0, out: 0, cost: 0 });
                                    return (
                                        <tr className="bg-slate-50 dark:bg-slate-800/50 font-black">
                                            <td className="px-4 py-2.5 text-xs">{t("admin.aiMonthlyTotal")}</td>
                                            <td className="px-4 py-2.5 text-right text-xs">{nf(tot.ocr)}</td>
                                            <td className="px-4 py-2.5 text-right text-xs">{nf(tot.cmp)}</td>
                                            <td className="px-4 py-2.5 text-right text-xs">{nf(tot.api)}</td>
                                            <td className="px-4 py-2.5 text-right text-xs">{nf(tot.tot)}</td>
                                            <td className="px-4 py-2.5 text-right text-xs">{nf(tot.inp)}</td>
                                            <td className="px-4 py-2.5 text-right text-xs">{nf(tot.out)}</td>
                                            <td className="px-4 py-2.5 text-right text-xs text-emerald-600">{thb(tot.cost)}</td>
                                        </tr>
                                    );
                                })()}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2">{t("admin.aiMonthPickerHelp")}</p>
                </div>

                {/* Per-model rate editor */}
                <div>
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-400">{t("admin.aiRatesHeader")}</h3>
                        <div className="flex items-center gap-3">
                            {savedMsg && <span className="text-xs font-bold text-emerald-600">{savedMsg}</span>}
                            <button
                                onClick={saveRates}
                                disabled={saving || (data?.models || []).length === 0}
                                className="px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition text-xs font-bold disabled:opacity-50"
                            >
                                {saving ? t("admin.saving") : t("admin.aiSaveAndRecalc")}
                            </button>
                        </div>
                    </div>
                    <div className="mb-3 flex flex-wrap items-center gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
                        <span className="text-xs font-bold text-slate-500">{t("admin.aiExchangeRate")}</span>
                        <input
                            type="number" step="0.01" min="0"
                            value={fxDraft}
                            onChange={(e) => setFxDraft(e.target.value)}
                            className="w-28 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                        />
                        <span className="text-xs font-bold text-slate-500">THB</span>
                        <span className="text-[11px] text-slate-400">{t("admin.aiExchangeHint")}</span>
                    </div>
                    <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50/50 dark:bg-slate-900/50 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                                <tr>
                                    <th className="px-5 py-3">Provider</th>
                                    <th className="px-5 py-3">Model</th>
                                    <th className="px-5 py-3">Input ($/1M)</th>
                                    <th className="px-5 py-3">Output ($/1M)</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {(data?.models || []).length === 0 && (
                                    <tr><td colSpan={4} className="px-5 py-6 text-center text-slate-400">{t("admin.aiNoModel")}</td></tr>
                                )}
                                {(data?.models || []).map((m) => (
                                    <tr key={m.model}>
                                        <td className="px-5 py-3 text-xs font-bold text-slate-500 uppercase">{m.provider}</td>
                                        <td className="px-5 py-3 font-bold text-slate-700 dark:text-slate-200">{m.model}</td>
                                        <td className="px-5 py-3">
                                            <input
                                                type="number" step="0.01" min="0"
                                                value={rateDraft[m.model]?.input ?? ""}
                                                onChange={(e) => setRateDraft(p => ({ ...p, [m.model]: { input: e.target.value, output: p[m.model]?.output ?? "0" } }))}
                                                className="w-28 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                                            />
                                        </td>
                                        <td className="px-5 py-3">
                                            <input
                                                type="number" step="0.01" min="0"
                                                value={rateDraft[m.model]?.output ?? ""}
                                                onChange={(e) => setRateDraft(p => ({ ...p, [m.model]: { input: p[m.model]?.input ?? "0", output: e.target.value } }))}
                                                className="w-28 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2">{t("admin.aiRatesNote")}</p>
                </div>

                {/* Daily breakdown */}
                <div>
                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-400 mb-3">{t("admin.aiDaily")}</h3>
                    <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-x-auto max-h-80 overflow-y-auto custom-scrollbar">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead className="bg-slate-50/50 dark:bg-slate-900/50 text-slate-400 font-bold uppercase tracking-wider text-[10px] sticky top-0">
                                <tr>
                                    <th className="px-5 py-3">{t("admin.aiColDate")}</th>
                                    <th className="px-5 py-3">Function</th>
                                    <th className="px-5 py-3 text-right">Calls</th>
                                    <th className="px-5 py-3 text-right">Input tok</th>
                                    <th className="px-5 py-3 text-right">Output tok</th>
                                    <th className="px-5 py-3 text-right">{t("admin.aiColCost")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium">
                                {(data?.daily || []).length === 0 && (
                                    <tr><td colSpan={6} className="px-5 py-6 text-center text-slate-400">{t("admin.noData")}</td></tr>
                                )}
                                {(data?.daily || []).map((d, i) => (
                                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                        <td className="px-5 py-2.5 text-xs text-slate-500">{d.day}</td>
                                        <td className="px-5 py-2.5 text-xs font-bold">{FN_LABEL[d.fn] || d.fn}</td>
                                        <td className="px-5 py-2.5 text-right text-xs">{nf(d.calls)}</td>
                                        <td className="px-5 py-2.5 text-right text-xs">{nf(d.inputTokens)}</td>
                                        <td className="px-5 py-2.5 text-right text-xs">{nf(d.outputTokens)}</td>
                                        <td className="px-5 py-2.5 text-right text-xs font-bold text-emerald-600">{thb(d.cost)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Raw rows */}
                <div>
                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-400 mb-3">{t("admin.aiRawHeader")}</h3>
                    <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-x-auto max-h-96 overflow-y-auto custom-scrollbar">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead className="bg-slate-50/50 dark:bg-slate-900/50 text-slate-400 font-bold uppercase tracking-wider text-[10px] sticky top-0">
                                <tr>
                                    <th className="px-4 py-3">{t("admin.aiColTime")}</th>
                                    <th className="px-4 py-3">Function</th>
                                    <th className="px-4 py-3">Model</th>
                                    <th className="px-4 py-3">{t("admin.aiColDocFile")}</th>
                                    <th className="px-4 py-3">User</th>
                                    <th className="px-4 py-3 text-right">Input</th>
                                    <th className="px-4 py-3 text-right">Output</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium">
                                {(data?.raw || []).length === 0 && (
                                    <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">{t("admin.noData")}</td></tr>
                                )}
                                {(data?.raw || []).map((r) => (
                                    <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                        <td className="px-4 py-2.5 text-xs text-slate-500">{fmtTime(r.created_at)}</td>
                                        <td className="px-4 py-2.5 text-xs font-bold">{FN_LABEL[r.fn] || r.fn}</td>
                                        <td className="px-4 py-2.5 text-xs text-slate-500">{r.model}</td>
                                        <td className="px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300 max-w-[220px] truncate" title={r.file_name || r.doc_id || ""}>{r.file_name || r.doc_id || "—"}</td>
                                        <td className="px-4 py-2.5 text-xs text-slate-400">{r.user_email || "—"}</td>
                                        <td className="px-4 py-2.5 text-right text-xs">{nf(r.input_tokens)}</td>
                                        <td className="px-4 py-2.5 text-right text-xs">{nf(r.output_tokens)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-slate-400">{k}</span>
            <span className={strong ? "font-black text-slate-800 dark:text-white" : "font-bold"}>{v}</span>
        </div>
    );
}
