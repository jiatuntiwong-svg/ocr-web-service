// Rule injection — Phase D.
//
// Given a template + the fields being requested in this run, fetch the
// rules attached to that template, score them by relevance, and emit the
// top-K as a structured "TEMPLATE RULES" block ready to be appended to the
// extraction/compare prompt. Logs each considered rule into rule_applications
// so Phase E (curation) has signal for confidence decay.
//
// Token efficiency note: we cap selected rules at MAX_RULES and total prompt
// addition at MAX_CHARS, so a runaway rule set never doubles AI cost.

const MAX_RULES = 10;
const MAX_CHARS = 2400; // rough upper bound for the injected block

export interface InjectedRule {
    id: string;
    type: string;
    naturalLang: string;
    spec: any;
    target?: string | null;
}

export interface InjectResult {
    rules: InjectedRule[];
    promptBlock: string;
}

/** Pick rules whose declared target field overlaps with the fields being
 *  extracted in this run. Falls back to "include all" when no rule has a
 *  target (e.g. alignment-only rules that apply globally to the template). */
function selectRelevant(rules: InjectedRule[], selectedFields: string[]): InjectedRule[] {
    if (rules.length === 0) return [];
    const targetSet = new Set(selectedFields.map(s => s.toLowerCase()));
    const tagged = rules.map(r => {
        const tgt = (r.target || "").toLowerCase();
        const relevant = tgt && targetSet.has(tgt);
        // Heuristic score: direct field match > alignment (always relevant) > others
        let score = 0;
        if (relevant) score += 100;
        if (r.type === "alignment") score += 50;
        if (r.type === "comparison") score += 30;
        return { r, score };
    });
    tagged.sort((a, b) => b.score - a.score);
    return tagged.slice(0, MAX_RULES).map(x => x.r);
}

/** Build the prompt block that gets appended after the existing rules in
 *  buildPrompt. Plain English/Thai-bilingual text from natural_lang fields. */
export function formatRulesBlock(selected: InjectedRule[]): string {
    if (selected.length === 0) return "";
    const lines: string[] = [];
    lines.push("");
    lines.push("TEMPLATE RULES (learned from prior user corrections — apply STRICTLY):");
    let count = 0;
    for (const r of selected) {
        const line = `${count + 1}. [${r.type}] ${r.naturalLang || JSON.stringify(r.spec).slice(0, 120)}`;
        if (lines.join("\n").length + line.length > MAX_CHARS) break;
        lines.push(line);
        count++;
    }
    if (count < selected.length) {
        lines.push(`(+ ${selected.length - count} more rules truncated for length)`);
    }
    lines.push("Honor these rules over generic interpretation. If a rule conflicts with the document, prefer the rule and explain via docN_confidence.");
    return lines.join("\n");
}

/** Load + format rules for a template. Returns empty result when rulebase
 *  is disabled or no rules exist — caller plugs the block in unconditionally. */
export async function loadRulesForInjection(
    env: any,
    templateId: string | null,
    selectedFields: string[],
): Promise<InjectResult> {
    if (!templateId) return { rules: [], promptBlock: "" };
    try {
        const rows = await env.DB.prepare(
            `SELECT id, type, spec_json, natural_lang
             FROM template_rules
             WHERE template_id = ? AND deleted_at IS NULL AND enabled = 1`,
        ).bind(templateId).all();
        const all: InjectedRule[] = (rows.results || []).map((r: any) => {
            const spec = safeJson(r.spec_json);
            const target = spec?.assert?.field_target || spec?.match?.field_target || spec?.match?.table_field || null;
            return { id: r.id, type: r.type, naturalLang: r.natural_lang || "", spec, target };
        });
        const selected = selectRelevant(all, selectedFields);
        return { rules: selected, promptBlock: formatRulesBlock(selected) };
    } catch (e) {
        console.warn("[rulebase-inject] load failed", e);
        return { rules: [], promptBlock: "" };
    }
}

/** Best-effort batch insert into rule_applications. Fire-and-forget;
 *  swallows errors so a logging blip never kills the user's Compare. */
export async function logRuleConsidered(
    env: any,
    ruleIds: string[],
    documentId: string | null,
): Promise<void> {
    if (!ruleIds.length) return;
    try {
        // D1 doesn't support bulk INSERT VALUES well in prepared form for
        // dynamic-length arrays, so do a small Promise.all of single inserts.
        // Volumes are tiny (≤ MAX_RULES per request).
        await Promise.all(ruleIds.map(rid => {
            const id = crypto.randomUUID();
            return env.DB.prepare(
                "INSERT INTO rule_applications (id, rule_id, document_id, fired) VALUES (?, ?, ?, 0)",
            ).bind(id, rid, documentId).run();
        }));
        // Update last_used_at for each rule (fire-and-forget).
        const now = new Date().toISOString();
        await Promise.all(ruleIds.map(rid =>
            env.DB.prepare(
                "UPDATE template_rules SET last_used_at = ? WHERE id = ?",
            ).bind(now, rid).run(),
        ));
    } catch (e) {
        console.warn("[rulebase-inject] log considered failed", e);
    }
}

function safeJson(s: any): any { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } }
