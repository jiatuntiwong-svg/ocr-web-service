"use client";
// Renders an Excel workbook (.xlsx/.xls) as scrollable HTML tables with sheet
// tabs. When `highlights` are provided, the matching cells get a coloured
// background so the user can visually locate the AI-extracted source cells.
//
// Cells coords are 0-based. The first row/col strip is just the
// A/B/C / 1/2/3 header overlay — it does NOT consume a coord.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { parseExcel, colLetter, type ExcelSheet, type ExcelCellRef } from "@/lib/excel-parser";

interface ExcelPreviewProps {
    file: File;
    /** Cells the AI flagged as the source of an extracted value. */
    highlights?: ExcelCellRef[];
    /** Highlight tint — defaults to accent blue at low opacity. */
    highlightColor?: string;
}

// Per-cell colors driven by the highlight's `isDiff` flag. If the flag is
// missing we fall back to `highlightColor` (single-tone — used when callers
// don't know diff state, e.g. plain OCR preview).
const DIFF_BG = "rgba(239, 68, 68, 0.32)";
const DIFF_BORDER = "rgba(239, 68, 68, 0.9)";
const MATCH_BG = "rgba(16, 185, 129, 0.32)";
const MATCH_BORDER = "rgba(16, 185, 129, 0.9)";

export default function ExcelPreview({ file, highlights = [], highlightColor = "rgba(59, 130, 246, 0.35)" }: ExcelPreviewProps) {
    const [sheets, setSheets] = useState<ExcelSheet[]>([]);
    const [active, setActive] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const cellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());

    useEffect(() => {
        let cancelled = false;
        file.arrayBuffer().then(buf => {
            if (cancelled) return;
            try {
                const parsed = parseExcel(buf);
                setSheets(parsed);
                setActive(0);
            } catch (e: any) {
                setError(e.message || "Failed to parse Excel");
            }
        });
        return () => { cancelled = true; };
    }, [file]);

    // Auto-switch tab to first highlight when AI result arrives, then scroll.
    useEffect(() => {
        if (!highlights.length || !sheets.length) return;
        const first = highlights[0];
        if (first.sheet !== active) setActive(first.sheet);
        // Defer scroll until the table for the active sheet is in the DOM
        const t = setTimeout(() => {
            const key = `${first.sheet}:${first.row}:${first.col}`;
            const el = cellRefs.current.get(key);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        }, 100);
        return () => clearTimeout(t);
    }, [highlights, sheets.length, active]);

    // Map key → isDiff flag for the cell (undefined if caller didn't pass
    // isDiff — drops back to the legacy single-color path).
    const highlightMap = useMemo(() => {
        const m = new Map<string, boolean | undefined>();
        highlights.forEach(h => m.set(`${h.sheet}:${h.row}:${h.col}`, h.isDiff));
        return m;
    }, [highlights]);

    if (error) {
        return <div style={{ padding: 20, color: "var(--color-danger)" }}>{error}</div>;
    }
    if (!sheets.length) {
        return <div style={{ padding: 20, color: "var(--color-text-3)", fontSize: 12 }}>Loading sheet…</div>;
    }

    const sheet = sheets[active];

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            {/* Sheet tabs */}
            {sheets.length > 1 && (
                <div style={{
                    display: "flex", gap: 4, padding: "6px 8px 0",
                    borderBottom: "1px solid var(--color-border)",
                    background: "var(--color-bg-card)",
                    overflowX: "auto",
                    flexShrink: 0,
                }}>
                    {sheets.map((sh, i) => (
                        <button
                            key={i}
                            onClick={() => setActive(i)}
                            style={{
                                padding: "6px 12px",
                                fontSize: 11.5, fontWeight: 600,
                                border: "1px solid var(--color-border)",
                                borderBottom: i === active ? "1px solid var(--color-bg-card)" : "1px solid var(--color-border)",
                                borderTopLeftRadius: 6, borderTopRightRadius: 6,
                                background: i === active ? "var(--color-bg-card)" : "var(--color-bg-body)",
                                color: i === active ? "var(--color-text-1)" : "var(--color-text-3)",
                                cursor: "pointer", whiteSpace: "nowrap",
                                marginBottom: -1, position: "relative",
                            }}
                        >
                            {sh.name}
                            <span style={{ marginLeft: 6, fontSize: 9, color: "var(--color-text-3)" }}>
                                {sh.rowCount}×{sh.colCount}
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {/* Sheet body */}
            <div style={{ flex: 1, overflow: "auto", background: "var(--color-bg-card)" }}>
                <table style={{
                    borderCollapse: "separate", borderSpacing: 0,
                    fontSize: 11, fontFamily: "ui-monospace, monospace",
                }}>
                    <thead>
                        <tr>
                            <th style={headerCellStyle}></th>
                            {Array.from({ length: sheet.colCount }, (_, c) => (
                                <th key={c} style={headerCellStyle}>{colLetter(c)}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sheet.rows.map((row, r) => (
                            <tr key={r}>
                                <th style={{ ...headerCellStyle, position: "sticky", left: 0, zIndex: 1 }}>{r + 1}</th>
                                {Array.from({ length: sheet.colCount }, (_, c) => {
                                    const key = `${active}:${r}:${c}`;
                                    const isHighlighted = highlightMap.has(key);
                                    const isDiff = highlightMap.get(key);
                                    const cell = row[c];
                                    // Pick color: red = diff, green = match, blue = legacy fallback.
                                    const bg = !isHighlighted
                                        ? "transparent"
                                        : isDiff === true
                                            ? DIFF_BG
                                            : isDiff === false
                                                ? MATCH_BG
                                                : highlightColor;
                                    const border = !isHighlighted
                                        ? "1px solid var(--color-border)"
                                        : isDiff === true
                                            ? `1px solid ${DIFF_BORDER}`
                                            : isDiff === false
                                                ? `1px solid ${MATCH_BORDER}`
                                                : "1px solid var(--color-border)";
                                    return (
                                        <td
                                            key={c}
                                            ref={el => { if (el) cellRefs.current.set(key, el); else cellRefs.current.delete(key); }}
                                            style={{
                                                border,
                                                padding: "3px 6px",
                                                minWidth: 60, maxWidth: 220,
                                                color: "var(--color-text-1)",
                                                background: bg,
                                                whiteSpace: "nowrap",
                                                overflow: "hidden", textOverflow: "ellipsis",
                                                transition: "background 0.2s, border-color 0.2s",
                                            }}
                                            title={cell != null ? String(cell) : ""}
                                        >
                                            {cell == null ? "" : String(cell)}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

const headerCellStyle: React.CSSProperties = {
    background: "var(--color-bg-elevated)",
    color: "var(--color-text-3)",
    border: "1px solid var(--color-border)",
    padding: "3px 8px",
    fontSize: 10, fontWeight: 700,
    textAlign: "center",
    position: "sticky", top: 0, zIndex: 2,
    minWidth: 40,
};
