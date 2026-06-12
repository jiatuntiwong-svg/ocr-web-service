// Row-level diff for `type=table` Compare fields.
//
// The AI returns two (or three/four) arrays of row objects plus a suggested
// `match_key` column name. We pair rows across docs by that key, then
// compare each cell with per-column normalisation so trivial formatting
// noise (commas, whitespace, case) doesn't get flagged as a difference.
//
// Falls back to position matching when no usable key is provided.

export type RowStatus = "match" | "diff" | "missing_in_doc1" | "missing_in_doc2" | "missing_in_doc3";

export interface RowDiff {
    /** Identifier used to pair the row across docs (match_key value or row index). */
    key: string;
    status: RowStatus;
    /** Per-doc cell maps. Undefined when the row is missing in that doc. */
    cells: {
        doc1?: Record<string, any>;
        doc2?: Record<string, any>;
        doc3?: Record<string, any>;
    };
    /** Column names where doc1↔doc2 (or doc1↔doc3) actually differ. */
    diff_columns?: string[];
}

// Reuse the same semantic normaliser the scalar-field verdict uses, so a
// date cell like "15 มกราคม 2565" doesn't get flagged ≠ "2022-01-15", and
// a currency cell like "USD 51,651.11" doesn't get flagged ≠ "51651.11 USD".
// The verdict mode is threaded down from the caller so a strict-mode compare
// run also strict-compares table cells.
import { normalizeForDiff, type VerdictMode } from "./diffNormalize";

function cellsDifferent(a: any, b: any, mode: VerdictMode): boolean {
    return normalizeForDiff(a, mode) !== normalizeForDiff(b, mode);
}

function pairCompare(
    rowA: Record<string, any> | undefined,
    rowB: Record<string, any> | undefined,
    mode: VerdictMode,
): string[] {
    if (!rowA || !rowB) return [];
    const allCols = new Set([...Object.keys(rowA), ...Object.keys(rowB)]);
    const diffs: string[] = [];
    for (const col of allCols) {
        if (cellsDifferent(rowA[col], rowB[col], mode)) diffs.push(col);
    }
    return diffs;
}

interface ComputeRowDiffInput {
    rows: { doc1: any[]; doc2: any[]; doc3?: any[] };
    /** Column AI suggested for row pairing (e.g. "item_code"). */
    matchKey?: string;
    /** Verdict strictness (defaults to "smart" for backward compatibility). */
    mode?: VerdictMode;
}

/**
 * Compute row-level diff between 2 or 3 docs' table data.
 *
 * Strategy:
 *   1. If `matchKey` exists in every row, pair rows by that key (set-based).
 *   2. Otherwise fall back to position pairing (row[i] across docs).
 *   3. Status is "match" only when ALL doc pairs are identical at the cell level.
 */
export function computeRowDiff(input: ComputeRowDiffInput): RowDiff[] {
    const { rows, matchKey, mode = "smart" } = input;
    const { doc1, doc2, doc3 } = rows;
    const hasDoc3 = Array.isArray(doc3);

    const useKey = !!matchKey
        && doc1.every(r => r?.[matchKey!] != null && String(r[matchKey!]).trim() !== "")
        && doc2.every(r => r?.[matchKey!] != null && String(r[matchKey!]).trim() !== "")
        && (!hasDoc3 || doc3!.every(r => r?.[matchKey!] != null && String(r[matchKey!]).trim() !== ""));

    if (useKey) {
        return diffByKey(doc1, doc2, hasDoc3 ? doc3! : undefined, matchKey!, mode);
    }
    return diffByPosition(doc1, doc2, hasDoc3 ? doc3! : undefined, mode);
}

