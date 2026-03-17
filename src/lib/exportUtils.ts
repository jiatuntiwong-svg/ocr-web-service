/**
 * exportUtils.ts
 * Shared export helpers used by both OCR Workspace and Dashboard.
 * Produces multi-sheet workbooks: a "Results Summary" sheet for scalar
 * fields and one dedicated sheet per detected array/table field.
 */
import * as XLSX from "xlsx";

export type ExportFormat = "excel" | "csv";

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
