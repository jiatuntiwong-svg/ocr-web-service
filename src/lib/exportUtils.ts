/**
 * exportUtils.ts
 * Shared export helpers used by both OCR Workspace and Dashboard.
 * Produces multi-sheet workbooks: a "Results Summary" sheet for scalar
 * fields and one dedicated sheet per detected array/table field.
 */
import * as XLSX from "xlsx";
import { computeRowDiff } from "@/lib/table-row-diff";

export type ExportFormat = "excel" | "csv";

// Excel sheet name: ≤31 chars, no special chars, unique. Drop reserved chars
// then truncate. Caller is responsible for de-duplication when needed.
function safeSheetName(name: string): string {
    return name.replace(/[:\\/?*[\]]/g, "_").trim().slice(0, 31) || "Sheet";
}

/**
 * Build a workbook from a parsed OCR result object and download it.
 * Arrays of objects become separate sheets; scalar values go on a summary sheet.
 */
export function exportOCRResult(
    data: Record<string, any>,
    filename: string,
    format: ExportFormat
): void {
    try {
        const wb = XLSX.utils.book_new();
        const summaryData: { Field: string; Value: string }[] = [];
        const tableSections: { name: string; data: any[] }[] = [];

        Object.entries(data).forEach(([key, item]) => {
            // Normalise: if item has a nested { value, confidence } shape unwrap it
            const val =
                item && typeof item === "object" && "value" in item
                    ? item.value
                    : item;

            if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
                tableSections.push({ name: key, data: val });
                summaryData.push({
                    Field: key,
                    Value: `[Table → sheet: "${key.replace(/[:\\/?*[\]]/g, "_").slice(0, 31)}"]`,
                });
            } else {
                summaryData.push({
                    Field: key,
                    Value: val !== null && val !== undefined ? String(val) : "",
                });
            }
        });

        XLSX.utils.book_append_sheet(
            wb,
            XLSX.utils.json_to_sheet(summaryData),
            "Results Summary"
        );

        tableSections.forEach((t) => {
            const safeName = t.name.replace(/[:\\/?*[\]]/g, "_").slice(0, 31);
            XLSX.utils.book_append_sheet(
                wb,
                XLSX.utils.json_to_sheet(t.data),
                safeName
            );
        });

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const outName = `${filename}_${ts}`;

        if (format === "excel") {
            XLSX.writeFile(wb, `${outName}.xlsx`);
        } else {
            XLSX.writeFile(wb, `${outName}.csv`, { bookType: "csv" });
        }
    } catch (err) {
        console.error("exportOCRResult error:", err);
        alert("Export failed. Please try again.");
    }
}

// ─── Multi-file batch export ────────────────────────────────────────────────
// Used by the batch OCR runner — one row per file on a "Summary" sheet, plus
// one extra sheet per table-typed field with a `Source File` column so rows
// from different files don't get mixed up.

export interface BatchResult {
    fileName: string;
    /** OCR-extracted data, same shape as `exportOCRResult(data)`. May be null
     *  for files that errored or were skipped — those still show up on the
     *  summary sheet with their status so the user can see what happened. */
    data: Record<string, any> | null;
    status: "done" | "error" | "skipped";
    error?: string;
}

/** Unwrap `{ value, confidence }` to just `value`; everything else passes through. */
function unwrapValue(item: any): any {
    return item && typeof item === "object" && "value" in item ? item.value : item;
}

