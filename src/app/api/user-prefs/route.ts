// Per-user preference store. Reads/writes the `user_preferences` table
// (not the user row directly — see migrations/user_preferences.sql for why).
// Holds: default template selections (OCR + Compare) and confidence-review
// settings (threshold + hard-block toggle). Add a column instead of a new
// route when adding more.

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";

const ALLOWED_KINDS = new Set(["ocr", "compare"]);

const DEFAULT_THRESHOLD = 0.7;

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const userId = searchParams.get("userId");
        if (!userId) return fail(ErrorCode.MISSING_FIELDS, { context: "user-prefs" });

        const { env } = await getCloudflareContext();
        if (!env?.DB) return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "user-prefs" });

        const row = await env.DB.prepare(
            `SELECT default_ocr_template_id, default_compare_template_id,
                    confidence_threshold, block_export_low_confidence
             FROM user_preferences WHERE user_id = ?`,
        ).bind(userId).first<{
            default_ocr_template_id: string | null;
            default_compare_template_id: string | null;
            confidence_threshold: number | null;
            block_export_low_confidence: number | null;
        }>();

        return ok({
            success: true,
            defaultOcrTemplateId: row?.default_ocr_template_id ?? null,
            defaultCompareTemplateId: row?.default_compare_template_id ?? null,
            confidenceThreshold: row?.confidence_threshold ?? DEFAULT_THRESHOLD,
            blockExportLowConfidence: !!row?.block_export_low_confidence,
        });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "user-prefs" });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const body = await req.json() as {
            userId?: string;
            // template-default flow (existing)
            kind?: string;
            templateId?: string | null;
            // confidence-review flow (new)
            confidenceThreshold?: number;
            blockExportLowConfidence?: boolean;
        };
        if (!body.userId) return fail(ErrorCode.MISSING_FIELDS, { context: "user-prefs" });

        const { env } = await getCloudflareContext();
        if (!env?.DB) return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "user-prefs" });

        // Branch 1: template default update (legacy/existing).
        if (body.kind !== undefined) {
            if (!ALLOWED_KINDS.has(body.kind)) {
                return fail(ErrorCode.BAD_REQUEST, { detail: "kind must be 'ocr' or 'compare'", context: "user-prefs" });
            }
            const column = body.kind === "ocr" ? "default_ocr_template_id" : "default_compare_template_id";
            const other = body.kind === "ocr" ? "default_compare_template_id" : "default_ocr_template_id";

            await env.DB.prepare(
                `INSERT INTO user_preferences (user_id, ${column}, updated_at)
                 VALUES (?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(user_id) DO UPDATE SET
                   ${column} = excluded.${column},
                   ${other} = user_preferences.${other},
                   updated_at = CURRENT_TIMESTAMP`,
            ).bind(body.userId, body.templateId ?? null).run();

            return ok({ success: true });
        }

        // Branch 2: confidence-review settings. Partial PATCH — only update the
        // fields the caller actually sent.
        const hasThreshold = typeof body.confidenceThreshold === "number";
        const hasBlock = typeof body.blockExportLowConfidence === "boolean";
        if (!hasThreshold && !hasBlock) {
            return fail(ErrorCode.BAD_REQUEST, { detail: "no fields to update", context: "user-prefs" });
        }

        // Clamp threshold to [0, 1] to defend against UI bugs that send percent.
        const threshold = hasThreshold
            ? Math.max(0, Math.min(1, body.confidenceThreshold as number))
            : null;
        const block = hasBlock ? (body.blockExportLowConfidence ? 1 : 0) : null;

        const sets: string[] = [];
        const vals: (number | null)[] = [];
        if (hasThreshold) { sets.push("confidence_threshold = ?"); vals.push(threshold); }
        if (hasBlock)     { sets.push("block_export_low_confidence = ?"); vals.push(block); }
        sets.push("updated_at = CURRENT_TIMESTAMP");

        await env.DB.prepare(
            `INSERT INTO user_preferences (user_id, confidence_threshold, block_export_low_confidence, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET ${sets.join(", ")}`,
        ).bind(
            body.userId,
            hasThreshold ? threshold : DEFAULT_THRESHOLD,
            hasBlock ? block : 0,
            ...vals,
        ).run();

        return ok({ success: true });
    } catch (err) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "user-prefs" });
    }
}
