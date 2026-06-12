// Notification writer. Call from any server route to enqueue a notification
// for one user, or fan one out to every admin. Reads happen through
// /api/notifications/route.ts.
//
// All functions are best-effort: failures are swallowed and logged so that
// notification trouble never blocks the upstream action (OCR finish, login,
// payment) that triggered them.

export type NotificationSeverity = "info" | "warning" | "error";

export type NotificationKind =
    | "low_confidence"
    | "credit_low"
    | "job_done"
    | "new_user"
    | "payment"
    | "login_fail_spike"
    | "error_spike"
    | "feedback"
    | "integration_fail";

export interface CreateNotificationInput {
    userId: string;
    audience?: "user" | "admin";
    kind: NotificationKind;
    severity?: NotificationSeverity;
    title: string;
    body?: string;
    link?: string;
    metadata?: Record<string, unknown>;
}

interface EnvLike {
    DB?: D1DatabaseLike;
}

// Minimal shape — keeps this module free of @cloudflare/workers-types import.
interface D1DatabaseLike {
    prepare(query: string): {
        bind(...values: unknown[]): {
            run(): Promise<unknown>;
            first<T = unknown>(): Promise<T | null>;
            all<T = unknown>(): Promise<{ results: T[] }>;
        };
    };
}

export async function createNotification(env: EnvLike, input: CreateNotificationInput): Promise<void> {
    if (!env?.DB) return;
    try {
        const id = crypto.randomUUID();
        await env.DB.prepare(
            `INSERT INTO notifications (id, user_id, audience, kind, severity, title, body, link, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            id,
            input.userId,
            input.audience ?? "user",
            input.kind,
            input.severity ?? "info",
            input.title,
            input.body ?? null,
            input.link ?? null,
            input.metadata ? JSON.stringify(input.metadata) : null,
        ).run();
    } catch (err) {
        console.warn("[notifications] createNotification failed:", err);
    }
}

// Fan-out to every admin row. We expand at write time (one row per admin) so
// reads stay O(1) per user — no per-request audience join.
export async function broadcastToAdmins(
    env: EnvLike,
    input: Omit<CreateNotificationInput, "userId" | "audience">,
): Promise<void> {
    if (!env?.DB) return;
    try {
        const admins = await env.DB
            .prepare("SELECT id FROM users WHERE role = 'admin'")
            .bind()
            .all<{ id: string }>();
        for (const admin of admins.results) {
            await createNotification(env, { ...input, userId: admin.id, audience: "admin" });
        }
    } catch (err) {
        console.warn("[notifications] broadcastToAdmins failed:", err);
    }
}

// Dedupe helper for spike-style notifications (login_fail_spike, error_spike).
// Returns true if a notification of this kind for this user was created within
// the last `windowMinutes` — caller can skip to avoid flooding the bell.
export async function wasNotifiedRecently(
    env: EnvLike,
    userId: string,
    kind: NotificationKind,
    windowMinutes: number,
): Promise<boolean> {
    if (!env?.DB) return false;
    try {
        const row = await env.DB.prepare(
            `SELECT id FROM notifications
             WHERE user_id = ? AND kind = ?
               AND created_at > datetime('now', ?)
             LIMIT 1`,
        ).bind(userId, kind, `-${windowMinutes} minutes`).first<{ id: string }>();
        return !!row;
    } catch {
        return false;
    }
}
