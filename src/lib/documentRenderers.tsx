"use client";
import React from "react";
import { exportTableRows } from "@/lib/exportUtils";

// Shared renderers for an extracted document's payload — used by Dashboard's
// Recent Activity expand row (legacy) and DocumentsView (new dedicated page).
// Pulled into its own file so the two views stay visually consistent and the
// table-export buttons live in exactly one place.

const thStyle: React.CSSProperties = { textAlign: "left", padding: "8px 12px", fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.8, color: "var(--color-text-3)" };
const tdStyle: React.CSSProperties = { padding: "8px 12px", color: "var(--color-text-2)" };

export function btnSmall(color: string): React.CSSProperties {
    return { background: color + "22", color, border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 10, fontWeight: 700, letterSpacing: 0.5, cursor: "pointer", textTransform: "uppercase" };
}

interface Strings {
    /** "ไม่มีข้อมูลเปรียบเทียบ" / "No comparison data" */
    noCompareData?: string;
    /** "ต่าง" / "Diff" */
    diff?: string;
    /** "เหมือน" / "Same" */
    same?: string;
    /** "rows" suffix shown after table row count */
    rowsLabel?: string;
}

const FALLBACK: Required<Strings> = {
    noCompareData: "No comparison data",
    diff: "Diff",
    same: "Same",
    rowsLabel: "rows",
};

/** Render the field-key/value payload returned by the OCR pipeline. */
export function renderExtractedData(data: any, docName = "export", _strings: Strings = {}) {
    const s = { ...FALLBACK, ..._strings };
    if (!data || typeof data !== "object") return <p style={{ fontSize: 12, color: "var(--color-text-3)" }}>No data</p>;
    const scalars: { key: string; value: string; conf: number | null }[] = [];
    const tables: { key: string; rows: any[]; conf: number | null }[] = [];
    Object.entries(data).forEach(([key, item]: [string, any]) => {
        if (item && typeof item === "object") {
            if (Array.isArray(item)) {
                if (item.length > 0 && typeof item[0] === "object") tables.push({ key, rows: item, conf: null });
                else scalars.push({ key, value: `[Array ${item.length}]`, conf: null });
            } else if ("value" in item) {
                if (Array.isArray(item.value) && item.value.length > 0 && typeof item.value[0] === "object") {
                    tables.push({ key, rows: item.value, conf: item.confidence });
                } else if (item.value !== null && typeof item.value === "object") {
                    scalars.push({ key, value: "[Object]", conf: item.confidence });
                } else {
                    scalars.push({ key, value: item.value == null ? "-" : String(item.value), conf: item.confidence });
                }
            } else scalars.push({ key, value: JSON.stringify(item), conf: null });
        } else if (item != null) scalars.push({ key, value: String(item), conf: null });
    });
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
            {scalars.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
                    {scalars.map(sc => (
                        <div key={sc.key} style={{ background: "var(--color-bg-panel)", border: "1px solid var(--color-border)", borderRadius: 8, padding: 12 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--color-text-3)", marginBottom: 4 }}>{sc.key.replace(/_/g, " ")}</div>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: sc.value === "-" ? "var(--color-text-4)" : "var(--color-text-1)", wordBreak: "break-word" }}>{sc.value === "-" ? "Not found" : sc.value}</span>
                                {sc.conf != null && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: (sc.conf >= 80 ? "#10b98122" : sc.conf >= 60 ? "#f59e0b22" : "#ef444422"), color: sc.conf >= 80 ? "#10b981" : sc.conf >= 60 ? "#f59e0b" : "#ef4444" }}>{sc.conf}%</span>}
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {tables.map(tb => (
                <div key={tb.key} style={{ background: "var(--color-bg-panel)", border: "1px solid var(--color-border)", borderRadius: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--color-border)" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-1)" }}>{tb.key.replace(/_/g, " ")} <span style={{ color: "var(--color-text-3)", fontWeight: 400 }}>· {tb.rows.length} {s.rowsLabel}</span></span>
                        <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => exportTableRows(tb.rows, `${docName}_${tb.key}`, "excel")} style={btnSmall("#10b981")}>Excel</button>
                            <button onClick={() => exportTableRows(tb.rows, `${docName}_${tb.key}`, "csv")} style={btnSmall("#06b6d4")}>CSV</button>
                        </div>
                    </div>
                    <div style={{ maxHeight: 240, overflow: "auto" }}>
                        <table style={{ width: "100%", fontSize: 11, color: "var(--color-text-2)" }}>
                            <thead style={{ background: "var(--color-bg-elevated)" }}>
                                <tr>{Object.keys(tb.rows[0] || {}).map(h => <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.8, color: "var(--color-text-3)" }}>{h}</th>)}</tr>
                            </thead>
                            <tbody>
                                {tb.rows.map((r, i) => (
                                    <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                                        {Object.keys(tb.rows[0] || {}).map(h => <td key={h} style={{ padding: "6px 12px" }}>{r[h] == null ? "-" : String(r[h])}</td>)}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ))}
        </div>
    );
}

/** Render a Compare result payload (per-field diff table). */
export function renderCompareData(data: any, _strings: Strings = {}) {
    const s = { ...FALLBACK, ..._strings };
    const fields = Array.isArray(data?.fields) ? data.fields : [];
    const summary = Array.isArray(data?.summary) ? data.summary : [];
    const has3 = fields.some((f: any) => f && f.doc3 !== undefined);
    if (!fields.length) return <p style={{ fontSize: 12, color: "var(--color-text-3)" }}>{s.noCompareData}</p>;
    return (
        <div style={{ marginTop: 8 }}>
            {summary.length > 0 && (
                <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px" }}>
                    {summary.map((line: string, i: number) => (
                        <li key={i} style={{ fontSize: 12, color: "var(--color-text-2)", padding: "3px 0" }}>
                            <span style={{ color: "#f59e0b", marginRight: 6 }}>•</span>{line}
                        </li>
                    ))}
                </ul>
            )}
            <div style={{ background: "var(--color-bg-panel)", border: "1px solid var(--color-border)", borderRadius: 8, overflow: "auto" }}>
                <table style={{ width: "100%", fontSize: 11, whiteSpace: "nowrap" }}>
                    <thead style={{ background: "var(--color-bg-elevated)" }}>
                        <tr>
                            <th style={thStyle}>Field</th>
                            <th style={thStyle}>Document 1</th>
                            <th style={thStyle}>Document 2</th>
                            {has3 && <th style={thStyle}>Document 3</th>}
                            <th style={thStyle}>Diff</th>
                        </tr>
                    </thead>
                    <tbody>
                        {fields.map((f: any, i: number) => (
                            <tr key={i} style={{ borderTop: "1px solid var(--color-border)", background: f?.is_diff ? "rgba(239,68,68,0.04)" : "transparent" }}>
                                <td style={{ ...tdStyle, fontWeight: 700, color: "var(--color-text-1)" }}>{f?.key}</td>
                                <td style={tdStyle}>{f?.doc1 ?? "-"}</td>
                                <td style={tdStyle}>{f?.doc2 ?? "-"}</td>
                                {has3 && <td style={tdStyle}>{f?.doc3 ?? "-"}</td>}
                                <td style={{ ...tdStyle, color: f?.is_diff ? "#ef4444" : "#10b981", fontWeight: 600 }}>{f?.is_diff ? s.diff : s.same}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
