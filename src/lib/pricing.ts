// Credit pricing for OCR and Compare operations.
//
// The formulas are intentionally simple so the UI can show user-facing
// breakdowns without server round-trips:
//
//   ocrFactor       = 1 + max(0, fields − 10) × 0.1
//   ocrCredits      = max(1, ceil(ocrFactor × modelMult))
//   compareCredits  = max(2, ceil(ocrFactor × numDocs × 1.5 × tableRowFactor × modelMult))
//
// `tableRowFactor` is only known AFTER the AI returns (we count rows in the
// table-typed fields). Pre-run code uses 1.0 (i.e. it assumes ≤10 rows);
// post-run code adds the row factor on top and charges any supplement.
//
//   tableRowFactor  = 1 + max(0, avgRowsPerDoc − 10) × 0.05
//
// All credits are integers, rounded UP via `ceil` so users never see fractional
// charges and we never underbill on edge cases.

export type Operation = "ocr" | "compare";

export interface PricingInput {
    operation: Operation;
    /** Number of extraction fields the user selected. */
    fields: number;
    /** Number of documents (Compare). Ignored for OCR. */
    numDocs?: number;
    /** Multiplier applied per AI model/tier. Default 1.0. */
    modelMult?: number;
}

export interface PricingActualInput extends PricingInput {
    /**
     * Row counts for table-typed fields, per document. Used to compute
     * `tableRowFactor`. Example: 2 docs with one `table` field that has
     * [25, 30] rows → `[25, 30]`. Multiple table fields sum together per doc.
     * Omit when no table fields are present.
     */
    tableRowCountsPerDoc?: number[];
}

export interface CreditBreakdown {
    credits: number;
    /** Human-readable steps so the UI can render a receipt. */
    steps: { label: string; value: string }[];
    /** Raw factors used — handy for debugging and unit tests. */
    factors: {
        ocrFactor: number;
        numDocs: number;
        compareOverhead: number;
        tableRowFactor: number;
        modelMult: number;
    };
}

const COMPARE_OVERHEAD = 1.5;
const OCR_MIN = 1;
const COMPARE_MIN = 2;

function fieldFactor(fields: number): number {
    return 1 + Math.max(0, fields - 10) * 0.1;
}

function rowFactor(rowsPerDoc: number[] | undefined, numDocs: number): number {
    if (!rowsPerDoc?.length || numDocs <= 0) return 1;
    const total = rowsPerDoc.reduce((a, b) => a + b, 0);
    const avg = total / numDocs;
    return 1 + Math.max(0, avg - 10) * 0.05;
}

/**
 * Pre-run estimate — table row counts unknown, so `tableRowFactor` = 1.0.
 * Use this to show the user a number BEFORE the AI runs and to reserve
 * credits from their balance.
 */
export function estimateCredits(input: PricingInput): CreditBreakdown {
    const mult = input.modelMult ?? 1;
    const fF = fieldFactor(input.fields);

    if (input.operation === "ocr") {
        const raw = fF * mult;
        const credits = Math.max(OCR_MIN, Math.ceil(raw));
        return {
            credits,
            steps: [
                { label: "Base + fields",        value: fF.toFixed(2) },
                ...(mult !== 1 ? [{ label: "× Model",     value: `× ${mult}` }] : []),
                { label: "Total (ceil)",         value: String(credits) },
            ],
            factors: { ocrFactor: fF, numDocs: 1, compareOverhead: 1, tableRowFactor: 1, modelMult: mult },
        };
    }

    const docs = input.numDocs ?? 2;
    const raw = fF * docs * COMPARE_OVERHEAD * mult;
    const credits = Math.max(COMPARE_MIN, Math.ceil(raw));
    return {
        credits,
        steps: [
            { label: "OCR cost per doc",     value: fF.toFixed(2) },
            { label: "× Docs",               value: `× ${docs}` },
            { label: "× Compare overhead",   value: `× ${COMPARE_OVERHEAD}` },
            ...(mult !== 1 ? [{ label: "× Model", value: `× ${mult}` }] : []),
            { label: "Total (ceil)",         value: String(credits) },
        ],
        factors: { ocrFactor: fF, numDocs: docs, compareOverhead: COMPARE_OVERHEAD, tableRowFactor: 1, modelMult: mult },
    };
}

/**
 * Post-run actual — uses table row counts to compute `tableRowFactor`.
 * Backend calls this AFTER the AI returns to write the final
 * `documents.credits_used` and charge any supplement above the estimate.
 */
export function actualCredits(input: PricingActualInput): CreditBreakdown {
    const mult = input.modelMult ?? 1;
    const fF = fieldFactor(input.fields);
    const docs = input.numDocs ?? (input.operation === "ocr" ? 1 : 2);
    const rF = rowFactor(input.tableRowCountsPerDoc, docs);

    if (input.operation === "ocr") {
        // Tables in OCR don't currently get a row factor — keep parity with
        // estimate so receipts always match for OCR. (Add when we observe
        // OCR token cost scaling with table size.)
        return estimateCredits(input);
    }

    const raw = fF * docs * COMPARE_OVERHEAD * rF * mult;
    const credits = Math.max(COMPARE_MIN, Math.ceil(raw));
    const steps: { label: string; value: string }[] = [
        { label: "OCR cost per doc",     value: fF.toFixed(2) },
        { label: "× Docs",               value: `× ${docs}` },
        { label: "× Compare overhead",   value: `× ${COMPARE_OVERHEAD}` },
    ];
    if (rF !== 1) steps.push({ label: `× Table rows (avg ${(input.tableRowCountsPerDoc!.reduce((a, b) => a + b, 0) / docs).toFixed(0)})`, value: `× ${rF.toFixed(2)}` });
    if (mult !== 1) steps.push({ label: "× Model", value: `× ${mult}` });
    steps.push({ label: "Total (ceil)", value: String(credits) });

    return {
        credits,
        steps,
        factors: { ocrFactor: fF, numDocs: docs, compareOverhead: COMPARE_OVERHEAD, tableRowFactor: rF, modelMult: mult },
    };
}

/**
 * Tier colour for a given credit count — used by the chip/badge in the UI
 * so the user can eyeball cost magnitude at a glance.
 *   ≤1  → green   "normal"
 *   2–3 → green   "normal"
 *   4–5 → amber   "elevated"
 *   6–9 → orange  "high"
 *   ≥10 → red     "very high"
 */
export function creditTone(credits: number): "green" | "amber" | "orange" | "red" {
    if (credits <= 3) return "green";
    if (credits <= 5) return "amber";
    if (credits <= 9) return "orange";
    return "red";
}
