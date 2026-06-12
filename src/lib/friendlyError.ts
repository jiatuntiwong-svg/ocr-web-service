// Maps raw errors / API error strings to a localised, user-friendly message.
//
// Until we ship the full {code, detail} backend contract (Section H Step 1-3),
// this util pattern-matches common error strings and falls back to a generic
// message. Dev detail is always logged to console so we don't lose context.

import type { ErrorCodeT } from "./errorCodes";

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Map a canonical error code → localised user-facing message.
 * Prefer this over friendlyError() once a route returns the new
 * { ok, code, vars } envelope. Falls back to errors.generic if the
 * code isn't recognised in the i18n catalog.
 */
export function apiError(
    code: ErrorCodeT | string | undefined | null,
    vars: Record<string, string | number> | undefined,
    t: TranslateFn,
): string {
    if (!code) return t("errors.generic");
    const key = `errorCodes.${code}`;
    const msg = t(key, vars);
    // If the key wasn't in the catalog the translator returns the key
    // verbatim — fall back to generic in that case so we never show
    // "errorCodes.FOO" to the user.
    if (msg === key) return t("errors.generic");
    return msg;
}

export interface FriendlyErrorOpts {
    /** When set, log raw detail with this label so dev tools group nicely. */
    context?: string;
    /** Default override (e.g. "errors.uploadFailed" for upload flows). */
    fallbackKey?: string;
}

/**
 * Convert any error-ish value into a user-facing localised string.
 * Logs the raw detail to console for dev debugging — never shows it.
 */
export function friendlyError(
    err: unknown,
    t: TranslateFn,
    opts: FriendlyErrorOpts = {},
): string {
    const { context = "error", fallbackKey = "errors.generic" } = opts;

    const raw = extractMessage(err);
    if (raw) console.warn(`[${context}]`, raw, err);

    const lower = raw.toLowerCase();

    // Network-layer errors
    if (
        lower.includes("failed to fetch")
        || lower.includes("networkerror")
        || lower.includes("network request failed")
        || lower.includes("load failed")
    ) {
        return t("errors.network");
    }

    // HTTP status hints embedded in messages
    if (lower.includes("401") || lower.includes("unauthorized")) {
        return t("errors.unauthorized");
    }
    if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
        return t("errors.rateLimited");
    }
    if (lower.includes("insufficient") || lower.includes("not enough credit")) {
        return t("errors.insufficientCredits");
    }
    if (lower.includes("ai returned") || lower.includes("invalid format") || lower.includes("gemini")) {
        return t("errors.aiFailed");
    }
    if (lower.includes("too large") || lower.includes("payload")) {
        return t("errors.fileTooLarge");
    }

    return t(fallbackKey);
}

function extractMessage(err: unknown): string {
    if (!err) return "";
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.message || "";
    if (typeof err === "object") {
        const anyErr = err as Record<string, any>;
        if (typeof anyErr.message === "string") return anyErr.message;
        if (typeof anyErr.error === "string") return anyErr.error;
        try { return JSON.stringify(err); } catch { return ""; }
    }
    return String(err);
}

/**
 * Convenience for fetch flows — pulls `.error` out of a JSON response body
 * and runs it through friendlyError().
 */
export function friendlyApiError(
    body: { error?: string } | null | undefined,
    t: TranslateFn,
    opts: FriendlyErrorOpts = {},
): string {
    return friendlyError(body?.error, t, opts);
}
