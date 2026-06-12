// Server-side helpers for returning the canonical { ok, code, detail, vars }
// response envelope. Use everywhere — keeps every route's error shape in sync.
//
//   return ok({ user });
//   return fail(ErrorCode.INSUFFICIENT_CREDITS, { vars: { need: 5, have: 2 } });
//   return fail(ErrorCode.AI_FAILED, { detail: rawErr.message, log: env });

import { NextResponse } from "next/server";
import { ErrorCode, STATUS_FOR_CODE, type ErrorCodeT } from "./errorCodes";

export interface ApiSuccess<T = any> {
    ok: true;
    data?: T;
    [key: string]: any;
}

export interface ApiFailure {
    ok: false;
    code: ErrorCodeT;
    /** Dev-facing only — logged server-side, never displayed. */
    detail?: string;
    /** Interpolation vars for the client's i18n message. */
    vars?: Record<string, string | number>;
}

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
        console.error(`[api:${context || code}]`, code, detailStr || "");
    }

    const body: ApiFailure = { ok: false, code };
    if (vars) body.vars = vars;
    // Only include detail in non-prod or when explicitly attached AND short.
    // For now: never expose to client. Comment-out the next 2 lines to opt-in
    // during development.
    // if (detailStr && process.env.NODE_ENV !== "production") body.detail = detailStr;

    return NextResponse.json(body, { status: status ?? STATUS_FOR_CODE[code] ?? 500 });
}

export { ErrorCode };