export function exportOCRBatch(
    results: BatchResult[],
    filename: string,
    format: ExportFormat,
): void {
    try {
        const wb = XLSX.utils.book_new();

        // Union of every scalar field key across all results. Stable order
        // (first time each key is seen) so the column layout is predictable.
        const scalarFieldOrder: string[] = [];
        const tableFieldOrder: string[] = [];
        const seenScalar = new Set<string>();
        const seenTable = new Set<string>();
        for (const r of results) {
            if (!r.data) continue;
            for (const [key, item] of Object.entries(r.data)) {
                const val = unwrapValue(item);
                const isTable = Array.isArray(val) && val.length > 0 && typeof val[0] === "object";
                if (isTable) {
                    if (!seenTable.has(key)) { seenTable.add(key); tableFieldOrder.push(key); }
                } else {
                    if (!seenScalar.has(key)) { seenScalar.add(key); scalarFieldOrder.push(key); }
                }
            }
        }

        // Summary sheet: 1 row per file. Columns = File, Status, Error,
        // then every scalar field, then a "(rows in <table>)" count column
        // for each table field so the user can scan which files contributed.
        const summaryRows: Record<string, string | number>[] = results.map(r => {
            const row: Record<string, string | number> = {
                File: r.fileName,
                Status: r.status,
                Error: r.error ?? "",
            };
            for (const key of scalarFieldOrder) {
                const val = r.data ? unwrapValue(r.data[key]) : null;
                row[key] = val == null ? "" : String(val);
            }
            for (const key of tableFieldOrder) {
                const val = r.data ? unwrapValue(r.data[key]) : null;
                row[`(rows in ${key})`] = Array.isArray(val) ? val.length : 0;
            }
            return row;
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");

        // One sheet per table field: aggregate rows from every file with a
        // leading "Source File" column. CSV exports only get the Summary
        // sheet — the table sheets fall off the workbook when XLSX writes CSV.
        for (const key of tableFieldOrder) {
            const aggregated: Record<string, any>[] = [];
            for (const r of results) {
                if (!r.data) continue;
                const val = unwrapValue(r.data[key]);
                if (!Array.isArray(val)) continue;
                for (const row of val) {
                    aggregated.push({ "Source File": r.fileName, ...row });
                }
            }
            if (aggregated.length === 0) continue;
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(aggregated), safeSheetName(key));
        }

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const outName = `${filename}_${ts}`;
        if (format === "excel") XLSX.writeFile(wb, `${outName}.xlsx`);
        else XLSX.writeFile(wb, `${outName}.csv`, { bookType: "csv" });
    } catch (err) {
        console.error("exportOCRBatch error:", err);
        alert("Batch export failed. Please try again.");
    }
}

/**
 * Build a workbook from a document-comparison result and download it.
 * One "Comparison" sheet (Field / Document N / Different) + a "Summary" sheet.
 */
export function exportCompareResult(
    result: { summary?: string[]; fields?: any[] },
    filename: string,
    format: ExportFormat,
    /**
     * Source file names per slot — used as column headers in the export so
     * users can tell which doc is which (vs the generic "Document 1/2/3").
     * Excel column header cells must be unique within a sheet, so duplicate
     * names are auto-suffixed and headers always carry the slot prefix.
     */
    docNames?: (string | null | undefined)[],
    /**
     * Verdict mode used for table row diff. Defaults to "smart" for callers
     * that don't pass it (e.g. DocumentsView export from history, where the
     * original mode isn't recorded with the document).
     */
    verdictMode?: "strict" | "smart",
): void {
    try {
        const fields = result.fields || [];
        const has3 = fields.some((f: any) => f && f.doc3 !== undefined);
        const wb = XLSX.utils.book_new();

        const headerFor = (idx: number, fallback: string) => {
            const raw = docNames?.[idx];
            const name = raw && String(raw).trim() ? String(raw).trim() : "";
            // Strip extension for compact headers; full name kept in tooltip
            // wouldn't survive export anyway, so leave the clean form here.
            const clean = name.replace(/\.[^.]+$/, "");
            return clean ? `${fallback} — ${clean}` : fallback;
        };
        const col1 = headerFor(0, "Document 1");
        const col2 = headerFor(1, "Document 2");
        const col3 = headerFor(2, "Document 3");

        // Track sheet names so the per-table sheets below don't collide with
        // each other or with the reserved "Comparison" / "Summary" sheets.
        const usedSheetNames = new Set<string>(["Comparison", "Summary"]);
        const uniqueSheetName = (base: string): string => {
            const b = safeSheetName(base);
            if (!usedSheetNames.has(b)) { usedSheetNames.add(b); return b; }
            for (let i = 2; i < 100; i++) {
                const suffix = ` (${i})`;
                const trimmed = b.slice(0, 31 - suffix.length) + suffix;
                if (!usedSheetNames.has(trimmed)) { usedSheetNames.add(trimmed); return trimmed; }
            }
            return b;
        };

        const rows = fields.map((f: any) => {
            const row: Record<string, string> = {};
            row["Field"] = f?.key ?? "";
            // Table fields hold structured rows under f.rows; their docN value
            // is just the legacy "X rows" summary. Point users to the dedicated
            // detail sheet generated below so they don't think detail is missing.
            const hasTableRows = f?.rows && (Array.isArray(f.rows.doc1) || Array.isArray(f.rows.doc2));
            if (hasTableRows) {
                const sheetName = uniqueSheetName(`Table — ${f.key}`);
                // Remember the chosen name so we can write to the same sheet later.
                f.__exportSheetName = sheetName;
                row[col1] = `[${f.doc1 ?? "table"} — see sheet "${sheetName}"]`;
                row[col2] = `[${f.doc2 ?? "table"} — see sheet "${sheetName}"]`;
                if (has3) row[col3] = `[${f.doc3 ?? "table"} — see sheet "${sheetName}"]`;
            } else {
                row[col1] = f?.doc1 != null ? String(f.doc1) : "";
                row[col2] = f?.doc2 != null ? String(f.doc2) : "";
                if (has3) row[col3] = f?.doc3 != null ? String(f.doc3) : "";
            }
            row["Different"] = f?.is_diff ? "Yes" : "No";
            return row;
        });
        XLSX.utils.book_append_sheet(
            wb,
            XLSX.utils.json_to_sheet(rows.length ? rows : [{ Field: "" }]),
            "Comparison"
        );

        // ─── Per-table detail sheets ────────────────────────────────────
        // For every field with structured rows, render the same row-by-row
        // diff the user sees in TableDiffPanel: status + key + each column
        // for each doc. Diff cells are prefixed "* " so the change stands out
        // in plain CSV (Excel cell styling would need cell-by-cell write).
        for (const f of fields) {
            if (!f?.rows || !f.__exportSheetName) continue;
            const hasDoc3 = Array.isArray(f.rows.doc3);
            const rowDiffs = computeRowDiff({
                rows: {
                    doc1: f.rows.doc1 || [],
                    doc2: f.rows.doc2 || [],
                    doc3: hasDoc3 ? f.rows.doc3 : undefined,
                },
                matchKey: f.match_key,
                mode: verdictMode,
            });

            // Aggregate columns across all rows so every sheet row has the
            // same column ordering (matches TableDiffPanel render).
            const colSet = new Set<string>();
            for (const rd of rowDiffs) {
                if (rd.cells.doc1) Object.keys(rd.cells.doc1).forEach(k => colSet.add(k));
                if (rd.cells.doc2) Object.keys(rd.cells.doc2).forEach(k => colSet.add(k));
                if (rd.cells.doc3) Object.keys(rd.cells.doc3).forEach(k => colSet.add(k));
            }
            const cols = Array.from(colSet);

            const labelByDoc: Record<string, string> = {
                doc1: col1, doc2: col2, doc3: col3,
            };
            const statusLabel: Record<string, string> = {
                match: "Same",
                diff: "Different",
                missing_in_doc1: "Missing in doc 1",
                missing_in_doc2: "Missing in doc 2",
                missing_in_doc3: "Missing in doc 3",
            };

            const detailRows = rowDiffs.map(rd => {
                const out: Record<string, string> = {
                    Status: statusLabel[rd.status] || rd.status,
                    Key: rd.key,
                };
                const diffCols = new Set(rd.diff_columns || []);
                for (const c of cols) {
                    const mark = diffCols.has(c) ? "* " : "";
                    const v1 = rd.cells.doc1?.[c];
                    const v2 = rd.cells.doc2?.[c];
                    out[`${labelByDoc.doc1} · ${c}`] = v1 == null ? "" : `${mark}${v1}`;
                    out[`${labelByDoc.doc2} · ${c}`] = v2 == null ? "" : `${mark}${v2}`;
                    if (hasDoc3) {
                        const v3 = rd.cells.doc3?.[c];
                        out[`${labelByDoc.doc3} · ${c}`] = v3 == null ? "" : `${mark}${v3}`;
                    }
                }
                return out;
            });

            const sheet = XLSX.utils.json_to_sheet(
                detailRows.length ? detailRows : [{ Status: "(empty)" }],
            );
            XLSX.utils.book_append_sheet(wb, sheet, f.__exportSheetName);

            // Cleanup the marker we left on the field object so callers
            // re-using `result` don't see it linger.
            delete f.__exportSheetName;
        }

        if (result.summary && result.summary.length) {
            XLSX.utils.book_append_sheet(
                wb,
                XLSX.utils.json_to_sheet(result.summary.map((s, i) => ({ "#": i + 1, Summary: s }))),
                "Summary"
            );
        }

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const outName = `${filename}_${ts}`;
        if (format === "excel") {
            XLSX.writeFile(wb, `${outName}.xlsx`);
        } else {
            XLSX.writeFile(wb, `${outName}.csv`, { bookType: "csv" });
        }
    } catch (err) {
        console.error("exportCompareResult error:", err);
        alert("Export failed. Please try again.");
    }
}

/**
 * Export a plain array of row objects as a single-sheet workbook.
 * Used for individual table sections in the Dashboard activity feed.
 */
export function exportTableRows(
    rows: any[],
    filename: string,
    format: ExportFormat
): void {
    try {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Table");
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const outName = `${filename}_${ts}`;

        if (format === "excel") {
            XLSX.writeFile(wb, `${outName}.xlsx`);
        } else {
            XLSX.writeFile(wb, `${outName}.csv`, { bookType: "csv" });
        }
    } catch (err) {
        console.error("exportTableRows error:", err);
    }
}
