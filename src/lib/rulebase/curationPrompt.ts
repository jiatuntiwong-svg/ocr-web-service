// AI curation prompt — Phase E.
//
// Periodically (or on user "Curate now") we feed the entire rule set for a
// template back to the AI and ask it to flag:
//   - exact / near-duplicates
//   - conflicts (same target, contradicting behavior)
//   - overgeneralizations (rules so broad they fire on unrelated values)
//   - merge opportunities (two rules that could become one cleaner rule)
//   - retire candidates (rules with low confidence + recent misses)
//
// Output is a JSON array of suggestion objects. User reviews → applies.

interface RuleLite {
    id: string;
    type: string;
    naturalLang: string;
    spec: any;
    confidence: number;
    hit_count: number;
    miss_count: number;
    last_used_at: string | null;
}

interface CurationInput {
    templateName: string;
    rules: RuleLite[];
}

export function buildCurationPrompt(input: CurationInput): string {
    const lines: string[] = [];
    lines.push("You are the rule-manager AI for an OCR/Compare extraction system.");
    lines.push("Your job: scan a template's rule set and surface issues + improvements.");
    lines.push("");
    lines.push(`TEMPLATE: ${input.templateName}`);
    lines.push(`RULES (${input.rules.length}):`);
    for (const r of input.rules) {
        const acc = r.hit_count + r.miss_count > 0
            ? Math.round((r.hit_count / (r.hit_count + r.miss_count)) * 100) + "%"
            : "—";
        lines.push(
            `- id=${r.id} type=${r.type} conf=${(r.confidence * 100).toFixed(0)}%` +
            ` hits=${r.hit_count} misses=${r.miss_count} acc=${acc} | ${r.naturalLang || JSON.stringify(r.spec).slice(0, 100)}`,
        );
    }
    lines.push("");
    lines.push("Find ANY of these issue types in the rule set:");
    lines.push("- duplicate: two rules saying essentially the same thing");
    lines.push("- conflict: rules with the same target but contradicting behavior");
    lines.push("- overgeneralization: rule scope is too broad / vague");
    lines.push("- merge: two adjacent rules can become one cleaner rule");
    lines.push("- retire: low-confidence, low-hit rule that's likely harmful");
    lines.push("");
    lines.push("OUTPUT — JSON ARRAY ONLY, NO PROSE, NO CODE FENCES:");
    lines.push(`[
  {
    "kind": "duplicate" | "conflict" | "overgeneralization" | "merge" | "retire",
    "targetRuleIds": ["rule-id-1", "rule-id-2"],
    "action": {
      "op": "disable" | "delete" | "replace" | "merge",
      "keepRuleId": "<id to keep, for replace/merge>",
      "newSpec": { ... } (optional, only when op is 'replace' or 'merge'),
      "newNaturalLang": "<new description>"
    },
    "naturalLang": "Short reason in same language as the rule (TH or EN)."
  }
]`);
    lines.push("");
    lines.push("Constraints:");
    lines.push("- Return at most 8 suggestions. Pick the most useful.");
    lines.push("- If NOTHING is wrong with the set, return [].");
    lines.push("- targetRuleIds must reference IDs from the list above (verbatim).");
    lines.push("- newSpec MUST follow the rule schemas (extraction/alignment/comparison/validation).");
    lines.push("");
    lines.push("Respond now:");
    return lines.join("\n");
}

export function parseCurationResponse(raw: string): Array<{
    kind: string;
    targetRuleIds: string[];
    action: any;
    naturalLang: string;
}> {
    if (!raw) return [];
    let cleaned = raw.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end < 0 || end < start) return [];
    cleaned = cleaned.slice(start, end + 1);
    try {
        const arr = JSON.parse(cleaned);
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((x: any) =>
                x && typeof x === "object" &&
                typeof x.kind === "string" &&
                Array.isArray(x.targetRuleIds) &&
                x.action && typeof x.action === "object",
            )
            .map((x: any) => ({
                kind: x.kind,
                targetRuleIds: x.targetRuleIds.filter((id: any) => typeof id === "string"),
                action: x.action,
                naturalLang: typeof x.naturalLang === "string" ? x.naturalLang : "",
            }));
    } catch {
        return [];
    }
}
