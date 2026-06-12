// Client-side fetch wrapper that returns the canonical { ok, code, ... }
// envelope every API route uses. Classifies network/transport errors into
// the same shape so callers can branch on `code` without try/catch noise.
//
//   const res = await fetchJson<{ user: User }>("/api/auth", { method: "POST", body });
//   if (!res.ok) { setError(apiError(res.code, res.vars, t)); return; }
//   setUser(res.user);
//
// Backwards-compatible: tolerates legacy routes that return
// `{ error: "string" }` — they get coerced into { ok:false, code:"GENERIC" }.

import { ErrorCode, type ErrorCodeT } from "./errorCodes";

export interface FetchJsonSuccess<T = any> {
    ok: true;
    [key: string]: any;
}
export interface FetchJsonFailure {
    ok: false;
    code: ErrorCodeT;
    vars?: Record<string, string | number>;
    status?: number;
}
export type FetchJsonResult<T = any> = (FetchJsonSuccess & T) | FetchJsonFailure;

export interface FetchJsonInit extends RequestInit {
    /** When true, do not auto-parse JSON for responses without body. */
    raw?: boolean;
}

export async function fetchJson<T = any>(
    input: RequestInfo | URL,
    init: FetchJsonInit = {},
): Promise<FetchJsonResult<T>> {
    let response: Response;
    try {
        response = await fetch(input, init);
    } catch (err) {
        // fetch threw — DNS, offline, CORS preflight fail, etc.
        console.warn("[fetchJson] network error:", err);
        return { ok: false, code: ErrorCode.NETWORK };
    }

    // 401 with no JSON body — common from server middleware. Surface directly.
    if (response.status === 401) {
        return { ok: false, code: ErrorCode.UNAUTHORIZED, status: 401 };
    }
    if (response.status === 429) {
        return { ok: false, code: ErrorCode.RATE_LIMITED, status: 429 };
    }
    if (response.status === 413) {
        return { ok: false, code: ErrorCode.FILE_TOO_LARGE, status: 413 };
    }

    let body: any = null;
    try {
        body = await response.json();
    } catch {
        // No JSON body. Convert HTTP status alone into a code.
        if (response.ok) return { ok: true } as any;
        return {
            ok: false,
            code: response.status >= 500 ? ErrorCode.SERVER_ERROR : ErrorCode.GENERIC,
            status: response.status,
        };
    }

    // New canonical shape: { ok: true|false, ... }.
    if (body && typeof body.ok === "boolean") {
        return body as any;
    }

    // Legacy shape: { success: true|false, error?: "..." } or { error: "..." }.
    // Coerce so callers can rely on `.ok` everywhere.
    if (response.ok && (body == null || body.error == null)) {
        return { ok: true, ...(body || {}) } as any;
    }

    return {
        ok: false,
        code: response.status >= 500 ? ErrorCode.SERVER_ERROR : ErrorCode.GENERIC,
        vars: body?.error ? { detail: String(body.error) } : undefined,
        status: response.status,
    };
}
