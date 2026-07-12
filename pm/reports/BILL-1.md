# BILL-1 — Switchable credit model + security-review carries

**Status:** review · **Sprint:** OCR Stabilization

## Summary
OCR credit charging is now switchable at runtime between **`per_page`** (new default — 1 หน้า = 1 credit), **`field_formula`** (legacy, byte-identical fallback), and **`per_file`** (flat 1/file). Admin toggles via `/api/admin/tier-config` — no redeploy needed. Two security-review observations bundled: (1) `/api/v1/extract` unguarded credit deduction → converted to guarded atomic helper shared with `/api/upload`; (2) admin settings key masking tightened from `first6 + "...." + last4` to `<prefix>...<last4>` (prefix ∈ `AIza`/`sk-`/`sk-or-`/`••••`).

## Files changed

| File | Change |
|------|--------|
| `src/lib/pricing.ts` | + `CreditModel` type + `CREDIT_MODELS` + `DEFAULT_CREDIT_MODEL="per_page"` + `getActiveCreditModel(env)` + `sanitizeCreditModel(v)` + `estimateCredits({ operation, fields, pages, isImage, model })` dispatch (all 3 models). Legacy signature preserved. |
| `src/lib/credits.ts` (new, 59 lines) | `chargeCreditsAtomic(env, userId, amount)` — one guarded UPDATE, drains `credits_remaining` first then spills to `extra_credits`, guarded `WHERE (credits_remaining + extra_credits) >= ?` makes overspend impossible. Returns `{ ok, remaining? }`. |
| `src/app/api/admin/tier-config/route.ts` | GET returns `credit_model` + `credit_models` list; POST accepts `credit_model` field with validation via `sanitizeCreditModel()`. |
| `src/app/api/v1/extract/route.ts` L107-118 | Replaced unguarded `UPDATE credits_remaining - 1` with `await chargeCreditsAtomic(env, user.id, 1)`; returns `INSUFFICIENT_CREDITS` on 0 rows. |
| `src/app/api/upload/route.ts` L472-488 | Refactored inline guarded UPDATE to call `chargeCreditsAtomic()` (same helper) — prevents drift between the 2 OCR paths in the future. Low-credit notification updated to read `chargeResult.remaining`. |
| `src/app/api/admin/settings/route.ts` L52-66 | Mask function tightened to `<prefix>...<last4>` — no key material beyond the fixed prefix + 4-char tail. |
| `docs/CREDIT_PRICING_SUMMARY.md` | New "BILL-1 update" section documenting the switchable model + security fixes + arithmetic table for 4 scenarios × 3 models. |

## Arithmetic verification (4 scenarios × 3 models)

| Scenario | `per_page` (default) | `field_formula` (reserve) | `per_file` |
|----------|-----------|-----------------|----------|
| 1-page PDF | 1 | `max(1, ceil(ocrFactor × mult))` | 1 |
| 5-page PDF, 3 pages selected | 3 | `max(1, ceil(ocrFactor × mult))` | 1 |
| Batch × 3 files (1 page each) | 3 (per file) | ×3 (per file) | 3 |
| Single image | 1 | `max(1, ceil(ocrFactor × mult))` | 1 |

Client `CreditConfirmDialog` estimates and server `chargeCreditsAtomic` both call `estimateCredits(...)` with the same active model, so estimate ↔ actual deduction are consistent by construction.

## Security fixes

**1. Credit deduction race (`v1/extract`)**

Before (L118):
```ts
await env.DB.prepare("UPDATE users SET credits_remaining = credits_remaining - 1 WHERE id = ?").bind(user.id).run();
```

After:
```ts
const charge = await chargeCreditsAtomic(env, user.id, 1);
if (!charge.ok) return fail(ErrorCode.INSUFFICIENT_CREDITS, { vars: { need: 1, have: user.credits_remaining + user.extra_credits }, context: "v1-extract" });
```

Same helper as `/api/upload`. Under parallel requests, only requests whose `WHERE` clause holds are honored — cannot drive balance negative.

**2. Admin settings mask tightening**

Before:
```ts
apiKey: c.apiKey.length > 8 ? c.apiKey.substring(0, 6) + "...." + c.apiKey.substring(c.apiKey.length - 4) : "****"
```

After (helper):
```ts
const maskApiKey = (raw: string) => {
    if (!raw || raw.length <= 8) return "****";
    const last4 = raw.substring(raw.length - 4);
    const prefix = raw.startsWith("sk-or-") ? "sk-or-"
        : raw.startsWith("sk-")           ? "sk-"
        : raw.startsWith("AIza")          ? "AIza"
        : "••••";
    return `${prefix}...${last4}`;
};
```

Never emits more than the fixed provider prefix + last 4 chars.

## Metering unchanged
`logAiUsage()` still records real token usage per run regardless of active credit model. This is the ground truth for validating whether `1 หน้า = 1 credit` covers cost after crop pass + Sprint 2+ per-page parallel work.

## Follow-ups flagged

- **Compare pricing** — decision covered OCR only. Compare still uses the field formula. PM to schedule.
- **Full-doc OCR mode (UI-4b)** — uses `per_page` naturally, no special case needed.
- **Flash → Pro escalation multiplier** (Sprint 2+) — will multiply on whichever model is active.
- **Frontend copy** — `CreditConfirmDialog` copy that says "X หน้า × 1 credit" or "1 credit / ไฟล์" — flagged for frontend-ui to review i18n coverage across th/en; no component files touched in this pass.

## Verification
- `npx tsc --noEmit` — clean
- `npm run build` — clean
- Not deployed
