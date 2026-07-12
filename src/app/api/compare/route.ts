import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logSystemEvent } from "@/lib/logger";
import { generateWithAI, getActiveAIConfigs } from "@/lib/ai-handler";
import { loadRulesForInjection, logRuleConsidered } from "@/lib/rulebase/inject";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";
import { logAiUsage } from "@/lib/ai-usage";
import { loadFeatureFlags, isFeatureEnabled } from "@/lib/tier-config";
import { estimateCredits, actualCredits } from "@/lib/pricing";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
// Semantic normalisation for diff verdicts — see lib/diffNormalize.ts for
// the full ordering (date → arithmetic → numeric-with-unit → fallback).
import { normalizeForDiff, isVerdictMode, type VerdictMode } from "@/lib/diffNormalize";

// NOTE: This route deliberately does NOT do OCR-token matching. The Worker
// returns AI-extracted field values only; the browser does the matchValue→token
// mapping locally (see CompareWorkspace.tsx + src/lib/text-matcher.ts). This
// keeps the Worker's CPU usage well under the Free-plan 10ms budget and avoids
// shipping multi-MB token JSON through the request body.

type CompareField = {
    key: string;
    is_diff: boolean;
    doc1?: string | null;
    doc2?: string | null;
    doc3?: string | null;
    // Minimal exact substrings that differ (AI-provided) — used by the
    // frontend to draw precise highlight boxes instead of matching whole rows.
    doc1_diff?: string[];
    doc2_diff?: string[];
    doc3_diff?: string[];
    // AI-reported per-doc extraction confidence (0–100). Surfaces when the
    // model is unsure — helps the user spot fields that should be reviewed
    // even when is_diff is false.
    doc1_confidence?: number;
    doc2_confidence?: number;
    doc3_confidence?: number;
    // Table-only — set when the selected field's type is 'table'. The AI
    // returns structured rows so the frontend can render a row-by-row diff.
    rows?: { doc1: any[]; doc2: any[]; doc3?: any[] };
    match_key?: string;
};

function sanitizeDiffArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v
        .filter((s): s is string => typeof s === "string")
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .slice(0, 50);
}

function parseSelectedFields(raw: string | null): string[] {
    return (raw || "")
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean);
}

