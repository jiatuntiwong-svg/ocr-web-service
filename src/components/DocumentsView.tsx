"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { renderExtractedData, renderCompareData, btnSmall } from "@/lib/documentRenderers";
import { exportOCRResult, exportCompareResult } from "@/lib/exportUtils";
import ReviewSettings from "./ReviewSettings";

// Full-page document history with search + type filter. The expand-row reveals
// the same extracted-data table that Dashboard's Recent Activity panel used to
// show — logic lives in lib/documentRenderers so both stay consistent.

interface DocumentRow {
    id: string;
    name: string;
    status: string;
    time: string;
    type: string;
    data_extracted: any;
    confidence?: number;
    reviewedAt?: string | null;
    reviewedBy?: string | null;
}

interface Props { userId: string; }

type Filter = "all" | "ocr" | "compare";

// Walks an OCR result payload for the lowest field-level confidence so the row
// can decide whether to flag a review badge. Returns null if no field exposes
// a numeric confidence. AI may emit confidence as 0..1 or 0..100 depending on
// model — normalize to 0..1 here.
function lowestFieldConfidence(data: any): number | null {
    if (!data || typeof data !== "object") return null;
    let lowest: number | null = null;
    for (const v of Object.values(data)) {
        if (v && typeof v === "object" && "confidence" in v) {
            const raw = Number((v as any).confidence);
            if (Number.isFinite(raw)) {
                const norm = raw > 1 ? raw / 100 : raw;
                if (lowest === null || norm < lowest) lowest = norm;
            }
        }
    }
    return lowest;
}

