// Page-selection contract shared by /api/upload and /api/v1/extract.
//
// Background (issue 1.3): 10+ page PDFs take multi-minute AI runs because the
// client rasterises every page into one tall PNG and the model sees them all.
// The frontend page-picker (UI-1) lets the user pick a subset before upload.
// This module owns the server side of that contract:
//
//   - parseAndValidatePages(formData) — pull `pages` + `total_pages` off the
//     multipart body, validate them, and enforce PAGE_SELECTION_MAX.
//   - remapBboxHintPage() — Path A translation: a stored hint's `page` is
//     always the ORIGINAL PDF page number; this maps it to the 1-based index
//     of that page inside the sent selection (or null if the page was
//     dropped). Used when we need the position within the stacked upload.
//
// Semantics:
//   * `pages` is a 1-based integer array of ORIGINAL PDF page numbers.
//     `[1, 3, 5]` = "I sent pages 1, 3 and 5 of the source PDF, in that
//     order, stacked into the uploaded PNG."
//   * Client is responsible for actually rendering only those pages —
//     the server never sees the source PDF (rasterisation is browser-side
//     in `src/lib/pdf-to-image.ts`). `pages` is therefore ADVISORY metadata
//     for logging + hint remapping + prompt enrichment, plus a cap check.
//   * `bbox_hint.page` semantics are INVARIANT across selections (Path A):
//     the stored page number always refers to the ORIGINAL PDF page. This
//     keeps saved template hints correct even when the user picks a
//     different subset each run.
//
// See `pm/reports/API-1.md` for the full contract.

import { PAGE_SELECTION_MAX } from "./ocrBatchConfig";
import { ErrorCode, type ErrorCodeT } from "./errorCodes";

export interface ParsedPagesOk {
    ok: true;
    /** Deduped, sorted, 1-based ORIGINAL page numbers. Empty array = "no
     *  selection sent" (client wants full-doc behaviour). */
    pages: number[];
    /** Client-declared total page count of the source PDF, or null if the
     *  client didn't send it. Used only for the >cap error payload. */
    totalPages: number | null;
}

export interface ParsedPagesFail {
    ok: false;
    code: ErrorCodeT;
    vars?: Record<string, string | number>;
    detail?: string;
}

/** Parse and validate the `pages` (JSON array) and `total_pages` (int) parts
 *  of a multipart form. Rules:
 *    - Both parts are OPTIONAL.
 *    - `pages`, when present, must be a non-empty JSON array of integers,
 *      each ≥ 1, deduped, and its length must be ≤ PAGE_SELECTION_MAX.
 *    - `total_pages`, when present, must be a positive integer, and every
 *      entry of `pages` must be ≤ `total_pages`.
 *    - When `pages` is ABSENT but `total_pages` > PAGE_SELECTION_MAX →
 *      return TOO_MANY_PAGES so the UI can force the user to pick a subset.
 */
export function parseAndValidatePages(
    formData: FormData,
): ParsedPagesOk | ParsedPagesFail {
    const pagesRaw = formData.get("pages");
    const totalRaw = formData.get("total_pages");

    let totalPages: number | null = null;
    if (typeof totalRaw === "string" && totalRaw.trim().length > 0) {
        const n = Number(totalRaw);
        if (!Number.isInteger(n) || n < 1) {
            return { ok: false, code: ErrorCode.BAD_REQUEST, detail: "total_pages must be a positive integer" };
        }
        totalPages = n;
    }

    // No selection sent — enforce the "silently grinding" cap.
    if (typeof pagesRaw !== "string" || pagesRaw.trim().length === 0) {
        if (totalPages !== null && totalPages > PAGE_SELECTION_MAX) {
            return {
                ok: false,
                code: ErrorCode.TOO_MANY_PAGES,
                vars: { limit: PAGE_SELECTION_MAX, actual: totalPages },
            };
        }
        return { ok: true, pages: [], totalPages };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(pagesRaw);
    } catch {
        return { ok: false, code: ErrorCode.BAD_REQUEST, detail: "pages is not valid JSON" };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        return { ok: false, code: ErrorCode.BAD_REQUEST, detail: "pages must be a non-empty array" };
    }
    const seen = new Set<number>();
    const clean: number[] = [];
    for (const p of parsed) {
        if (!Number.isInteger(p) || (p as number) < 1) {
            return { ok: false, code: ErrorCode.BAD_REQUEST, detail: "pages entries must be integers ≥ 1" };
        }
        const n = p as number;
        if (seen.has(n)) continue;
        seen.add(n);
        clean.push(n);
    }
    if (clean.length > PAGE_SELECTION_MAX) {
        return {
            ok: false,
            code: ErrorCode.TOO_MANY_PAGES,
            vars: { limit: PAGE_SELECTION_MAX, actual: clean.length },
        };
    }
    if (totalPages !== null) {
        const overflow = clean.find(p => p > totalPages!);
        if (overflow !== undefined) {
            return {
                ok: false,
                code: ErrorCode.BAD_REQUEST,
                detail: `pages entry ${overflow} exceeds total_pages ${totalPages}`,
            };
        }
    }
    // Keep client's ordering (it matches the stacked-image order) but sort
    // internal comparisons via a copy where needed. We DO NOT re-sort here —
    // if the client wants pages [5, 1, 3] stacked in that order, the model
    // must be told that ordering matches image tile order.
    return { ok: true, pages: clean, totalPages };
}

/** Path A hint remap: a stored `bbox_hint.page` is the ORIGINAL PDF page
 *  number. This returns the 1-based index of that page inside `selection`,
 *  or `null` if the page was dropped from the selection.
 *
 *  Callers that need the stacked-image position (crop helper, prompt hint
 *  block) use this to translate. Callers that just need the original label
 *  (audit logs, "hint refers to page 3 of source") use `hint.page` directly.
 */
export function remapBboxHintPage(
    originalPage: number,
    selection: number[],
): number | null {
    if (selection.length === 0) return originalPage; // no filter applied
    const idx = selection.indexOf(originalPage);
    return idx < 0 ? null : idx + 1;
}

/** Formats a compact human-readable summary for logs / prompt hint block. */
export function describeSelection(selection: number[], totalPages: number | null): string {
    if (selection.length === 0) {
        return totalPages ? `all ${totalPages} pages` : "all pages";
    }
    const total = totalPages ? ` of ${totalPages}` : "";
    return `pages ${selection.join(",")}${total}`;
}