function normalizeFieldKey(value: unknown): string {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

// SHA-256 hex of (concatenated file bytes + JSON of {fields, model})
async function buildCacheKey(buffers: ArrayBuffer[], fields: string[], model: string): Promise<string> {
    // PROMPT_VERSION busts the edge cache whenever the AI prompt schema
    // changes (e.g. adding docN_diff) so stale responses aren't reused.
    // v8 — adds semantic normalize (date/arith/currency/units) at verdict
    // time. Bumps cache key so previously-flagged-as-diff identical-after-
    // normalize values get re-evaluated.
    const PROMPT_VERSION = "v8-semantic-normalize";
    const fieldBytes = new TextEncoder().encode(JSON.stringify({ f: [...fields].sort(), m: model, p: PROMPT_VERSION }));
    let total = fieldBytes.byteLength;
    for (const b of buffers) total += b.byteLength;
    const combined = new Uint8Array(total);
    let off = 0;
    for (const b of buffers) { combined.set(new Uint8Array(b), off); off += b.byteLength; }
    combined.set(fieldBytes, off);
    const digest = await crypto.subtle.digest("SHA-256", combined);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function createEmptyField(key: string, fileCount: number): CompareField {
    return {
        key,
        is_diff: false,
        doc1: null,
        doc2: null,
        ...(fileCount > 2 ? { doc3: null } : {}),
    };
}

function buildPrompt(
    selectedFields: string[],
    fileCount: number,
    fieldTypes: Record<string, string>,
): string {
    const doc3Json = fileCount > 2 ? `,\n      "doc3": "value from document ${fileCount} or null",\n      "doc3_diff": ["exact differing substring(s) in document ${fileCount}"],\n      "doc3_confidence": 90` : "";

    // Annotate table fields in the field list so the model knows which ones
    // need structured rows + match_key.
    const labelledFields = selectedFields.map((f, i) => {
        const key = normalizeFieldKey(f);
        const type = fieldTypes[key];
        return type === "table"
            ? `${i + 1}. ${f}   ← TABLE field (return structured rows, see rule 10)`
            : `${i + 1}. ${f}`;
    }).join("\n");

    return `Compare these ${fileCount} documents only by the fields listed below.

Selected fields:
${labelledFields}

Rules:
1. Return ONLY a JSON object — no markdown, no explanation.
2. "fields" must contain exactly the selected fields above in the same order.
3. Do NOT add extra fields. Do NOT rename fields.
4. Return null when a field is not found in a document.
5. Set is_diff:true ONLY when values are genuinely different between documents.
6. For NON-table fields (text/date/currency/number/address): copy the EXACT text as it appears verbatim in the document (including label prefix if helpful for locating it, e.g. "เงื่อนไขชำระเงิน เครดิต 30 วัน").
   - COMPLETE VALUES ONLY — never truncate or stop mid-word, mid-token, or mid-line. The extracted value must end at a natural boundary: a punctuation mark (period, comma, paren, colon, hyphen), an end of line, an end of paragraph, the start of a new labelled field, or the end of the document. Examples:
     • GOOD: "LAEM CHABANG, THAILAND (KLONGTOEY SHIPPING)"  — paren closed, word complete.
     • BAD:  "LAEM CHABANG, THAILAND (KLONGTOEY SH"  — truncated mid-word "SH..." with unclosed paren.
     • GOOD: "PO-2026-0042"  — full identifier.
     • BAD:  "PO-2026-00"  — number cut short.
   - For values that span multiple lines (multi-line addresses, multi-line remarks), include EVERY continuation line until a different field's label appears. Join lines with a single space or newline as printed.
   - If parentheses or brackets are opened in the value, they MUST be closed in the value too. If you cannot read the closing bracket, omit the opening bracket as well rather than producing an unbalanced fragment.
   - If you are uncertain where a value ends, extend to the next clear boundary (end of line / next label) rather than guessing a midpoint cut.
7. For TABLE fields: see rule 10 below — return STRUCTURED rows as a JSON array, NOT a string. Do NOT collapse table rows into newline-separated text.
8. NEVER return a single digit or 1-2 character string alone as a non-table field "value" — always include enough surrounding context (e.g. product code + amount, not just "5"). EXCEPTION: inside docN_diff for TABLE fields, a changed short cell such as a quantity ("10" vs "12") MUST still be returned as its own array element even if it is only 1-2 characters — it is the exact changed cell used for highlighting.
9. CRITICAL — "docN_diff": for every field where is_diff is true, also return the MINIMAL exact substrings that actually differ, copied VERBATIM exactly as printed in that document, with NO field label and NO unchanged surrounding words. These are used to draw precise highlight boxes.
   - Put ONLY the changed token(s). Example: if doc1 unit price is "500.00" and doc2 is "550.00", then doc1_diff=["500.00"], doc2_diff=["550.00"] — NOT the whole row.
   - For table fields: one array element per changed cell (e.g. ["500.00","10","1,500.00"]) INCLUDING short quantity cells. Do NOT include cells whose value is identical across documents.
   - Each element must appear EXACTLY (character-for-character) in that document so it can be located. Prefer elements ≥ 3 characters.
   - SYMMETRY (mandatory): when is_diff is true you MUST fill docN_diff for EVERY document (doc1_diff AND doc2_diff${fileCount > 2 ? " AND doc3_diff" : ""}) — never one side only. For currency/total/amount fields the diff is just the number itself, e.g. doc1_diff=["79,180.00"], doc2_diff=["79,768.50"] — NEVER the label "ยอดชำระสุทธิ (Grand Total)".
   - If is_diff is false, return docN_diff: [].
10. TABLE fields (marked above) have an EXTENDED response shape — STRICTLY:
    - "docN" MUST be a JSON ARRAY of row OBJECTS. Example:
      "doc1": [
        { "item_code": "A001", "description": "Widget", "qty": "10", "unit_price": "500.00", "total": "5,000.00" },
        { "item_code": "A002", "description": "Bolt",   "qty": "20", "unit_price": "12.50",  "total": "250.00"   }
      ]
    - NEVER return docN as a string for a TABLE field. NEVER return a row-count summary like "5 rows" — return the actual rows.
    - Include EVERY data row from the document, not only the differing ones. Skip pure header rows.
    - Every row in a given doc shares the SAME column keys (use snake_case English keys, e.g. "item_code", "description", "qty", "unit_price", "total").
    - Include a "match_key" string at the field level — the column most suitable
      for pairing rows across docs (e.g. "item_code", "sku", "line_no", "description").
      If no column is reliably unique, set match_key to null.
    - Set is_diff:true when ANY row differs (added/removed/cell change). Use
      docN_diff to list only the CHANGED CELL VALUES (e.g. ["12","144.00"])
      for highlight matching — same rules as scalar fields.

11. CONFIDENCE per doc value: include "docN_confidence" as an integer 0-100
    reflecting how confident you are in the extracted "docN" value.
    - 90-100: clear, unambiguous value
    - 70-89: extracted but with some uncertainty (OCR artifacts, ambiguous label, partial visibility)
    - 50-69: best guess, low certainty
    - 0-49: not found / pure guess (use null for value and 0 confidence)

Response schema:
{
  "summary": ["key difference 1", "key difference 2"],
  "fields": [
    {
      "key": "${selectedFields[0] || "Field Name"}",
      "is_diff": false,
      "doc1": "exact value or null",
      "doc1_diff": ["exact differing substring(s) in document 1"],
      "doc1_confidence": 90,
      "doc2": "exact value or null",
      "doc2_diff": ["exact differing substring(s) in document 2"],
      "doc2_confidence": 90${doc3Json}
    }
  ]
}`;
}

export async function POST(req: NextRequest) {
    let userId = "guest";

    try {
        const auth = await requireUser(req);
        if (auth instanceof Response) return auth;

        const formData = await req.formData();
        const requested = (formData.get("userId") as string) || auth.id;
        const cross = ensureCanActAs(auth, requested);
        if (cross) return cross;
        userId = requested;
        const selectedModelId = (formData.get("selectedModelId") as string) || "";

        const files: File[] = [];
        if (formData.has("file1")) files.push(formData.get("file1") as unknown as File);
        if (formData.has("file2")) files.push(formData.get("file2") as unknown as File);
        if (formData.has("file3")) files.push(formData.get("file3") as unknown as File);

        if (files.length < 2) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "compare" });
        }

        const selectedFieldsRaw = (formData.get("fields") as string | null) || "";
        const selectedFields = parseSelectedFields(selectedFieldsRaw);
        if (selectedFields.length === 0) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "compare" });
        }
        // Phase D — optional template anchor for rule injection. Stays null
        // when the caller (legacy clients, no-template compares) doesn't
        // provide one; rule injection helper short-circuits in that case.
        const templateId = (formData.get("templateId") as string | null) || null;

        // Verdict mode — selectable per run. Default "smart" preserves the
        // current behaviour for callers that don't send the field.
        const modeRaw = (formData.get("verdictMode") as string | null)?.trim().toLowerCase();
        const verdictMode: VerdictMode = isVerdictMode(modeRaw) ? modeRaw : "smart";

        const fieldTypes: Record<string, string> = {};
        const cleanSelectedFields = selectedFields.map(f => {
            const match = f.match(/^(.*?)\s*\((.*?)\)$/);
            if (match) {
                const name = match[1].trim();
                fieldTypes[normalizeFieldKey(name)] = match[2].trim().toLowerCase();
                return name;
            }
            return f;
        });

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "compare" });
        }

        // ─── Feature gate — Compare must be enabled for the caller's tier ───
        let callerPlan = "free";
        if (userId !== "guest") {
            const u = await env.DB.prepare("SELECT plan FROM users WHERE id = ?")
                .bind(userId).first<{ plan: string }>();
            if (u?.plan) callerPlan = u.plan;
        }
        const featureFlags = await loadFeatureFlags(env);
        if (!isFeatureEnabled(featureFlags, callerPlan, "compare")) {
            return fail(ErrorCode.FEATURE_DISABLED, { context: "compare" });
        }

        const finalConfigs = await getActiveAIConfigs(env);
        let target = finalConfigs.find((config) => config.id === selectedModelId);
        if (!target) target = finalConfigs.find((config) => config.model.includes("pro")) || finalConfigs[0];

        if (!target) {
            return fail(ErrorCode.AI_UNAVAILABLE, { context: "compare" });
        }

        const matchingKeys = finalConfigs
            .filter((config) => config.provider === target.provider && config.model === target.model)
            .map((config) => config.apiKey);

        let prompt = buildPrompt(cleanSelectedFields, files.length, fieldTypes);
        // Phase D: inject template rules from prior corrections (when flag on).
        // Helper short-circuits when templateId is null or no rules exist —
        // safe to call unconditionally.
        const ruleInject = ENABLE_TEMPLATE_RULEBASE
            ? await loadRulesForInjection(env, templateId, cleanSelectedFields)
            : { rules: [], promptBlock: "" };
        if (ruleInject.promptBlock) prompt += "\n\n" + ruleInject.promptBlock;

        // ─── Edge cache lookup ─────────────────────────────────────────────
        // Identical (files + selected fields + model) → return cached AI body.
        // Saves AI quota AND skips credit charge (no AI call was made).
        // verdictMode is deliberately NOT part of the cache key — it only
        // affects the post-AI override step, so the same cached AI JSON can
        // serve both strict and smart runs.
        const fileBuffers = await Promise.all(files.map(f => f.arrayBuffer()));
        const cacheKey = await buildCacheKey(fileBuffers, cleanSelectedFields, target.model);
        const cacheUrl = `https://compare-cache.internal/v1/${cacheKey}`;
        const cf = (globalThis as any).caches?.default;
        let aiText: string | null = null;
        let aiUsage = { inputTokens: 0, outputTokens: 0 };
        let fromCache = false;
        if (cf) {
            try {
                const hit = await cf.match(cacheUrl);
                if (hit) { aiText = await hit.text(); fromCache = true; }
            } catch (_) { /* cache miss is fine */ }
        }

        // ─── Pre-authorize credit (cache miss only) ────────────────────────
        // Cheap availability check BEFORE spending an AI call. ACTUAL charge
        // happens only AFTER a successful AI parse (see below). Failed/garbled
        // AI responses never cost the user a credit.
        const compareEstimate = estimateCredits({
            operation: "compare",
            fields: cleanSelectedFields.length,
            numDocs: files.length,
        });
        if (!fromCache && userId !== "guest") {
            const u = await env.DB.prepare(
                "SELECT credits_remaining + extra_credits AS remaining FROM users WHERE id = ?"
            ).bind(userId).first<{ remaining: number }>();
            if (!u) return fail(ErrorCode.USER_NOT_FOUND, { context: "compare" });
            if (u.remaining < compareEstimate.credits) {
                return fail(ErrorCode.INSUFFICIENT_CREDITS, {
                    vars: { need: compareEstimate.credits, have: u.remaining },
                    context: "compare",
                });
            }
        }

        // ─── Call AI on cache miss ─────────────────────────────────────────
        const startTime = Date.now();
        if (!fromCache) {
            const imagesData = files.map((file, i) => ({
                data: Buffer.from(fileBuffers[i]).toString("base64"),
                mimeType: file.type || "image/jpeg",
            }));
            const ai = await generateWithAI({
                provider: target.provider,
                model: target.model,
                prompt,
                images: imagesData,
                apiKeys: matchingKeys,
            });
            aiText = ai.text;
            aiUsage = ai.usage;
        }
        const text = aiText || "";
        const processingTimeMs = Date.now() - startTime;

        const extracted: { summary: string[]; fields: CompareField[] } = { summary: [], fields: [] };
        const fieldMap = new Map<string, CompareField>();

        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                throw new Error("AI returned invalid format");
            }

            const parsed = JSON.parse(match[0]);
            const aiFields = Array.isArray(parsed?.fields)
                ? parsed.fields
                : Array.isArray(parsed?.differences)
                    ? parsed.differences
                    : [];

            if (Array.isArray(parsed?.summary)) {
                extracted.summary = parsed.summary.filter((item: unknown) => typeof item === "string");
            }

            for (const field of aiFields) {
                const normalizedKey = normalizeFieldKey(field?.key);
                const selectedKey = cleanSelectedFields.find((item) => normalizeFieldKey(item) === normalizedKey)
                                 || selectedFields.find((item) => normalizeFieldKey(item) === normalizedKey);
                if (!selectedKey) continue;

                // For table fields, the AI returns docN as JSON arrays of row
                // objects. Pull those out into `rows` and keep `doc1` as a
                // short text summary so existing scalar-display code paths
                // still work.
                const isTableField = fieldTypes[normalizeFieldKey(selectedKey)] === "table";
                let parsedRows: { doc1: any[]; doc2: any[]; doc3?: any[] } | undefined;
                let matchKey: string | undefined;
                let doc1Summary = field?.doc1;
                let doc2Summary = field?.doc2;
                let doc3Summary = field?.doc3;

                if (isTableField) {
                    // Defensive parse — AI sometimes returns a JSON-encoded
                    // string or newline-joined text instead of an array even
                    // when the prompt says "array". Try to recover before
                    // declaring the table empty.
                    const coerceRows = (v: any): any[] => {
                        if (Array.isArray(v)) return v;
                        if (typeof v === "string" && v.trim()) {
                            try {
                                const parsed = JSON.parse(v);
                                if (Array.isArray(parsed)) return parsed;
                            } catch { /* fall through */ }
                            // Last resort: split into rows with a single "text" column
                            // so the user at least sees the raw lines.
                            return v.split(/\r?\n/)
                                .map(line => line.trim())
                                .filter(line => line.length > 0)
                                .map(line => ({ text: line }));
                        }
                        return [];
                    };
                    const rows1 = coerceRows(field?.doc1);
                    const rows2 = coerceRows(field?.doc2);
                    const rows3 = files.length > 2 ? coerceRows(field?.doc3) : undefined;
                    parsedRows = { doc1: rows1, doc2: rows2, ...(rows3 ? { doc3: rows3 } : {}) };
                    matchKey = typeof field?.match_key === "string" && field.match_key.trim() ? field.match_key.trim() : undefined;
                    // Compact text summary for legacy display: row counts.
                    doc1Summary = `${rows1.length} rows`;
                    doc2Summary = `${rows2.length} rows`;
                    if (rows3) doc3Summary = `${rows3.length} rows`;
                }

                const clampConf = (v: any): number | undefined => {
                    const n = Number(v);
                    if (!Number.isFinite(n)) return undefined;
                    return Math.max(0, Math.min(100, Math.round(n)));
                };

                fieldMap.set(selectedKey, {
                    key: selectedKey,
                    is_diff: Boolean(field?.is_diff),
                    doc1: doc1Summary ?? null,
                    doc2: doc2Summary ?? null,
                    doc1_diff: sanitizeDiffArray(field?.doc1_diff),
                    doc2_diff: sanitizeDiffArray(field?.doc2_diff),
                    doc1_confidence: clampConf(field?.doc1_confidence),
                    doc2_confidence: clampConf(field?.doc2_confidence),
                    ...(files.length > 2
                        ? {
                            doc3: doc3Summary ?? null,
                            doc3_diff: sanitizeDiffArray(field?.doc3_diff),
                            doc3_confidence: clampConf(field?.doc3_confidence),
                        }
                        : {}),
                    ...(parsedRows ? { rows: parsedRows } : {}),
                    ...(matchKey ? { match_key: matchKey } : {}),
                });
            }
        } catch (error: any) {
            // AI failed/garbled — no charge, no cache (we never reached them).
            // Detail logged server-side; client gets a generic AI-failed marker only.
            console.error("[compare] AI parse failed:", error?.message, "raw:", text?.slice(0, 500));
            return fail(ErrorCode.AI_FAILED, { detail: error, context: "compare-parse" });
        }

        // ─── Charge credit + cache the response (cache miss + valid parse) ──
        // Reaching here means the AI returned AND parsed successfully, so the
        // user is billed only for a usable result, and only a VALID response
        // is cached (a transient bad reply can't poison the edge cache 24h).
        if (!fromCache) {
            if (userId !== "guest") {
                const charge = compareEstimate.credits;
                const charged = await env.DB.prepare(
                    `UPDATE users SET
                        credits_remaining = MAX(0, credits_remaining - ?1),
                        extra_credits     = extra_credits - MAX(0, ?1 - credits_remaining)
                     WHERE id = ?2 AND (credits_remaining + extra_credits) >= ?1
                     RETURNING credits_remaining + extra_credits AS remaining`
                ).bind(charge, userId).first<{ remaining: number }>();
                if (!charged) {
                    // Credits drained by a concurrent request between the
                    // pre-check and here (rare race) — don't hand back or
                    // cache a result the user hasn't paid for.
                    return fail(ErrorCode.INSUFFICIENT_CREDITS, {
                        vars: { need: compareEstimate.credits, have: 0 },
                        context: "compare-race",
                    });
                }
            }
            if (cf && aiText) {
                try {
                    const cacheRes = new Response(aiText, {
                        headers: {
                            "Content-Type": "text/plain",
                            "Cache-Control": "public, max-age=86400",
                        },
                    });
                    await cf.put(cacheUrl, cacheRes);
                } catch (_) { /* non-fatal */ }
            }
            // Record AI token usage for the admin cost dashboard.
            await logAiUsage(env, {
                userId, fn: "compare",
                provider: target.provider, model: target.model,
                inputTokens: aiUsage.inputTokens, outputTokens: aiUsage.outputTokens,
                fileName: `${files.length} docs · ${cleanSelectedFields.length} fields`,
            });
        }

        extracted.fields = cleanSelectedFields.map((fieldKey) => {
            const existing = fieldMap.get(fieldKey) || fieldMap.get(selectedFields[cleanSelectedFields.indexOf(fieldKey)]) || createEmptyField(fieldKey, files.length);
            const values = [existing.doc1, existing.doc2, files.length > 2 ? existing.doc3 : undefined]
                .filter((value) => value !== undefined);
            const nonNullValues = values.filter((value) => value !== null);
            // Table-type fields have arrays/objects as values — skip the
            // string-normalisation override; row-level diff handles those.
            const isTableField = nonNullValues.some(v => typeof v === "object");

            // Use normalised equality so trivial formatting differences
            // ("LAEM CHABANG, THAILAND" with and without trailing space, case
            // changes, currency symbols, thousands separators) aren't flagged
            // as diffs. This overrides the AI's is_diff when values are
            // genuinely identical after normalisation — fixes the case where
            // AI flags identical strings as different.
            let isDiff: boolean;
            if (isTableField) {
                isDiff = nonNullValues.length > 1 && new Set(nonNullValues).size > 1;
            } else {
                const normalised = nonNullValues.map(v => normalizeForDiff(v, verdictMode));
                isDiff = nonNullValues.length > 1 && new Set(normalised).size > 1;
            }

            // Trust normalised equality over the AI verdict for non-table
            // fields: if values are identical post-normalisation, force
            // is_diff=false and drop any diff-fragment arrays the AI returned.
            const overrideToSame = !isTableField && nonNullValues.length > 1 && !isDiff;
            const cleared = overrideToSame
                ? { doc1_diff: [] as string[], doc2_diff: [] as string[], ...(files.length > 2 ? { doc3_diff: [] as string[] } : {}) }
                : {};

            return {
                ...createEmptyField(fieldKey, files.length),
                ...existing,
                key: fieldKey,
                is_diff: overrideToSame ? false : (existing.is_diff || isDiff),
                ...cleared,
            };
        });

        // ─── Post-adjust credits using actual table row counts ──────────────
        // For runs that hit AI (not cache), recompute the credit cost now that
        // we know how many rows landed in each table field. If the actual is
        // higher than the estimate we charged at upload time, deduct the
        // supplement; otherwise the estimate stands.
        let actualCreditsUsed = fromCache ? 0 : compareEstimate.credits;
        if (!fromCache && userId !== "guest") {
            // Sum row counts across ALL table fields, per doc index.
            const rowsPerDoc: number[] = [0, 0, ...(files.length > 2 ? [0] : [])];
            for (const f of extracted.fields) {
                if (!f.rows) continue;
                rowsPerDoc[0] += f.rows.doc1?.length || 0;
                rowsPerDoc[1] += f.rows.doc2?.length || 0;
                if (rowsPerDoc.length > 2 && f.rows.doc3) {
                    rowsPerDoc[2] += f.rows.doc3.length || 0;
                }
            }
            const hasTableRows = rowsPerDoc.some(n => n > 0);
            if (hasTableRows) {
                const adjusted = actualCredits({
                    operation: "compare",
                    fields: cleanSelectedFields.length,
                    numDocs: files.length,
                    tableRowCountsPerDoc: rowsPerDoc,
                });
                if (adjusted.credits > compareEstimate.credits) {
                    const delta = adjusted.credits - compareEstimate.credits;
                    await env.DB.prepare(
                        `UPDATE users SET
                            credits_remaining = MAX(0, credits_remaining - ?1),
                            extra_credits     = extra_credits - MAX(0, ?1 - credits_remaining)
                         WHERE id = ?2`
                    ).bind(delta, userId).run().catch(() => { /* best-effort supplement */ });
                    actualCreditsUsed = adjusted.credits;
                }
            }
        }

        // Fire-and-forget logging — don't await so we save CPU + a subrequest
        logSystemEvent(env, "DOCUMENT_COMPARE",
            `Compared ${files.length} docs, ${selectedFields.length} fields${fromCache ? " (cache hit)" : ""}.`,
            "info", userId
        ).catch(() => { /* non-fatal */ });

        // Record the compare run in `documents` (type='compare') so it shows in
        // the dashboard Recent Activity and can be re-downloaded later. Stores
        // the field values only (enough to re-export). MUST be awaited — an
        // un-awaited promise is dropped once the Worker returns the response.
        if (userId !== "guest") {
            try {
                const compareLabel = "เปรียบเทียบ: " +
                    files.map(f => f.name).join(" / ").slice(0, 160);
                await env.DB.prepare(
                    `INSERT INTO documents (id, user_id, file_name, status, raw_json, processing_time_ms, type, credits_used)
                     VALUES (?, ?, ?, 'completed', ?, ?, 'compare', ?)`
                ).bind(
                    crypto.randomUUID(), userId, compareLabel,
                    JSON.stringify({ summary: extracted.summary, fields: extracted.fields }),
                    processingTimeMs,
                    actualCreditsUsed,
                ).run();
            } catch (e) {
                console.error("[Compare] failed to log run to documents:", e);
            }
        }

        // Phase D: log every considered rule + return summary to client so
        // it can render "rule fired" badges. Fire-and-forget on the log side
        // (caller doesn't need to wait), but pass IDs synchronously so the
        // response carries them.
        if (ruleInject.rules.length) {
            logRuleConsidered(env, ruleInject.rules.map(r => r.id), null)
                .catch(() => { /* non-fatal */ });
        }

        return ok({
            success: true,
            processing_time_ms: processingTimeMs,
            from_cache: fromCache,
            extracted_data: extracted,
            credits_used: actualCreditsUsed,
            credits_estimate: compareEstimate.credits,
            rules_applied: ruleInject.rules.map(r => ({
                id: r.id,
                type: r.type,
                naturalLang: r.naturalLang,
                target: r.target ?? null,
            })),
        });
    } catch (error: any) {
        try {
            const { env } = await getCloudflareContext();
            if (env) {
                await logSystemEvent(env, "COMPARE_ERROR", error.message, "error", userId);
            }
        } catch (_) {
            // logging failure must not prevent the JSON error response
        }
        return fail(ErrorCode.PROCESSING_FAILED, { detail: error, context: "compare" });
    }
}
