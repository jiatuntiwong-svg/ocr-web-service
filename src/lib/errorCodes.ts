// Canonical error codes shared between server and client.
//
// Server returns { ok: false, code, detail?, vars? } from every API route.
// Client maps `code` → localised string via `apiError(code, vars, t)`.
// `detail` is dev-facing only (logged server-side, never displayed).
//
// Add new codes here AND a matching i18n key under `errorCodes.<code>` in
// every locale. Keep codes UPPER_SNAKE_CASE and stable — they're contracts.

export const ErrorCode = {
    // ── Auth ──
    UNAUTHORIZED: "UNAUTHORIZED",
    LOGIN_FAILED: "LOGIN_FAILED",
    EMAIL_TAKEN: "EMAIL_TAKEN",
    WEAK_PASSWORD: "WEAK_PASSWORD",

    // ── Validation ──
    BAD_REQUEST: "BAD_REQUEST",
    MISSING_FIELDS: "MISSING_FIELDS",
    USER_NOT_FOUND: "USER_NOT_FOUND",
    NOT_FOUND: "NOT_FOUND",

    // ── Quota / limits ──
    INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
    FEATURE_DISABLED: "FEATURE_DISABLED",
    RATE_LIMITED: "RATE_LIMITED",
    FILE_TOO_LARGE: "FILE_TOO_LARGE",
    INVALID_FORMAT: "INVALID_FORMAT",
    TOO_MANY_PAGES: "TOO_MANY_PAGES",

    // ── Domain ──
    AI_FAILED: "AI_FAILED",
    AI_UNAVAILABLE: "AI_UNAVAILABLE",
    UPLOAD_FAILED: "UPLOAD_FAILED",
    PROCESSING_FAILED: "PROCESSING_FAILED",
    CHECKOUT_FAILED: "CHECKOUT_FAILED",
    SAVE_FAILED: "SAVE_FAILED",

    // ── Client-only (transport) ──
    NETWORK: "NETWORK",
    SERVER_ERROR: "SERVER_ERROR",
    GENERIC: "GENERIC",
} as const;

export type ErrorCodeT = typeof ErrorCode[keyof typeof ErrorCode];

// HTTP status code mapped from each error code so server helpers can pick
// the right status without callers thinking about it. Defaults to 500.
export const STATUS_FOR_CODE: Partial<Record<ErrorCodeT, number>> = {
    UNAUTHORIZED: 401,
    LOGIN_FAILED: 401,
    EMAIL_TAKEN: 400,
    WEAK_PASSWORD: 400,
    BAD_REQUEST: 400,
    MISSING_FIELDS: 400,
    USER_NOT_FOUND: 404,
    NOT_FOUND: 404,
    INSUFFICIENT_CREDITS: 403,
    FEATURE_DISABLED: 403,
    RATE_LIMITED: 429,
    FILE_TOO_LARGE: 413,
    INVALID_FORMAT: 400,
    TOO_MANY_PAGES: 400,
    AI_FAILED: 502,
    AI_UNAVAILABLE: 503,
    UPLOAD_FAILED: 500,
    PROCESSING_FAILED: 500,
    CHECKOUT_FAILED: 500,
    SAVE_FAILED: 500,
    SERVER_ERROR: 500,
    GENERIC: 500,
};