function diffByKey(
    a: any[], b: any[], c: any[] | undefined,
    matchKey: string,
    mode: VerdictMode,
): RowDiff[] {
    const keyOf = (r: any) => String(r[matchKey] ?? "").trim();
    const mapB = new Map<string, any>(b.map(r => [keyOf(r), r]));
    const mapC = c ? new Map<string, any>(c.map(r => [keyOf(r), r])) : null;
    const usedB = new Set<string>();
    const usedC = new Set<string>();
    const out: RowDiff[] = [];

    // Walk A first (preserves doc1 order)
    for (const ra of a) {
        const k = keyOf(ra);
        const rb = mapB.get(k);
        const rc = mapC?.get(k);
        if (rb) usedB.add(k);
        if (rc) usedC.add(k);

        const diff12 = pairCompare(ra, rb, mode);
        const diff13 = mapC ? pairCompare(ra, rc, mode) : [];
        const allDiffs = Array.from(new Set([...diff12, ...diff13]));

        let status: RowStatus;
        if (!rb) status = "missing_in_doc2";
        else if (mapC && !rc) status = "missing_in_doc3";
        else if (allDiffs.length === 0) status = "match";
        else status = "diff";

        out.push({
            key: k,
            status,
            cells: { doc1: ra, doc2: rb, ...(mapC ? { doc3: rc } : {}) },
            diff_columns: allDiffs.length ? allDiffs : undefined,
        });
    }

    // Walk B leftovers
    for (const rb of b) {
        const k = keyOf(rb);
        if (usedB.has(k)) continue;
        const rc = mapC?.get(k);
        if (rc) usedC.add(k);
        out.push({
            key: k,
            status: "missing_in_doc1",
            cells: { doc2: rb, ...(rc ? { doc3: rc } : {}) },
        });
    }

    // Walk C leftovers (only when doc3 exists)
    if (mapC) {
        for (const rc of c!) {
            const k = keyOf(rc);
            if (usedC.has(k)) continue;
            out.push({
                key: k,
                status: "missing_in_doc1",  // also missing in doc2 — treated as "extra in doc3"
                cells: { doc3: rc },
            });
        }
    }

    return out;
}

function diffByPosition(a: any[], b: any[], c: any[] | undefined, mode: VerdictMode): RowDiff[] {
    const n = Math.max(a.length, b.length, c?.length ?? 0);
    const out: RowDiff[] = [];
    for (let i = 0; i < n; i++) {
        const ra = a[i];
        const rb = b[i];
        const rc = c?.[i];
        const key = `#${i + 1}`;
        const diff12 = pairCompare(ra, rb, mode);
        const diff13 = c ? pairCompare(ra, rc, mode) : [];
        const allDiffs = Array.from(new Set([...diff12, ...diff13]));

        let status: RowStatus;
        if (!ra) status = "missing_in_doc1";
        else if (!rb) status = "missing_in_doc2";
        else if (c && !rc) status = "missing_in_doc3";
        else if (allDiffs.length === 0) status = "match";
        else status = "diff";

        out.push({
            key,
            status,
            cells: { doc1: ra, doc2: rb, ...(c ? { doc3: rc } : {}) },
            diff_columns: allDiffs.length ? allDiffs : undefined,
        });
    }
    return out;
}

/** Sum row counts per doc — feeds the table_row_factor in pricing. */
export function rowCountsPerDoc(rows: { doc1?: any[]; doc2?: any[]; doc3?: any[] }): number[] {
    const out: number[] = [];
    if (Array.isArray(rows.doc1)) out.push(rows.doc1.length);
    if (Array.isArray(rows.doc2)) out.push(rows.doc2.length);
    if (Array.isArray(rows.doc3)) out.push(rows.doc3.length);
    return out;
}

/** Heuristic: try to detect a unique-ish key column from rows. */
export function suggestMatchKey(rows: any[]): string | null {
    if (!rows.length) return null;
    const cols = Object.keys(rows[0]);
    // Score each column by uniqueness × presence.
    let best: { col: string; score: number } | null = null;
    for (const col of cols) {
        const vals = rows.map(r => String(r[col] ?? "").trim()).filter(Boolean);
        if (!vals.length) continue;
        const unique = new Set(vals).size;
        const score = unique / rows.length;  // 1.0 = perfectly unique
        if (!best || score > best.score) best = { col, score };
    }
    // Require at least 80% uniqueness to be useful.
    return best && best.score >= 0.8 ? best.col : null;
}
