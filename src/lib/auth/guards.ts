// Route guards built on top of session.ts. The pattern at every protected
// route entry-point is:
//
//   export async function GET(req: NextRequest) {
//       const auth = await requireUser(req);
//       if (auth instanceof Response) return auth;       // unauthorised → return 401
//       // auth.id, auth.role, auth.plan are trustworthy from here on
//       ...
//   }
//
// We deliberately do NOT trust any userId/plan/role that arrives in query
// string or request body. Always read those values from `auth`.

import { NextRequest } from "next/server";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { getSessionUser, canActAs, type SessionUser } from "./session";

/** 401 unless a valid session exists. Returns the session user on success. */
export async function requireUser(req: NextRequest): Promise<SessionUser | Response> {
    const user = await getSessionUser(req);
    if (!user) return fail(ErrorCode.UNAUTHORIZED, { context: "auth-required" });
    return user;
}

/** 401 unless a valid session exists; 403 unless the session is an admin. */
export async function requireAdmin(req: NextRequest): Promise<SessionUser | Response> {
    const user = await getSessionUser(req);
    if (!user) return fail(ErrorCode.UNAUTHORIZED, { context: "auth-required" });
    if (user.role !== "admin") {
        return fail(ErrorCode.UNAUTHORIZED, { detail: "admin-only", context: "auth-required" });
    }
    return user;
}

/**
 * 403 unless the session user is `requestedUserId` (or an admin). Pair with
 * `requireUser` for routes that accept a userId from the client — e.g.
 *
 *   const auth = await requireUser(req);
 *   if (auth instanceof Response) return auth;
 *   const requestedUserId = searchParams.get("userId") ?? auth.id;
 *   const cross = ensureCanActAs(auth, requestedUserId);
 *   if (cross) return cross;
 *
 * Returns a Response on denial, undefined when access is allowed.
 */
export function ensureCanActAs(session: SessionUser, requestedUserId: string): Response | undefined {
    if (!requestedUserId) return undefined;        // route may treat empty as "self"
    if (canActAs(session, requestedUserId)) return undefined;
    return fail(ErrorCode.UNAUTHORIZED, { detail: "cross-user access denied", context: "auth-required" });
}
