"use client";
import React, { useState } from "react";
import { UsageStats } from "@/lib/types";
import { Icon, type IconName } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";

// DOCRoom — Dashboard view (dark, compact). Stats only.
// Recent Activity / document history lives in its own page (DocumentsView)
// since the "View All" flow grew its own search + filter UI.

interface DashboardViewProps {
    usageStats: UsageStats;
    userName?: string;
    userPlan?: string;
    userId?: string;
}

const nf = (n: number) => (n || 0).toLocaleString("en-US");

// ─── KPI / FN card configs ───────────────────────────────────────────────
const FN_TYPE: Record<string, { label: string; icon: IconName; color: string }> = {
    ocr:         { label: "OCR",        icon: "Scan",    color: "#6366f1" },
    compare:     { label: "Compare",    icon: "Compare", color: "#f59e0b" },
    api_extract: { label: "Public API", icon: "Cpu",     color: "#10b981" },
};

// ─── Main component ──────────────────────────────────────────────────────
export default function DashboardView({ usageStats, userName = "User", userPlan }: DashboardViewProps) {
    const { t } = useTranslation();
    const [period, setPeriod] = useState<"week" | "month">("week");

    const fu = usageStats.functionUsage;
    const monthTotal = (fu?.ocr.monthCalls || 0) + (fu?.compare.monthCalls || 0) + (fu?.api_extract.monthCalls || 0);
    const allTimeTotal = (fu?.ocr.calls || 0) + (fu?.compare.calls || 0) + (fu?.api_extract.calls || 0);

    const isUnlimited = usageStats.limit >= 999999;
    const creditsUsed = isUnlimited ? allTimeTotal : Math.max(0, usageStats.limit - usageStats.creditsRemaining);

    const kpi: { label: string; value: string; icon: IconName; color: string; sub: string }[] = [
        { label: t("dashboard.kpiDocs"), value: nf(usageStats.totalDocs), icon: "FileText", color: "#6366f1", sub: t("dashboard.kpiDocsSub") },
        { label: t("dashboard.kpiCredits"), value: nf(creditsUsed), icon: "Zap", color: "#f59e0b", sub: isUnlimited ? t("common.unlimited") : t("dashboard.kpiCreditsSub", { plan: nf(usageStats.limit) }) },
        { label: t("dashboard.kpiMonth"), value: nf(monthTotal), icon: "TrendingUp", color: "#3b82f6", sub: t("dashboard.kpiMonthSub") },
        { label: t("dashboard.kpiConfidence"), value: `${usageStats.avgConfidence || 0}%`, icon: "Star", color: "#10b981", sub: t("dashboard.kpiConfidenceSub") },
    ];

    // Grouped bar chart: per bucket we render an OCR bar and a Compare bar
    // side by side, sharing the same y-axis scale.
    const ocrSeries = period === "week"
        ? (usageStats.weeklyData || [0, 0, 0, 0, 0, 0, 0])
        : (usageStats.monthlyData || [0, 0, 0, 0, 0, 0]);
    const cmpSeries = period === "week"
        ? (usageStats.weeklyCompareData || new Array(ocrSeries.length).fill(0))
        : (usageStats.monthlyCompareData || new Array(ocrSeries.length).fill(0));
    const labels = period === "week"
        ? (usageStats.weekLabels || [])
        : (usageStats.monthLabels || []);
    const data = ocrSeries.map((ocr, i) => ({
        l: labels[i] || "",
        ocr,
        cmp: cmpSeries[i] || 0,
    }));
    const maxV = Math.max(...data.flatMap(d => [d.ocr, d.cmp]), 1);

    // Credit usage breakdown by function
    const breakdown = [
        { label: "OCR",       used: fu?.ocr.calls || 0,         color: "#6366f1" },
        { label: "Compare",   used: fu?.compare.calls || 0,     color: "#f59e0b" },
        { label: "Public API", used: fu?.api_extract.calls || 0, color: "#10b981" },
    ];

    const usedPct = isUnlimited ? 0 : Math.min(100, Math.round((creditsUsed / Math.max(1, usageStats.limit)) * 100));

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: "20px 24px" }}>
            {/* Welcome */}
            <div>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--color-text-1)", margin: 0, letterSpacing: -0.4 }}>
                    {t("dashboard.greeting")}, {userName} 👋
                </h1>
                <p style={{ fontSize: 13, color: "var(--color-text-3)", margin: "2px 0 0" }}>
                    {t("dashboard.welcome")} — {t("common.plan")} {userPlan || "Free"}
                </p>
            </div>

            {/* KPI Cards */}
            <div className="dash-metric-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
                {kpi.map(k => {
                    const Cmp = Icon[k.icon];
                    return (
                        <div key={k.label} style={{ background: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <span style={{ fontSize: 12.5, color: "var(--color-text-3)", fontWeight: 500 }}>{k.label}</span>
                                <div style={{ width: 32, height: 32, borderRadius: 8, background: k.color + "22", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <Cmp width={16} height={16} color={k.color} />
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 26, fontWeight: 700, color: "var(--color-text-1)", letterSpacing: -0.5, lineHeight: 1 }}>{k.value}</div>
                                <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 6 }}>{k.sub}</div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Per-function breakdown (3 cards) */}
            <div className="dash-metric-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                {(["ocr", "compare", "api_extract"] as const).map(k => {
                    const fn = FN_TYPE[k]; const Cmp = Icon[fn.icon];
                    const d = fu?.[k] || { calls: 0, monthCalls: 0 };
                    return (
                        <div key={k} style={{ background: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "16px 18px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ width: 28, height: 28, borderRadius: 6, background: fn.color + "22", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                        <Cmp width={14} height={14} color={fn.color} />
                                    </div>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-1)" }}>{fn.label}</span>
                                </div>
                                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", letterSpacing: 0.8 }}>{nf(d.calls)} calls</span>
                            </div>
                            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--color-text-1)", letterSpacing: -0.4 }}>{nf(d.calls)}</div>
                            <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 4 }}>{t("dashboard.funcThisMonth")} <span style={{ color: "var(--color-text-1)", fontWeight: 600 }}>{nf(d.monthCalls)}</span> {t("dashboard.funcTimes")}</div>
                        </div>
                    );
                })}
            </div>

            {/* Stats column (full width — recent activity moved to its own page) */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {/* Bar chart */}
                    <div style={{ background: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "18px 20px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                            <div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-1)" }}>{t("dashboard.chartTitle")}</div>
                                <div style={{ fontSize: 12, color: "var(--color-text-3)", marginTop: 2 }}>{t("dashboard.chartSubtitle")}</div>
                            </div>
                            <div style={{ display: "flex", gap: 4, background: "var(--color-border)", borderRadius: 8, padding: 3 }}>
                                {(["week", "month"] as const).map(p => (
                                    <button key={p} onClick={() => setPeriod(p)} style={{
                                        padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12,
                                        background: period === p ? "#06b6d4" : "transparent",
                                        color: period === p ? "#fff" : "var(--color-text-3)", fontWeight: period === p ? 600 : 400,
                                    }}>{p === "week" ? t("dashboard.chartWeek") : t("dashboard.chartMonth")}</button>
                                ))}
                            </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 100 }}>
                            {data.map((d, i) => (
                                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                                    <div style={{ fontSize: 10, color: "var(--color-text-3)", display: "flex", gap: 4 }}>
                                        <span style={{ color: d.ocr > 0 ? "#6366f1" : "var(--color-text-4)" }}>{d.ocr}</span>
                                        <span style={{ color: "var(--color-text-4)" }}>/</span>
                                        <span style={{ color: d.cmp > 0 ? "#f59e0b" : "var(--color-text-4)" }}>{d.cmp}</span>
                                    </div>
                                    <div style={{ width: "100%", height: 70, display: "flex", alignItems: "flex-end", gap: 3 }}>
                                        <div title={`OCR: ${d.ocr}`} style={{ flex: 1, background: "#6366f1", opacity: 0.85, borderRadius: "3px 3px 0 0", height: `${(d.ocr / maxV) * 100}%`, transition: "height 0.3s", minHeight: d.ocr > 0 ? 2 : 0 }} />
                                        <div title={`Compare: ${d.cmp}`} style={{ flex: 1, background: "#f59e0b", opacity: 0.85, borderRadius: "3px 3px 0 0", height: `${(d.cmp / maxV) * 100}%`, transition: "height 0.3s", minHeight: d.cmp > 0 ? 2 : 0 }} />
                                    </div>
                                    <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>{d.l}</div>
                                </div>
                            ))}
                        </div>
                        {/* Legend */}
                        <div style={{ display: "flex", justifyContent: "center", gap: 18, marginTop: 12, fontSize: 11, color: "var(--color-text-2)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                <div style={{ width: 10, height: 10, borderRadius: 2, background: "#6366f1" }} />
                                <span>OCR</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                <div style={{ width: 10, height: 10, borderRadius: 2, background: "#f59e0b" }} />
                                <span>Compare</span>
                            </div>
                        </div>
                    </div>

                    {/* Credit usage breakdown */}
                    <div style={{ background: "var(--color-bg-card)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "18px 20px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-1)" }}>{t("dashboard.creditUsage")}</div>
                            <span style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600 }}>
                                {isUnlimited ? "Unlimited" : `${nf(creditsUsed)} / ${nf(usageStats.limit)}`}
                            </span>
                        </div>
                        {!isUnlimited && (
                            <div style={{ height: 8, background: "var(--color-border)", borderRadius: 99, overflow: "hidden", marginBottom: 12 }}>
                                <div style={{ height: "100%", width: `${usedPct}%`, background: "linear-gradient(90deg, #06b6d4, #f59e0b)", borderRadius: 99 }} />
                            </div>
                        )}
                        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                            {breakdown.map(s => (
                                <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                                    <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>{s.label}</span>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-1)" }}>{nf(s.used)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
            </div>
        </div>
    );
}
