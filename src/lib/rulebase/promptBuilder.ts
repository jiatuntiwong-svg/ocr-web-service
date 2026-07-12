// Rule-generation prompt — Phase C.
//
// Takes a user correction + template context, produces a Gemini prompt that
// asks the model to emit ONE candidate rule as JSON. The prompt is kept
// short on purpose: rules are structured, so we don't need long-form prose.
//
// Schema for each rule type is repeated in the prompt so the model can't
// "forget" required fields between calls. Returns plain string.

interface PromptInput {
    templateName: string;
    templateFields: Array<{ id?: string; name: string; type: string }>;
    correction: {
        fieldKey: string;
        issueType: "wrong_value" | "wrong_field" | "should_ignore";
        wrongValue?: string | null;
        correctValue?: string | null;
        explanation?: string | null;
        paneIdx?: number | null;
    };
}

export function buildRuleGenerationPrompt(input: PromptInput): string {
    const fieldsList = input.templateFields
        .map(f => `- ${f.name} (${f.type})`)
        .join("\n");

    return [
        `You generate ONE structured rule for an OCR/Compare extraction system.`,
        ``,
        `TEMPLATE: ${input.templateName}`,
        `TEMPLATE FIELDS:`,
        fieldsList || "(none)",
        ``,
        `USER CORRECTION:`,
        `- Wrong field: ${input.correction.fieldKey}`,
        `- AI extracted: ${input.correction.wrongValue ?? "(empty)"}`,
        `- Correct value: ${input.correction.correctValue ?? "(empty)"}`,
        `- Issue type: ${input.correction.issueType}`,
        `- Explanation from user: ${input.correction.explanation ?? "(none)"}`,
        ``,
        `OUTPUT FORMAT — JSON ONLY, no prose, no backticks:`,
        `{`,
        `  "type": "extraction" | "alignment" | "comparison" | "validation",`,
        `  "spec": { ...see schemas below... },`,
        `  "naturalLang": "Short human-readable description, in the language used in the user explanation (Thai or English).",`,
        `  "rationale": "1 sentence on why this rule helps."`,
        `}`,
        ``,
        `SCHEMAS by type:`,
        ``,
        `EXTRACTION (most common — use when wrong_value or wrong_field issue):`,
        `  spec = {`,
        `    "match": {`,
        `      "field_value_pattern": "<regex string, optional>",`,
        `      "field_value_unit_indicator": ["KGS","kg",...],`,
        `      "context_keyword": ["near this label",...]`,
        `    },`,
        `    "assert": {`,
        `      "field_target": "<field name as it appears in TEMPLATE FIELDS>",`,
        `      "field_type": "text|number|currency|date|address|email"`,
        `    }`,
        `  }`,
        ``,
        `ALIGNMENT (table row matching across docs):`,
        `  spec = {`,
        `    "match": { "table_field": "<name>", "row_anchor_columns": ["sku","code"] },`,
        `    "assert": { "match_strategy": "hungarian_by_anchor" }`,
        `  }`,
        ``,
        `COMPARISON (tolerance for numeric equality):`,
        `  spec = {`,
        `    "match": { "field_target": "<name>", "field_type": "currency|number" },`,
        `    "assert": { "tolerance_absolute": <num>, "tolerance_percent": <num> }`,
        `  }`,
        ``,
        `VALIDATION (range check):`,
        `  spec = {`,
        `    "match": { "field_target": "<name>", "field_value_range": [min, max] },`,
        `    "assert": { "flag_if_outside": true }`,
        `  }`,
        ``,
        `RULES:`,
        `1. Pick the single most useful rule for this correction.`,
        `2. Reference field names verbatim from TEMPLATE FIELDS.`,
        `3. naturalLang language follows the user's explanation language; default English.`,
        `4. Be specific. Vague rules ("any number → quantity") are forbidden.`,
        `5. If the correction is ambiguous and no good rule can be made, emit:`,
        `   { "type": "extraction", "spec": null, "naturalLang": "...", "rationale": "unable to derive" }`,
        ``,
        `Return JSON now:`,
    ].join("\n");
}

/** Parse model output. Tolerates extra whitespace, leading/trailing prose,
 *  and accidental code fences — we want to recover even when the AI ignores
 *  "no prose". Returns null on unparseable output. */
export function parseRuleResponse(raw: string): {
    type: string;
    spec: any;
    naturalLang: string;
    rationale?: string;
} | null {
    if (!raw) return null;
    // Strip code fences if present.
    let cleaned = raw.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
    // Find first { ... } block.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end < 0 || end < start) return null;
    cleaned = cleaned.slice(start, end + 1);
    try {
        const obj = JSON.parse(cleaned);
        if (!obj || typeof obj !== "object") return null;
        if (typeof obj.type !== "string") return null;
        return {
            type: obj.type,
            spec: obj.spec ?? null,
            naturalLang: typeof obj.naturalLang === "string" ? obj.naturalLang : "",
            rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
        };
    } catch {
        return null;
    }
}
