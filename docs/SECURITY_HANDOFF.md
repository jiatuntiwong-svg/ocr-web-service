# Security Handoff

> **Purpose:** one place answering "what's actually been security-reviewed
> here, and what's known-risky but not yet fixed" — so nobody assumes a gap
> is covered, or re-litigates something already fixed. Written 2026-07-16
> from `pm/reports/AI-1.md`, `pm/reports/BILL-1.md`,
> `docs/MIGRATION.md` §9, and `docs/PENDING_ISSUES.md` / `PENDING_FEATURES_BACKLOG.md`.
> This is a summary with pointers, not a replacement for reading the
> underlying reports before acting on anything below.

---

## 1. Auth model (current)

- Password-based, PBKDF2 hashing (`src/lib/passwordHash.ts`). Legacy
  plaintext-password accounts are silently rehashed to `pbkdf2$…` on
  next successful login.
- Session: HMAC-signed cookie (`SESSION_SECRET`), `httpOnly`, 7-day expiry.
  No server-side session list/revocation — a leaked cookie is valid until
  it naturally expires. No "logout all devices" feature.
- No email verification gate today (`email_verified_at` can be NULL and
  login still works) — this is a known, tracked gap, not an oversight; see
  §4 below.
- No forgot-password / reset-password flow at all.
- No brute-force rate limiting on `/api/auth` — a login-failure-spike
  notification exists for the admin to *see* an attack, but nothing blocks
  it automatically.

**Bottom line:** fine for a small trusted user base; not yet at the bar for
opening registration to the general public without at least rate limiting
and a password-reset path. See §4 (Known open items) for the prioritized list.

## 2. What has been through an explicit security review

### 2.1 Vertex AI provider addition (AI-1, 2026-07-09)

Full checklist in `pm/reports/AI-1.md`, verified item-by-item:

- API key sent via `x-goog-api-key` **header**, never in the URL/query string.
- Admin Settings `GET` always returns masked keys (`AIza XX....XXXX`-style)
  for every provider (Gemini/OpenAI/OpenRouter/Vertex) — no code path
  returns a full key to the browser.
- No key is ever logged in the clear: `src/lib/redactSecrets.ts` scrubs
  Google API key patterns, `?key=` params, `x-goog-api-key` header echoes,
  and `Bearer` tokens before anything reaches `console.warn`/`console.error`.
- Zero client-side AI calls — `generateWithAI` is only imported from
  `src/app/api/**/route.ts`; grepped and confirmed no `NEXT_PUBLIC_*` key
  variable exists.
- Provider failures return `{ code: "AI_FAILED" }` only — no upstream
  error body, URL, or header content reaches the client.
- **Not independently re-run through `/security-review`** by the agent that
  did this work (flagged explicitly in the report as something the operator
  needed to do before deploy) — worth confirming this actually happened if
  anyone is relying on it as a completed second review.

### 2.2 Credit-charging race + key-masking tightening (BILL-1, 2026-07-09)

Full detail in `pm/reports/BILL-1.md`:

- `/api/v1/extract`'s credit deduction was an unguarded
  `UPDATE credits_remaining = credits_remaining - 1` (a real race: parallel
  requests could overdraw). Fixed by routing through the same
  `chargeCreditsAtomic()` guarded UPDATE that `/api/upload` already used.
- Admin settings key masking tightened from `first6 + "...." + last4` to a
  fixed provider-prefix (`AIza`/`sk-`/`sk-or-`) + last 4 chars only — less
  key material exposed in the masked form.

### 2.3 AI-failure credit refund (API-4b, 2026-07-12)

`/api/v1/extract` was charging credits **before** the AI call with no
refund on failure — every failed request (bad key, quota, timeout) burned
a credit with nothing delivered. Fixed with `refundCreditsAtomic()`
(mirrors the charge helper). See `docs/MIGRATION.md` §9.1 for the residual
caveat: this is charge-then-refund, not true pre-authorize/capture, so a
process crash between the two steps is still a (narrow, unlikely) edge case.

### 2.4 Error-message hardening (API-2/API-3/UI-3, 2026-07-09)

OCR routes (`/api/upload`, `/api/status`, `/api/v1/extract`) and the auth
flow (login/register) no longer leak raw `err.message` / stack traces to
the client — responses are `{ ok: false, code, error, vars? }` with `code`
mapped to a localized string client-side. **Scope is OCR + auth only** —
Compare, admin views, documents view, and billing routes are still on the
old raw-message path (tracked as Phase 7.5 in `docs/PENDING_ISSUES.md` §H).

## 3. Known open risk — do not assume these are handled

Pulled directly from `docs/MIGRATION.md` §9 (public API hardening backlog)
and `docs/PENDING_FEATURES_BACKLOG.md` (critical section). Still open as of
2026-07-16:

| Area | Risk | Where it's tracked |
|--|--|--|
| `/api/v1/extract` auth | Uses `email` + `password` in every request body, not a revocable API key. Functional today, but not an acceptable shape to hand to external customers | `MIGRATION.md` §9.1-9.2, backlog item "API-5" |
| `/api/v1/extract` — no rate limit / no request-size guard / no audit log / no CORS policy decided | Same route — a public key today could be hammered with no back-pressure | `MIGRATION.md` §9.2 |
| Auth brute force | No rate limit on `/api/auth` beyond an admin notification | `PENDING_FEATURES_BACKLOG.md` §Critical |
| No forgot-password flow | Locked-out users have no self-service recovery | `PENDING_FEATURES_BACKLOG.md` §Critical |
| No email verification | Anyone can register with an unowned email address and use the account | `PENDING_FEATURES_BACKLOG.md` §Critical — decision already made (block-login-strict + backfill legacy as verified) but not implemented |
| No HIBP breach check | Passwords aren't checked against known-breached lists at register/change | `PENDING_FEATURES_BACKLOG.md` §Critical |
| No session revocation | Can't invalidate a specific session/device; only full `SESSION_SECRET` rotation (which invalidates *everyone*) | This doc §1, §4 |
| Compare/admin/billing error paths | Still return raw `err.message` to the client | `PENDING_ISSUES.md` §H, Phase 7.5 |

## 4. Recommended priority if picking this up

This mirrors the order already in `PENDING_FEATURES_BACKLOG.md`'s "ลำดับ
เร่งด่วนที่แนะนำ" section — repeated here because it's the security-relevant
subset:

1. Forgot / reset password — every SaaS needs this; locked-out users today
   have no path back in.
2. Email verification (decision already made — block-login-strict + backfill
   legacy `email_verified_at = created_at`) — closes the "anyone can claim
   any email" gap.
3. API key management for `/api/v1/extract` — replace email+password auth
   before this route is ever handed to a real external customer.
4. Auth rate limiting — cheap, closes the brute-force gap.

## 5. Where secrets live and how to rotate them

See `docs/OPS_RUNBOOK.md` §4 — covers `wrangler secret put` for
environment-level secrets (`SESSION_SECRET`, `GEMINI_API_KEY`, Stripe keys)
vs. the admin-UI-managed AI provider keys (D1-backed, masked, rotatable
without redeploy).
