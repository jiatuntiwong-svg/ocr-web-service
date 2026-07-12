// Template Rulebase — list + create endpoints.
//
// Phase A goal: surface rules so the read-only viewer can render them and the
// future Phase C generator has a stable contract to write into. Phases that
// land later (capture, generation, injection) will reuse the same shapes.
//
// Auth: requireUser + ensureCanActAs — rules are owned by template owner so
// a cross-user read/write is rejected upstream.
// Feature flag: ENABLE_TEMPLATE_RULEBASE — when false the endpoints respond
// 404 so the surface area doesn't leak.

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

const VALID_TYPES = new Set(["extraction", "alignment", "comparison", "validation"]);

function gated() {
    return fail(ErrorCode.NOT_FOUND, { context: "rulebase-disabled" });
}

export async function GET(request: NextRequest) {
    if (!ENABLE_TEMPLATE_RULEBASE) return gated();
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    const { searchParams } = new URL(request.url);
    const templateId = searchParams.get("templateId");
    if (!templateId) return fail(ErrorCode.MISSING_FIELDS, { context: "rules-list" });
    try {
        const { env } = await getCloudflareContext();
        // Ownership check: only the template owner can read its rules.
        const tpl = await env.DB.prepare(
            "SELECT user_id FROM templates WHERE id = ?",
        ).bind(templateId).first<{ user_id: string }>();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "templates" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        const rows = await env.DB.prepare(
            `SELECT id, template_id, user_id, type, spec_json, natural_lang, source,
                    confidence, hit_count, miss_count, enabled,
                    created_at, updated_at, last_used_at
             FROM template_rules
             WHERE template_id = ? AND deleted_at IS NULL
             ORDER BY type, created_at DESC`,
        ).bind(templateId).all();

        // Pre-parse spec_json so the client doesn't double-decode in render.
        const parsed = (rows.results || []).map((r: any) => ({
            ...r,
            spec: safeJson(r.spec_json),
            enabled: r.enabled === 1,
        }));
        return NextResponse.json(parsed);
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "rules-list" });
    }
}

export async function POST(request: NextRequest) {
    if (!ENABLE_TEMPLATE_RULEBASE) return gated();
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;
    try {
        const body = (await request.json()) as {
            templateId: string;
            type: string;
            spec: any;
            naturalLang?: string;
            source?: "user" | "ai_generated" | "system";
            confidence?: number;
            derivedFromCorrectionId?: string;
        };
        if (!body.templateId || !body.type || !body.spec) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "rules-create" });
        }
        if (!VALID_TYPES.has(body.type)) {
            return fail(ErrorCode.BAD_REQUEST, { context: "rules-create-type" });
        }
        const { env } = await getCloudflareContext();
        const tpl = await env.DB.prepare(
            "SELECT user_id FROM templates WHERE id = ?",
        ).bind(body.templateId).first<{ user_id: string }>();
        if (!tpl) return fail(ErrorCode.NOT_FOUND, { context: "templates" });
        const cross = ensureCanActAs(auth, tpl.user_id);
        if (cross) return cross;

        const id = crypto.randomUUID();
        await env.DB.prepare(
            `INSERT INTO template_rules
             (id, template_id, user_id, type, spec_json, natural_lang,
              source, confidence, derived_from_correction_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            id,
            body.templateId,
            tpl.user_id,
            body.type,
            JSON.stringify(body.spec),
            body.naturalLang ?? null,
            body.source ?? "user",
            body.confidence ?? 0.7,
            body.derivedFromCorrectionId ?? null,
        ).run();

        return NextResponse.json({ success: true, id });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "rules-create" });
    }
}

function safeJson(s: any): any {
    try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; }
}
