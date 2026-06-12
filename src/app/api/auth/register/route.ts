import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logSystemEvent } from "@/lib/logger";
import { loadTierCredits, creditForPlan } from "@/lib/tier-config";
import { validatePassword } from "@/lib/passwordStrength";
import { hashPassword } from "@/lib/passwordHash";
import { ok, fail, ErrorCode } from "@/lib/apiResponse";
import { broadcastToAdmins } from "@/lib/notifications";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as { name?: string; email?: string; password?: string };
        const name = body.name?.trim() ?? "";
        const email = body.email?.toLowerCase().trim() ?? "";
        const password = body.password ?? "";

        if (!name || !email || !password) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "register" });
        }

        if (validatePassword(password)) {
            return fail(ErrorCode.WEAK_PASSWORD, { context: "register" });
        }

        const { env } = await getCloudflareContext();

        if (!env?.DB) {
            // Development mode without DB: return success but don't persist
            return ok({ success: true, message: "Dev mode: Registration simulated" });
        }

        const existing = await env.DB
            .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
            .bind(email)
            .first();

        if (existing) {
            return fail(ErrorCode.EMAIL_TAKEN, { context: "register" });
        }

        // Create new user record. Starting credit is STAMPED from the current
        // admin-configured per-tier value (new users register as Free) — later
        // config edits never touch this user again.
        const id = crypto.randomUUID();
        const tierCredits = await loadTierCredits(env);
        const startCredit = creditForPlan(tierCredits, "free");
        const passwordHash = await hashPassword(password);
        await env.DB
            .prepare("INSERT INTO users (id, name, email, password, role, plan, credits_total, credits_remaining) VALUES (?, ?, ?, ?, 'user', 'Free', ?, ?)")
            .bind(id, name, email, passwordHash, startCredit, startCredit)
            .run();

        await logSystemEvent(env, "USER_REGISTERED", `New user registered: ${email} (${name})`, "info", id);

        await broadcastToAdmins(env, {
            kind: "new_user",
            severity: "info",
            title: "New user registered",
            body: `${email} (${name})`,
            link: "/admin_users",
            metadata: { userId: id, email, name },
        });

        return ok({ success: true });
    } catch (err: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: err, context: "register" });
    }
}
