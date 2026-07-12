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
