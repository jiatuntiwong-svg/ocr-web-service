// Server-side helpers for returning the canonical { ok, code, detail, vars }
// response envelope. Use everywhere — keeps every route's error shape in sync.
//
//   return ok({ user });
//   return fail(ErrorCode.INSUFFICIENT_CREDITS, { vars: { need: 5, have: 2 } });
//   return fail(ErrorCode.AI_FAILED, { detail: rawErr.message, log: env });

import { NextResponse } from "next/server";
import { ErrorCode, STATUS_FOR_CODE, type ErrorCodeT } from "./errorCodes";
import { redactSecrets } from "./redactSecrets";

export interface ApiSuccess<T = any> {
    ok: true;
    data?: T;
    [key: string]: any;
}

export interface ApiFailure {
    ok: false;
    code: ErrorCodeT;
    /**
     * Backward-compat: generic English fallback so legacy UI that still reads
     * `.error` keeps rendering something sensible before it migrates to the
     * `code` field. Never used by UI-3-aware callers (they use `apiError(code)`
     * against the i18n catalog). Do NOT rely on this on the client for new
     * code — it's not localised.
     */
    error: string;
    /** Dev-facing only — logged server-side, never displayed. */
    detail?: string;
    /** Interpolation vars for the client's i18n message. */
    vars?: Record<string, string | number>;
}

/**
 * Static English fallbacks keyed by ErrorCode. Kept in sync (structurally) with
 * `errorCodes.*` in `src/lib/i18n/locales/en.ts` but INTENTIONALLY not loaded
 * from the i18n bundle — that pulls locale detection into every server route
 * for no gain. Dynamic locale lookup on the server is Phase 7.5's job.
 */
const FALLBACK_MESSAGE: Record<ErrorCodeT, string> = {
    UNAUTHORIZED: "Unauthorized.",
    LOGIN_FAILED: "Sign-in failed.",
    EMAIL_TAKEN: "Email already registered.",
    WEAK_PASSWORD: "Password too weak.",
    BAD_REQUEST: "Invalid request.",
    MISSING_FIELDS: "Required fields are missing.",
    USER_NOT_FOUND: "User not found.",
    NOT_FOUND: "Not found.",
    INSUFFICIENT_CREDITS: "Insufficient credits.",
    FEATURE_DISABLED: "Feature not available on your plan.",
    RATE_LIMITED: "Too many requests.",
    FILE_TOO_LARGE: "File exceeds the allowed size.",
    INVALID_FORMAT: "Unsupported file format.",
    TOO_MANY_PAGES: "Too many pages selected.",
    AI_FAILED: "AI processing failed.",
    AI_UNAVAILABLE: "AI service is temporarily unavailable.",
    UPLOAD_FAILED: "Upload failed.",
    PROCESSING_FAILED: "Processing failed.",
    CHECKOUT_FAILED: "Checkout failed.",
    SAVE_FAILED: "Save failed.",
    NETWORK: "Network error.",
    SERVER_ERROR: "Server error.",
    GENERIC: "Something went wrong.",
};

/** Success response — pass any extra payload on the same object for back-compat. */
export function ok<T extends Record<string, any>>(payload?: T): NextResponse<ApiSuccess & T> {
    return NextResponse.json({ ok: true, ...(payload as any) });
}

export interface FailOpts {
    /** Dev-facing detail logged via console.error (not sent to client). */
    detail?: string | unknown;
    /** Interpolation vars for the client's i18n message. */
    vars?: Record<string, string | number>;
    /** Override the default HTTP status mapped from code. */
    status?: number;
    /** When set, log the failure context with this label. */
    context?: string;
}

export function fail(code: ErrorCodeT, opts: FailOpts = {}): NextResponse<ApiFailure> {
    const { detail, vars, status, context } = opts;
    const detailStr = detail == null
        ? undefined
        : detail instanceof Error
            ? detail.message
            : typeof detail === "string"
                ? detail
                : JSON.stringify(detail);

    // Always log on the server so we don't lose debugging info — the client
    // only gets the code + (optionally) vars.
    if (detailStr || context) {
        // AI-1 SEC-3: strip any AIza/Bearer/key-in-URL leak before the string
        // reaches console.error → `wrangler tail`. Provider error bodies can
        // echo the request URL/config, so `detailStr` is a known leak vector.
        console.error(`[api:${context || code}]`, code, redactSecrets(detailStr || ""));
    }

    const body: ApiFailure = {
        ok: false,
        code,
        // Backward-compat generic English string so existing UI that reads
        // `.error` still renders something before it migrates to `code`.
        error: FALLBACK_MESSAGE[code] ?? code,
    };
    if (vars) body.vars = vars;
    // Only include detail in non-prod or when explicitly attached AND short.
    // For now: never expose to client. Comment-out the next 2 lines to opt-in
    // during development.
    // if (detailStr && process.env.NODE_ENV !== "production") body.detail = detailStr;

    return NextResponse.json(body, { status: status ?? STATUS_FOR_CODE[code] ?? 500 });
}

export { ErrorCode };
