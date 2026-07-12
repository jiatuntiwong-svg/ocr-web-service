// Phase E — AI rule-manager.
//
// POST /api/templates/rules/curate  body: { templateId }
//   Reads the template's rules, asks AI for suggestions, stores any that
//   reference real rules. Returns the count + the freshly inserted rows.
//
// GET  /api/templates/rules/curate?templateId=X&status=pending
//   List suggestions for the rule browser.
//
// Token-efficient by design: this is a per-template batch call, not per-doc.
// Per the plan we cap to 1 curation/template/day (enforced via "last
// curation" recency on the suggestions table — POST short-circuits if a
// recent run still has pending unreviewed suggestions, unless force=true).

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";
import { getActiveAIConfigs, generateWithAI } from "@/lib/ai-handler";
import { buildCurationPrompt, parseCurationResponse } from "@/lib/rulebase/curationPrompt";

function gated() { return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" }); }

export async function POST(request: NextRequest) {
    if (!ENABLE_TEMPLATE_RULEBASE) return gated();
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    try {
        const body = (await request.json()) as { templateId: string; force?: boolean };
        if (!body.templateId) return fail(ErrorCode.MISSING_FIELDS, { context: "curate" });

        const { env } = await getCloudflareContext();
        const tpl: any = await env.DB.prepare(
            "SELECT id, user_id, name FROM templates WHERE id = ?",
        ).bind(body.templateId).first();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "templates" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        // Rate-limit: skip if there are unreviewed suggestions from the last
        // 24h, unless `force` is set. Saves AI token + avoids duplicate work.
        if (!body.force) {
            const recent: any = await env.DB.prepare(
                `SELECT COUNT(*) AS n FROM rule_suggestions
                 WHERE template_id = ? AND status = 'pending'
                 AND created_at > datetime('now', '-1 day')`,
            ).bind(body.templateId).first();
            if (recent && recent.n > 0) {
                return NextResponse.json({
                    success: true, skipped: true, reason: "recent_pending",
                    pendingCount: recent.n,
                });
            }
        }

        // Load rules
        const rules: any = await env.DB.prepare(
            `SELECT id, type, natural_lang, spec_json, confidence, hit_count, miss_count, last_used_at
             FROM template_rules
             WHERE template_id = ? AND deleted_at IS NULL`,
        ).bind(body.templateId).all();
        const rulesList = (rules.results || []).map((r: any) => ({
            id: r.id,
            type: r.type,
            naturalLang: r.natural_lang || "",
            spec: safeJson(r.spec_json),
            confidence: r.confidence ?? 0.7,
            hit_count: r.hit_count ?? 0,
            miss_count: r.miss_count ?? 0,
            last_used_at: r.last_used_at,
        }));
        if (rulesList.length === 0) {
            return NextResponse.json({ success: true, skipped: true, reason: "no_rules" });
        }

        // Ask AI
        const prompt = buildCurationPrompt({ templateName: tpl.name, rules: rulesList });
        const configs = await getActiveAIConfigs(env);
        if (!configs.length) return fail(ErrorCode.AI_UNAVAILABLE, { context: "no-ai-config" });
        const target = configs[0];
        const apiKeys = configs.filter(c => c.provider === target.provider && c.model === target.model).map(c => c.apiKey);
        const ai = await generateWithAI({ provider: target.provider, model: target.model, prompt, apiKeys });
        const parsed = parseCurationResponse(ai.text);

        // Filter to only suggestions referencing real rules
        const ruleIds = new Set(rulesList.map((r: any) => r.id));
        const valid = parsed.filter(s =>
            s.targetRuleIds.length > 0 &&
            s.targetRuleIds.every(rid => ruleIds.has(rid)),
        );

        // Insert
        const inserted: any[] = [];
        for (const s of valid) {
            const id = crypto.randomUUID();
            await env.DB.prepare(
                `INSERT INTO rule_suggestions
                 (id, template_id, user_id, kind, target_rule_ids, action_json, natural_lang)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
                id, body.templateId, tpl.user_id,
                s.kind, JSON.stringify(s.targetRuleIds),
                JSON.stringify(s.action), s.naturalLang,
            ).run();
            inserted.push({ id, ...s });
        }

        return NextResponse.json({
            success: true,
            generated: inserted.length,
            rawSuggestions: parsed.length,
            usage: ai.usage,
        });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "curate" });
    }
}

export async function GET(request: NextRequest) {
    if (!ENABLE_TEMPLATE_RULEBASE) return gated();
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { searchParams } = new URL(request.url);
    const templateId = searchParams.get("templateId");
    const status = searchParams.get("status") || "pending";
    if (!templateId) return fail(ErrorCode.MISSING_FIELDS, { context: "curate-list" });
    try {
        const { env } = await getCloudflareContext();
        const tpl: any = await env.DB.prepare(
            "SELECT user_id FROM templates WHERE id = ?",
        ).bind(templateId).first();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "templates" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        const rows = await env.DB.prepare(
            `SELECT * FROM rule_suggestions
             WHERE template_id = ? AND status = ?
             ORDER BY created_at DESC LIMIT 50`,
        ).bind(templateId, status).all();
        const parsed = (rows.results || []).map((r: any) => ({
            ...r,
            target_rule_ids: safeJson(r.target_rule_ids) || [],
            action: safeJson(r.action_json) || null,
        }));
        return NextResponse.json(parsed);
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "curate-list" });
    }
}

function safeJson(s: any): any { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } }
