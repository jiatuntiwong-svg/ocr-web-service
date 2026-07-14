// Shared credit-charging helpers (BILL-1, 2026-07-09).
//
// Before this file existed the two OCR entry points (`/api/upload` and
// `/api/v1/extract`) had DRIFTED: upload used a guarded atomic UPDATE that
// drained `credits_remaining` then spilled into `extra_credits`, while
// v1/extract used an unguarded `... = credits_remaining - 1` that could go
// negative under concurrent requests. The security review (2026-07-09)
// flagged the race. Anything that deducts credits now goes through
// `chargeCreditsAtomic()` so the two paths can't drift again.
//
// Contract:
//   - Single SQL statement, no read-then-write. The `WHERE` clause verifies
//     the combined balance covers the charge; 0 rows updated = INSUFFICIENT.
//   - `credits_remaining` drains first; the remainder spills into
//     `extra_credits`. Neither column can go negative — the arithmetic
//     inside SQLite is written so that when `credits_remaining >= amount`
//     the spill term evaluates to 0.
//   - Returns the AFTER-charge combined balance for downstream low-credit
//     notifications.

export interface ChargeResult {
    ok: boolean;
    /** Combined balance (credits_remaining + extra_credits) AFTER the charge.
     *  Undefined when `ok === false`. */
    remaining?: number;
}

/**
 * Atomically deduct `amount` credits from the user. Safe under concurrent
 * requests — the guarded `WHERE` clause makes overspend impossible.
 *
 * amount ≤ 0 is treated as a no-op (returns ok:true with current balance)
 * so callers don't need extra branches for free/system paths.
 */
export async function chargeCreditsAtomic(
    env: any,
    userId: string,
    amount: number,
): Promise<ChargeResult> {
    if (!env?.DB) return { ok: false };
    if (!userId) return { ok: false };
    if (!Number.isFinite(amount) || amount <= 0) {
        // No-op: read the current balance so callers still get a `remaining`
        // for their downstream notifications.
        const row: any = await env.DB.prepare(
            "SELECT credits_remaining + extra_credits AS remaining FROM users WHERE id = ?"
        ).bind(userId).first();
        return { ok: true, remaining: (row?.remaining as number | undefined) ?? 0 };
    }
    const charged: any = await env.DB.prepare(
        `UPDATE users SET
            credits_remaining = MAX(0, credits_remaining - ?1),
            extra_credits     = extra_credits - MAX(0, ?1 - credits_remaining)
         WHERE id = ?2 AND (credits_remaining + extra_credits) >= ?1
         RETURNING credits_remaining + extra_credits AS remaining`
    ).bind(amount, userId).first();
    if (!charged) return { ok: false };
    return { ok: true, remaining: charged.remaining };
}

/**
 * Atomically REFUND `amount` credits to a user (API-4b).
 *
 * Called when an AI-provider-side failure prevents the operation the caller
 * already charged for — every failed curl was burning credits before this
 * existed (UAT 2026-07-12). Mirrors `chargeCreditsAtomic`'s single-statement
 * shape so parallel refunds can't race.
 *
 * Contract:
 *   - Refund lands entirely in `credits_remaining`. Even if the original
 *     charge partially drained from `extra_credits`, we don't try to "undo
 *     the split" — that would need per-charge bookkeeping we don't have.
 *     credits_remaining is the monthly-topup bucket, so tilting refunds
 *     toward it is more generous, not less, to the caller. Acceptable
 *     for the AI-failure edge case.
 *   - `amount ≤ 0` is a no-op (returns ok:true without touching the row)
 *     to match `chargeCreditsAtomic`'s guard shape.
 *   - No schema changes — refund is logged to console with `[REFUND]`
 *     prefix by the caller. A dedicated `credit_refunds` table is a future
 *     enhancement (see pm/reports/API-4b.md).
 *
 * ONLY call this on AI-provider-side failures (429/quota/network/timeout).
 * Do NOT call for user errors (invalid params, size guard, missing fields)
 * — those never charged in the first place because size + validation happen
 * BEFORE `chargeCreditsAtomic` in both /api/upload and /api/v1/extract.
 */
export async function refundCreditsAtomic(
    env: any,
    userId: string,
    amount: number,
): Promise<ChargeResult> {
    if (!env?.DB) return { ok: false };
    if (!userId) return { ok: false };
    if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: true };
    }
    const refunded: any = await env.DB.prepare(
        `UPDATE users SET credits_remaining = credits_remaining + ?1
         WHERE id = ?2
         RETURNING credits_remaining + extra_credits AS remaining`
    ).bind(amount, userId).first();
    if (!refunded) return { ok: false };
    return { ok: true, remaining: refunded.remaining };
}