export default function DocumentsView({ userId }: Props) {
    const { t } = useTranslation();
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [docs, setDocs] = useState<DocumentRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [debouncedSearch, setDebouncedSearch] = useState("");

    // Review prefs — drives "Mark Reviewed" button + export gating.
    const [threshold, setThreshold] = useState(0.7);
    const [blockExport, setBlockExport] = useState(false);

    useEffect(() => {
        if (!userId) return;
        (async () => {
            try {
                const res = await fetch(`/api/user-prefs?userId=${encodeURIComponent(userId)}`);
                const data = await res.json() as { confidenceThreshold?: number; blockExportLowConfidence?: boolean };
                if (typeof data.confidenceThreshold === "number") setThreshold(data.confidenceThreshold);
                if (typeof data.blockExportLowConfidence === "boolean") setBlockExport(data.blockExportLowConfidence);
            } catch {}
        })();
    }, [userId]);

    const toggleReviewed = useCallback(async (docId: string, nextReviewed: boolean) => {
        // Optimistic update — revert on failure by walking previous state.
        let snapshot: DocumentRow | undefined;
        setDocs(prev => {
            snapshot = prev.find(d => d.id === docId);
            return prev.map(d => d.id === docId
                ? { ...d, reviewedAt: nextReviewed ? new Date().toISOString() : null, reviewedBy: nextReviewed ? userId : null }
                : d);
        });
        try {
            const res = await fetch("/api/documents/review", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId, docId, reviewed: nextReviewed }),
            });
            if (!res.ok) throw new Error("review failed");
        } catch {
            if (snapshot) {
                const s = snapshot;
                setDocs(prev => prev.map(d => d.id === docId ? s : d));
            }
        }
    }, [userId]);

    // Debounce keystrokes so we don't hammer the API on every char.
    useEffect(() => {
        const handle = setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => clearTimeout(handle);
    }, [search]);

    const fetchDocs = useCallback(async () => {
        if (!userId) return;
        setLoading(true);
        try {
            const params = new URLSearchParams({ userId, limit: "200" });
            if (debouncedSearch) params.set("search", debouncedSearch);
            if (filter !== "all") params.set("type", filter);
            const res = await fetch(`/api/documents?${params.toString()}`);
            const json = await res.json() as { success: boolean; documents?: DocumentRow[] };
            if (json.success && Array.isArray(json.documents)) setDocs(json.documents);
        } catch (e) {
            console.error("[DocumentsView] fetch error", e);
        } finally {
            setLoading(false);
        }
    }, [userId, debouncedSearch, filter]);

    useEffect(() => { fetchDocs(); }, [fetchDocs]);

    const filterChips: { id: Filter; labelKey: string }[] = useMemo(() => [
        { id: "all",     labelKey: "documents.filterAll" },
        { id: "ocr",     labelKey: "documents.filterOcr" },
        { id: "compare", labelKey: "documents.filterCompare" },
    ], []);

    const isFiltered = debouncedSearch.length > 0 || filter !== "all";

    return (
        <div style={{
            display: "flex", flexDirection: "column",
            background: "var(--color-bg-body)",
            color: "var(--color-text-1)",
            borderRadius: 10,
            border: "1px solid var(--color-border)",
            minHeight: "calc(100vh - 92px)",
            overflow: "hidden",
        }}>
            {/* Toolbar — search + filter chips + refresh */}
            <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "12px 16px",
                borderBottom: "1px solid var(--color-border)",
                background: "var(--color-bg-surface)",
                flexShrink: 0, flexWrap: "wrap",
            }}>
                <div style={{ position: "relative", flex: "1 1 240px", maxWidth: 420 }}>
                    <span style={{ position: "absolute", left: 10, top: 9, color: "var(--color-text-3)", pointerEvents: "none" }}>
                        <Icon.Search width={14} height={14} />
                    </span>
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder={t("documents.searchPlaceholder")}
                        style={{
                            width: "100%", padding: "8px 10px 8px 32px",
                            background: "var(--color-bg-elevated)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 7, color: "var(--color-text-1)",
                            fontSize: 13, outline: "none", boxSizing: "border-box",
                        }}
                    />
                </div>

                <div style={{ display: "inline-flex", gap: 4, padding: 3, background: "var(--color-bg-elevated)", borderRadius: 8 }}>
                    {filterChips.map(c => {
                        const active = filter === c.id;
                        return (
                            <button key={c.id} onClick={() => setFilter(c.id)}
                                style={{
                                    padding: "5px 12px", borderRadius: 6, border: "none",
                                    background: active ? "var(--color-bg-card)" : "transparent",
                                    color: active ? "var(--color-text-1)" : "var(--color-text-3)",
                                    fontSize: 12, fontWeight: active ? 600 : 500, cursor: "pointer",
                                }}>
                                {t(c.labelKey)}
                            </button>
                        );
                    })}
                </div>

                <span style={{ fontSize: 11.5, color: "var(--color-text-3)", marginLeft: 4 }}>
                    {t("documents.countLabel", { count: docs.length })}
                </span>

                <div style={{ flex: 1 }} />

                <button onClick={fetchDocs} disabled={loading}
                    title={t("documents.refresh")}
                    style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "6px 10px", borderRadius: 6,
                        background: "var(--color-bg-elevated)",
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text-2)", fontSize: 11.5,
                        cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1,
                    }}>
                    <Icon.RefreshCw width={11} height={11} />
                    {t("documents.refresh")}
                </button>
            </div>

            {/* Body */}
            <div className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: 12 }}>
                {/* Review-settings panel — affects export gating + review badges on every row. */}
                {userId && (
                    <div style={{ marginBottom: 12 }}>
                        <ReviewSettings
                            userId={userId}
                            onChange={({ threshold: t, blockExport: b }) => { setThreshold(t); setBlockExport(b); }}
                        />
                    </div>
                )}

                {loading && docs.length === 0 && (
                    <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-3)", fontSize: 13 }}>
                        {t("documents.loading")}
                    </div>
                )}

                {!loading && docs.length === 0 && (
                    <div style={{ padding: 60, textAlign: "center", color: "var(--color-text-3)" }}>
                        <div style={{ width: 56, height: 56, margin: "0 auto 12px", borderRadius: 14, background: "var(--color-bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Icon.FileText width={26} height={26} color="var(--color-text-3)" />
                        </div>
                        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-2)" }}>
                            {isFiltered ? t("documents.emptyFiltered") : t("documents.empty")}
                        </p>
                    </div>
                )}

                {docs.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {docs.map(doc => (
                            <DocumentRowItem
                                key={doc.id}
                                doc={doc}
                                expanded={expandedId === doc.id}
                                onToggleExpand={() => setExpandedId(prev => prev === doc.id ? null : doc.id)}
                                t={t}
                                threshold={threshold}
                                blockExport={blockExport}
                                onToggleReviewed={toggleReviewed}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Row + expanded body ─────────────────────────────────────────────────
function DocumentRowItem({ doc, expanded, onToggleExpand, t, threshold, blockExport, onToggleReviewed }: {
    doc: DocumentRow;
    expanded: boolean;
    onToggleExpand: () => void;
    t: (key: string, vars?: Record<string, string | number>) => string;
    threshold: number;
    blockExport: boolean;
    onToggleReviewed: (docId: string, nextReviewed: boolean) => void;
}) {
    const isCompare = doc.type === "compare";
    const color = isCompare ? "#f59e0b" : "#6366f1";
    const TypeIcon = isCompare ? Icon.Compare : Icon.Scan;

    const status = doc.status === "completed"
        ? { label: t("documents.statusCompleted"), color: "var(--color-success)" }
        : doc.status === "error"
            ? { label: t("documents.statusError"), color: "var(--color-danger)" }
            : { label: t("documents.statusProcessing"), color: "var(--color-warning)" };

    const dateLabel = (() => {
        try { return new Date(doc.time).toLocaleString(); }
        catch { return doc.time; }
    })();

    return (
        <div style={{
            background: expanded ? "var(--color-bg-card)" : "var(--color-bg-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            overflow: "hidden",
            transition: "background 0.15s",
        }}>
            <div onClick={onToggleExpand}
                style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 14px", cursor: "pointer",
                }}>
                <div style={{
                    width: 32, height: 32, borderRadius: 7,
                    background: color + "22", display: "flex",
                    alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                    <TypeIcon width={14} height={14} color={color} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                        fontSize: 13, fontWeight: 600, color: "var(--color-text-1)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        marginBottom: 2,
                    }}>{doc.name}</p>
                    <p style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                        <span style={{ color, fontWeight: 600 }}>{isCompare ? "Compare" : "OCR"}</span>
                        <span style={{ margin: "0 6px", color: "var(--color-text-4)" }}>·</span>
                        {dateLabel}
                    </p>
                </div>
                {/* Review badges — only meaningful for OCR docs with confidence data. */}
                {!isCompare && doc.status === "completed" && (() => {
                    const lowest = lowestFieldConfidence(doc.data_extracted);
                    const needsReview = lowest !== null && lowest < threshold;
                    if (doc.reviewedAt) {
                        return (
                            <span style={{
                                fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                                background: "rgba(16,185,129,0.15)", color: "#10b981",
                                textTransform: "uppercase", letterSpacing: 0.5,
                            }}>
                                ✓ {t("reviewSettings.markedReviewed")}
                            </span>
                        );
                    }
                    if (needsReview) {
                        return (
                            <span style={{
                                fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                                background: "rgba(245,158,11,0.18)", color: "#f59e0b",
                                textTransform: "uppercase", letterSpacing: 0.5,
                            }}>
                                ⚠ REVIEW
                            </span>
                        );
                    }
                    return null;
                })()}
                <span style={{
                    fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                    background: status.color + "22", color: status.color,
                    textTransform: "uppercase", letterSpacing: 0.5,
                }}>
                    {status.label}
                </span>
                <Icon.ChevronDown width={14} height={14} color="var(--color-text-3)"
                    style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
            </div>

            {expanded && (
                <div style={{
                    padding: "8px 14px 14px",
                    borderTop: "1px solid var(--color-border)",
                    background: "var(--color-bg-card)",
                }}>
                    {/* Per-doc export bar */}
                    {doc.data_extracted && (() => {
                        const lowest = isCompare ? null : lowestFieldConfidence(doc.data_extracted);
                        const needsReview = lowest !== null && lowest < threshold && !doc.reviewedAt;
                        const hardBlocked = needsReview && blockExport;

                        const guardedExport = (run: () => void, e: React.MouseEvent) => {
                            e.stopPropagation();
                            if (hardBlocked) return;
                            if (needsReview) {
                                if (!window.confirm(t("reviewSettings.exportWarning"))) return;
                            }
                            run();
                        };

                        return (
                            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                                {isCompare ? (
                                    <>
                                        <button onClick={(e) => guardedExport(() => exportCompareResult(doc.data_extracted, doc.name, "excel"), e)}
                                            style={btnSmall("#10b981")}>Export Excel</button>
                                        <button onClick={(e) => guardedExport(() => exportCompareResult(doc.data_extracted, doc.name, "csv"), e)}
                                            style={btnSmall("#06b6d4")}>Export CSV</button>
                                    </>
                                ) : (
                                    <>
                                        <button
                                            onClick={(e) => guardedExport(() => exportOCRResult(doc.data_extracted, doc.name, "excel"), e)}
                                            disabled={hardBlocked}
                                            title={hardBlocked ? t("reviewSettings.exportBlocked") : undefined}
                                            style={{ ...btnSmall("#10b981"), opacity: hardBlocked ? 0.45 : 1, cursor: hardBlocked ? "not-allowed" : "pointer" }}>
                                            Export Excel
                                        </button>
                                        <button
                                            onClick={(e) => guardedExport(() => exportOCRResult(doc.data_extracted, doc.name, "csv"), e)}
                                            disabled={hardBlocked}
                                            title={hardBlocked ? t("reviewSettings.exportBlocked") : undefined}
                                            style={{ ...btnSmall("#06b6d4"), opacity: hardBlocked ? 0.45 : 1, cursor: hardBlocked ? "not-allowed" : "pointer" }}>
                                            Export CSV
                                        </button>
                                    </>
                                )}

                                {!isCompare && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onToggleReviewed(doc.id, !doc.reviewedAt); }}
                                        style={{
                                            ...btnSmall(doc.reviewedAt ? "#f59e0b" : "#10b981"),
                                            marginLeft: "auto",
                                        }}>
                                        {doc.reviewedAt ? "Undo review" : t("reviewSettings.markReviewed")}
                                    </button>
                                )}
                            </div>
                        );
                    })()}
                    {/* Render payload */}
                    {isCompare
                        ? renderCompareData(doc.data_extracted, {
                            noCompareData: t("dashboard.noCompareData"),
                            diff: t("documents.filterCompare") === "Compare" ? "Diff" : "ต่าง",
                            same: t("documents.filterCompare") === "Compare" ? "Same" : "เหมือน",
                        })
                        : renderExtractedData(doc.data_extracted, doc.name, {
                            rowsLabel: t("dashboard.rows"),
                        })
                    }
                </div>
            )}
        </div>
    );
}
