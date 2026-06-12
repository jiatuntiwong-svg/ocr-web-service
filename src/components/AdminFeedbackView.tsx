"use client";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { fetchJson } from "@/lib/fetchJson";
import { apiError } from "@/lib/friendlyError";
import { ErrorCode } from "@/lib/errorCodes";
import { useToast } from "@/components/Toast";

interface FeedbackRow {
    id: string;
    user_id: string | null;
    category: "bug" | "feature" | "other";
    message: string;
    status: "new" | "in_progress" | "resolved";
    page_url: string | null;
    user_agent: string | null;
    admin_note: string | null;
    resolved_by: string | null;
    resolved_at: string | null;
    created_at: string;
    user_name: string | null;
    user_email: string | null;
    resolver_name: string | null;
}

type StatusFilter = "all" | "new" | "in_progress" | "resolved";
type CategoryFilter = "all" | "bug" | "feature" | "other";

export default function AdminFeedbackView() {
    const { t } = useTranslation();
    const { showToast, toastNode } = useToast();
    const [items, setItems] = useState<FeedbackRow[]>([]);
    const [counts, setCounts] = useState<Record<string, number>>({ new: 0, in_progress: 0, resolved: 0 });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
    const [search, setSearch] = useState("");
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState<string | null>(null);

    const fetchItems = async () => {
        setLoading(true);
        setError(null);
        const res = await fetchJson<{ items: FeedbackRow[]; counts: Record<string, number> }>("/api/admin/feedback");
        setLoading(false);
        if (res.ok) {
            setItems(res.items || []);
            setCounts(res.counts || { new: 0, in_progress: 0, resolved: 0 });
        } else {
            setError(apiError(res.code, res.vars, t));
        }
    };

    useEffect(() => { fetchItems(); }, []);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return items.filter(it => {
            if (statusFilter !== "all" && it.status !== statusFilter) return false;
            if (categoryFilter !== "all" && it.category !== categoryFilter) return false;
            if (!q) return true;
            return (
                (it.message || "").toLowerCase().includes(q)
                || (it.user_email || "").toLowerCase().includes(q)
                || (it.user_name || "").toLowerCase().includes(q)
            );
        });
    }, [items, statusFilter, categoryFilter, search]);

    // Times stored as SQLite UTC without 'Z' — append it so JS doesn't read
    // them in browser local TZ. Renders in Asia/Bangkok for consistency.
    const formatTime = (ts: string | null) => {
        if (!ts) return "—";
        const iso = ts.includes("T") || ts.endsWith("Z") ? ts : ts.replace(" ", "T") + "Z";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return ts;
        return new Intl.DateTimeFormat("th-TH", {
            timeZone: "Asia/Bangkok",
            year: "numeric", month: "short", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false,
        }).format(d);
    };

    const updateRow = async (id: string, patch: { status?: FeedbackRow["status"]; adminNote?: string }) => {
        setSaving(id);
        const res = await fetchJson("/api/admin/feedback", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, ...patch }),
        });
        setSaving(null);
        if (res.ok) {
            showToast(t("common.success"), "success");
            await fetchItems();
        } else {
            showToast(apiError(res.code || ErrorCode.GENERIC, res.vars, t), "error");
        }
    };

    const catColor: Record<string, { bg: string; fg: string }> = {
        bug: { bg: "rgba(244,63,94,0.15)", fg: "#be123c" },
        feature: { bg: "rgba(59,130,246,0.15)", fg: "#1d4ed8" },
        other: { bg: "rgba(100,116,139,0.15)", fg: "#475569" },
    };
    const statusColor: Record<string, { bg: string; fg: string }> = {
        new: { bg: "rgba(245,158,11,0.18)", fg: "#b45309" },
        in_progress: { bg: "rgba(59,130,246,0.15)", fg: "#1d4ed8" },
        resolved: { bg: "rgba(16,185,129,0.15)", fg: "#059669" },
    };
    const statusLabel = (s: string) => {
        if (s === "in_progress") return t("feedback.statusInProgress");
        if (s === "resolved") return t("feedback.statusResolved");
        return t("feedback.statusNew");
    };

    return (
        <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
            {toastNode}
            <div className="p-6 md:p-8 space-y-5">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                    <div>
                        <h2 className="text-2xl font-black text-slate-800 dark:text-white">{t("feedback.adminTitle")}</h2>
                        <p className="text-sm text-slate-500 mt-1 font-medium">{t("feedback.adminSubtitle")}</p>
                    </div>
                    <button
                        onClick={fetchItems}
                        disabled={loading}
                        className="px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 text-sm font-bold disabled:opacity-50"
                    >
                        {loading ? t("common.processing") : t("common.refresh")}
                    </button>
                </div>

                {/* Filters */}
                <div className="flex flex-col md:flex-row md:items-center gap-3">
                    <div className="flex gap-2 flex-wrap">
                        {(["all", "new", "in_progress", "resolved"] as StatusFilter[]).map(s => {
                            const active = statusFilter === s;
                            const count = s === "all" ? items.length : counts[s] || 0;
                            return (
                                <button
                                    key={s}
                                    onClick={() => setStatusFilter(s)}
                                    className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition flex items-center gap-2 ${active
                                        ? "bg-slate-800 text-white"
                                        : "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                                        }`}
                                >
                                    {s === "all" ? t("common.viewAll") : statusLabel(s)}
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${active ? "bg-white/20" : "bg-slate-100 dark:bg-slate-700 text-slate-500"}`}>{count}</span>
                                </button>
                            );
                        })}
                    </div>
                    <select
                        value={categoryFilter}
                        onChange={e => setCategoryFilter(e.target.value as CategoryFilter)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                    >
                        <option value="all">{t("feedback.allCategories")}</option>
                        <option value="bug">{t("feedback.categoryBug")}</option>
                        <option value="feature">{t("feedback.categoryFeature")}</option>
                        <option value="other">{t("feedback.categoryOther")}</option>
                    </select>
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder={t("feedback.searchPlaceholder")}
                        className="flex-1 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                    />
                </div>

                {error && (
                    <div className="p-3 bg-rose-50 dark:bg-rose-900/20 text-rose-600 border border-rose-200 dark:border-rose-800 rounded-lg text-sm font-bold">
                        {error}
                    </div>
                )}

                {/* List */}
                <div className="space-y-3">
                    {filtered.length === 0 && !loading && (
                        <div className="text-center py-10 text-slate-400 text-sm">
                            {items.length === 0 ? t("feedback.empty") : t("feedback.emptyFiltered")}
                        </div>
                    )}
                    {filtered.map(it => {
                        const cc = catColor[it.category] || catColor.other;
                        const sc = statusColor[it.status] || statusColor.new;
                        const isExpanded = expandedId === it.id;
                        const noteValue = noteDraft[it.id] ?? it.admin_note ?? "";
                        return (
                            <div key={it.id} className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-950/40">
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : it.id)}
                                    className="w-full text-left p-4 hover:bg-slate-50 dark:hover:bg-slate-900/40 transition flex items-start gap-3"
                                >
                                    <div className="flex flex-col gap-1 flex-shrink-0">
                                        <span style={{ background: cc.bg, color: cc.fg, padding: "2px 7px", borderRadius: 10, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                                            {it.category}
                                        </span>
                                        <span style={{ background: sc.bg, color: sc.fg, padding: "2px 7px", borderRadius: 10, fontSize: 10, fontWeight: 700, textAlign: "center" }}>
                                            {statusLabel(it.status)}
                                        </span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-slate-800 dark:text-slate-200 line-clamp-2">{it.message}</p>
                                        <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-slate-500">
                                            <span>{it.user_email || t("feedback.guest")}</span>
                                            <span>·</span>
                                            <span>{formatTime(it.created_at)}</span>
                                            {it.resolver_name && (
                                                <>
                                                    <span>·</span>
                                                    <span>{t("feedback.resolvedBy")} {it.resolver_name}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </button>

                                {isExpanded && (
                                    <div className="px-4 pb-4 pt-2 border-t border-slate-100 dark:border-slate-800/60 space-y-3 bg-slate-50/40 dark:bg-slate-900/30">
                                        <div>
                                            <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">{t("feedback.messageLabel")}</div>
                                            <pre className="text-sm whitespace-pre-wrap break-words text-slate-700 dark:text-slate-300 font-sans">{it.message}</pre>
                                        </div>
                                        {it.page_url && (
                                            <div>
                                                <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">{t("feedback.pageUrl")}</div>
                                                <div className="text-[11px] font-mono text-slate-600 dark:text-slate-400 break-all">{it.page_url}</div>
                                            </div>
                                        )}
                                        {it.user_agent && (
                                            <div>
                                                <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">{t("feedback.userAgent")}</div>
                                                <div className="text-[11px] font-mono text-slate-500 break-all line-clamp-2">{it.user_agent}</div>
                                            </div>
                                        )}
                                        <div>
                                            <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">{t("feedback.adminNote")}</div>
                                            <textarea
                                                value={noteValue}
                                                onChange={e => setNoteDraft(d => ({ ...d, [it.id]: e.target.value }))}
                                                rows={2}
                                                maxLength={2000}
                                                placeholder={t("feedback.adminNotePlaceholder")}
                                                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                                            />
                                        </div>
                                        <div className="flex flex-wrap gap-2 justify-end">
                                            {noteValue !== (it.admin_note ?? "") && (
                                                <button
                                                    onClick={() => updateRow(it.id, { adminNote: noteValue })}
                                                    disabled={saving === it.id}
                                                    className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                                                >{t("feedback.saveNote")}</button>
                                            )}
                                            {it.status !== "in_progress" && (
                                                <button
                                                    onClick={() => updateRow(it.id, { status: "in_progress" })}
                                                    disabled={saving === it.id}
                                                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-500"
                                                >{t("feedback.markInProgress")}</button>
                                            )}
                                            {it.status !== "resolved" && (
                                                <button
                                                    onClick={() => updateRow(it.id, { status: "resolved" })}
                                                    disabled={saving === it.id}
                                                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-500"
                                                >{t("feedback.markResolved")}</button>
                                            )}
                                            {it.status === "resolved" && (
                                                <button
                                                    onClick={() => updateRow(it.id, { status: "new" })}
                                                    disabled={saving === it.id}
                                                    className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                                                >{t("feedback.reopen")}</button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {items.length > 0 && (
                    <p className="text-xs text-slate-400 text-right">
                        {t("feedback.showing", { shown: filtered.length, total: items.length })}
                    </p>
                )}
            </div>
        </div>
    );
}
