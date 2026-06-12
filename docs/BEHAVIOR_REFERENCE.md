# Behavior Reference — Cloudflare Production Baseline

> **Purpose:** Owner-side checklist for verifying that the Docker build
> behaves identically to the Cloudflare production app.
> **Snapshot date:** 2026-06-14
> **Production URL:** https://ocr-web-service.jiatuntiwong.workers.dev
>
> Use this doc to:
> 1. Walk through every flow on the live CF app and note the **current**
>    behavior (the receiving team will reproduce it).
> 2. Replay the same flows on the Docker build and compare outcomes.
> 3. Sign off when every row in §6 (acceptance matrix) matches.

---

## 1. How to use this doc

For each user journey below, the owner will:
1. Perform the journey on **CF production** and tick the "matches expectation"
   box (a sanity-check that the doc still describes reality).
2. Perform the **same** journey on the **Docker build** delivered by the
   team, and tick the "matches CF" box.
3. Note any deviation in the "Notes" column.

Outcomes that should match are **bold**. Items in parentheses are
informational ("happens internally, user might not see it").

---

## 2. Environments

| Env | URL | Purpose |
|--|--|--|
| **CF production (baseline)** | `https://ocr-web-service.jiatuntiwong.workers.dev` | Reference behavior — what Docker must match |
| **CF dev local** | `http://localhost:3000` (via `npm run dev`) | Owner-side regression after refactors |
| **Docker dev** | `http://localhost:3000` (via `docker compose up`) | Team-side build, owner pulls + tests |
| **Docker staging** | TBD (company internal) | Receiving team's first real deploy target |

---

## 3. Test data conventions

For each journey, use a dedicated test account so flows are repeatable:

| Account | Email | Role | Plan |
|--|--|--|--|
| Free user | `test-free@example.com` | user | Free |
| Pro user | `test-pro@example.com` | user | Pro |
| Admin | `admin@example.com` | admin | System |

The dev fallback users defined in [`src/lib/devUsers.ts`](../src/lib/devUsers.ts)
work as a backup if D1 is empty.

Test files:
- **PDF (Thai invoice)**: 1–3 pages, contains `เลขผู้เสียภาษี`, `ยอดรวม`
- **PDF (Bill of Lading)**: shipping doc with item table
- **Excel (.xlsx)**: simple workbook with 1 sheet, structured rows
- **Image (.png)**: scanned receipt
- (Owner provides these privately — not in repo for privacy)

---

## 4. Journeys to verify

### 4.1 Auth

| Step | Expected behavior | Notes |
|--|--|--|
| Visit root URL while logged out | Redirects to `/login` |  |
| Register with new email + password (≥8 chars, mixed case) | Account created; `email_verified_at` is NULL but login still allowed for now | Email-verify gate is backlogged |
| Register with weak password (e.g. `12345`) | Error code `WEAK_PASSWORD` | See `src/lib/passwordStrength.ts` |
| Register with already-used email | Error code `EMAIL_TAKEN` |  |
| Login with correct credentials | Session cookie set, redirect to `/` (OCR view by default) | Cookie is `httpOnly`, 7-day expiry |
| Login with wrong password 5+ times in 10 minutes | (internal) Admin notification "Login failure spike" appears in admin bell | Dedupe: only fires once per 10-min window |
| Logout | Session cleared, redirect to `/login` |  |
| Legacy plaintext-password user logs in | **Login succeeds**, password is silently rehashed to `pbkdf2$…` in DB on success | Owner can verify by inspecting `users.password` before/after |

### 4.2 OCR Workspace (single doc extract)

| Step | Expected behavior | Notes |
|--|--|--|
| Click "OCR" in NavRail | Workspace loads with template rail (left) + drop zone + result panel |  |
| Pick a template that has 5 fields | Fields chip row populates with 5 chips |  |
| Drop a Thai PDF | Preview appears in left panel + "Extract" button enabled |  |
| Click "Extract" | Spinner appears; `processStep` text cycles | Credit cost shown next to the button |
| Extraction completes | **Fullscreen overlay opens** with preview (L) + result table (R) | Auto-flip to fullscreen is intended |
| Result shows | Each field's value + confidence badge (green ≥80, amber 60-79, red <60) |  |
| If any field confidence < user's threshold | **Notification bell** gets a "Document needs review" entry | Threshold default 70%, slider in Documents view |
| Press Esc | Fullscreen exits, result stays visible in normal layout |  |
| Click "Expand fullscreen" again | Fullscreen overlay re-opens |  |
| Click "Export Excel" / "Export CSV" | Browser downloads the file with field/value columns |  |
| Click "New document" | Workspace resets, fullscreen exits |  |
| Insufficient credits when clicking Extract | Modal: smart-confirm if borderline, hard error `INSUFFICIENT_CREDITS` if zero |  |

### 4.3 Compare Workspace (2-3 docs diff)

| Step | Expected behavior | Notes |
|--|--|--|
| Click "Compare" | 2-3 slots for files + field list + verdict mode toggle |  |
| Verdict mode toggle | Segmented control: "Smart" (default, indigo) / "Strict" (amber) | Saved in `localStorage` as `compare_verdict_mode` |
| Drop 2 PDFs into the slots | Previews load; "Run Comparison" enables when both ready |  |
| Click "Run Comparison" | Status bar steps: OCR tokens → AI extract → highlight match |  |
| Result panel | Each field shown with doc1/doc2 values, ⚠ badge if diff | Identical-after-normalize values do NOT flag (Smart mode) |
| Date `2022-01-15` vs `15 มกราคม 2565` in Smart mode | **Verdict = same** (Buddhist year → Christian, ISO normalize) | Critical normalize test |
| Same in Strict mode | **Verdict = diff** |  |
| Currency `USD 51,651.11` vs `51651.11 USD` in Smart | **Verdict = same** |  |
| Quantity `25 PCS` vs `25 ชิ้น` in Smart | **Verdict = same** | Unit stripping |
| Quantity `10 + 5 + 3` vs `18` in Smart | **Verdict = same** | Arithmetic eval |
| Table field with row diff (e.g. `qty` 10 vs 12) | Diff cells **highlighted on both source documents** | Uses row-derived scan + word-level diff |
| Mismatch text like `M330` vs `M330s` | Only the differing word is boxed (not the whole phrase) | Word-level granularity |
| Cache hit: rerun same files + fields | Result appears instantly + **no credit charged** | Edge cache, must be re-implemented as Redis |

### 4.4 Documents view

| Step | Expected behavior | Notes |
|--|--|--|
| Click "Documents" | List of past OCR + Compare runs, newest first |  |
| Review Settings panel at top | Threshold slider (0-100%) + "Block export until reviewed" toggle | Saved per user in `user_preferences` |
| Adjust threshold to 90% | More rows show ⚠ REVIEW badge |  |
| Expand a low-confidence row | Mark as Reviewed button appears | Soft-confirm dialog on export |
| Enable "Block export until reviewed" | Export buttons disabled for unreviewed low-conf docs | Hard block |
| Click "Mark as reviewed" | Badge flips to ✓ Reviewed; export enables | Optimistic UI; persists in DB |

### 4.5 Notifications

| Step | Expected behavior | Notes |
|--|--|--|
| Bell icon (TopBar) | Shows unread count badge | Polls every 30s, paused when tab hidden |
| Click bell | Dropdown with up to 50 latest notifications, unread on top |  |
| Click a notification with a link | Marks as read + navigates to linked view (e.g. `/documents`) |  |
| "Mark all read" button | All notifications marked read in one PATCH call |  |
| Admin user only | Sees admin-audience notifications (new_user, payment, login_fail_spike) |  |

### 4.6 Billing (Stripe)

| Step | Expected behavior | Notes |
|--|--|--|
| Click "Billing" | Page with tier comparison + top-up packs |  |
| Click "Upgrade to Pro" | Redirects to Stripe Checkout (test mode) |  |
| Complete payment with test card `4242 4242 4242 4242` | Returns to app; user's `plan` becomes "Pro"; credits stamped from tier config | Webhook handles the update |
| Top-up purchase | Same flow, `extra_credits` incremented |  |
| Subscription cancellation (admin / Stripe dashboard) | Plan downgrades to Free at next webhook | `customer.subscription.deleted` |
| Webhook signature verification | Invalid signature → 400 error | Signature uses raw body |

### 4.7 Admin tools

| Step | Expected behavior | Notes |
|--|--|--|
| Login as admin | Admin views unlock in NavRail (Users, AI Usage, Logs, Feedback, Tier Control) |  |
| Admin → Users | Sortable list with edit + delete |  |
| Edit user → change plan | Plan + credits updated; user sees change next session |  |
| Edit user → reset password | New password is hashed (`pbkdf2$…`); user logs in with new password |  |
| Admin → Tier Control | Edit credits / features per tier | Future signups stamp these values |
| Admin → AI Usage | Per-model + per-function counts and tokens |  |
| Admin → Logs | System logs paginated (LOGIN, OCR_SUCCESS, OCR_EXTRACTION_ERROR, etc.) |  |
| Admin → Feedback | User-submitted feedback inbox |  |

### 4.8 Public API (`/api/v1/extract`)

> ⚠️ **Important:** The current API shape is **NOT** the target customer-
> facing shape. See [`MIGRATION.md §9`](MIGRATION.md#9-public-api-hardening-in-scope--fold-into-migration-work)
> for the full hardening backlog. The rows below describe the **current**
> behavior on CF — the Docker team is expected to **replace** much of this
> (email+password auth, non-atomic charge, sync-only response) with the
> hardened version. The two CF-passes / Docker-passes columns in §6 are
> split into "current shape" and "hardened shape" for that reason.

#### Current shape (CF, baseline to understand the code)

| Step | Current behavior | Notes |
|--|--|--|
| POST multipart with `email`, `password`, `file`, `fields` | OCR extraction returned as JSON | Admin role required + tier feature flag `public_api` enabled |
| Wrong password | `401 UNAUTHORIZED` | PBKDF2 verify; legacy plaintext rehashed on success |
| Non-admin caller | `403 FEATURE_DISABLED` (with `detail: "admin-only API"`) | Hard gate; user-tier callers never reach AI |
| Insufficient credits | `402 INSUFFICIENT_CREDITS` |  |
| Successful extraction | 1 credit deducted **before** AI call (race-unsafe) + response includes `extracted_data` | Charge happens in two separate UPDATEs |
| AI call fails | Credit was already deducted → **user loses the credit** | Anti-pattern, see §9.2 of MIGRATION |
| Synchronous response | Returns within Worker CPU limit (~30s); times out on large files | No async option today |
| Hardcoded Thai prompt | Defaults to Thai field names if `fields` param omitted | See route line 15 |

#### Hardened shape (Docker target — see MIGRATION.md §9 for details)

| Step | Target behavior | Notes |
|--|--|--|
| `Authorization: Bearer sk_…` | API key replaces email+password in every call | New `api_keys` table |
| Revoked key | `401 UNAUTHORIZED` on next call | `revoked_at` checked at lookup |
| Rate limit hit | `429` with `X-RateLimit-Reset` header | Sliding window per-key in Redis |
| Request body > size cap | `413 Payload Too Large` | No credit charged |
| Successful extraction | Credit deducted **after** AI success, atomic UPDATE | Matches `/api/upload` pattern |
| AI failure | No credit charged | Refund path on partial failure |
| Async sibling `POST /api/v1/extract/async` | Returns `{ jobId }` immediately; `GET /api/v1/jobs/{id}` polls | BullMQ on Redis |
| All responses | `X-Credits-Remaining`, `X-RateLimit-*`, `X-Request-Id` headers present | Audit-friendly |
| Errors | `{ code, message }` only — never stack traces or paths | Full detail in server logs keyed by request_id |
| Audit | Every call inserts a row into `api_calls` table | Trace abuse and support cases |

---

## 5. Performance baseline (CF production)

Measure on production with realistic 1-3 page invoices. Docker build should
match within ±20% on like-for-like hardware.

| Operation | Median | p95 |
|--|--|--|
| Login (round-trip) | ~150ms | ~400ms |
| OCR upload + extract (1-page PDF) | ~5-8s | ~12s |
| OCR upload + extract (3-page PDF) | ~12-18s | ~25s |
| Compare 2 docs (5 fields, 0 tables) | ~10-15s | ~25s |
| Compare 2 docs (10 fields, 1 table 20 rows) | ~25-40s | ~60s |
| Compare cache hit (same inputs) | ~200-400ms | ~700ms |
| Worker cold start | 0ms (always warm) | — |

Numbers above are owner-observed informal measurements, not formal load
tests. Docker team is free to provide their own baseline as long as the
**per-flow user-visible delay** doesn't increase noticeably (>30% slower).

---

## 6. Acceptance matrix (sign-off)

Owner ticks each row after running on Docker build. Sign + date at bottom.

| # | Check | CF passes | Docker passes | Notes |
|--|--|:--:|:--:|--|
| 1 | Register + login + logout | ☐ | ☐ |  |
| 2 | Legacy password rehash on login | ☐ | ☐ |  |
| 3 | OCR end-to-end (Thai PDF, 5 fields) | ☐ | ☐ |  |
| 4 | OCR fullscreen auto-open + Esc close | ☐ | ☐ |  |
| 5 | OCR insufficient credits guard | ☐ | ☐ |  |
| 6 | Compare scalar diff (Smart mode) | ☐ | ☐ |  |
| 7 | Compare date normalize (พ.ศ. ↔ ค.ศ.) | ☐ | ☐ |  |
| 8 | Compare currency / unit normalize | ☐ | ☐ |  |
| 9 | Compare arithmetic normalize | ☐ | ☐ |  |
| 10 | Compare Strict mode flags above as diff | ☐ | ☐ |  |
| 11 | Compare table row-diff + cell highlights | ☐ | ☐ |  |
| 12 | Compare word-level diff (`M330` vs `M330s`) | ☐ | ☐ |  |
| 13 | Compare cache hit (no charge) | ☐ | ☐ |  |
| 14 | Documents list + threshold slider | ☐ | ☐ |  |
| 15 | Mark Reviewed + export gating | ☐ | ☐ |  |
| 16 | Notification bell polling + mark-read | ☐ | ☐ |  |
| 17 | Notification triggers (low_conf, credit_low, new_user, login_fail_spike) | ☐ | ☐ |  |
| 18 | Stripe checkout test card (subscription) | ☐ | ☐ |  |
| 19 | Stripe checkout test card (top-up) | ☐ | ☐ |  |
| 20 | Stripe webhook updates plan/credits | ☐ | ☐ |  |
| 21 | Admin users list + edit | ☐ | ☐ |  |
| 22 | Admin tier control writes | ☐ | ☐ |  |
| 23 | Admin AI usage shows tokens | ☐ | ☐ |  |
| 24 | Public API extract works | ☐ | ☐ |  |
| 25 | OCR for 3-page PDF completes within 20s | ☐ | ☐ |  |
| 26 | Atomic credit charge (race-safe) | ☐ | ☐ | Run 2 uploads in parallel from same user |
| 27 | Background OCR survives app restart | ☐ | ☐ | Docker-only — restart container mid-OCR |
| 28 | `docker-compose down && up` preserves data | ☐ | ☐ | Docker-only |
| 29 | Mobile responsive (auto-collapse NavRail on <1024px) | ☐ | ☐ |  |
| 30 | Th + En locale toggle works | ☐ | ☐ |  |
| **API Hardening (see MIGRATION.md §9)** |  |  |  |  |
| 31 | `POST /api/v1/extract` with `Authorization: Bearer sk_…` succeeds | n/a | ☐ | Docker-only — new auth model |
| 32 | Old email+password form returns 401 (or behind feature flag) | ☐ | ☐ | Owner picks transition policy |
| 33 | Revoked API key returns 401 immediately | n/a | ☐ |  |
| 34 | 10 parallel calls from same key cannot overdraw credits | ☐ | ☐ | Atomic charge |
| 35 | AI failure leaves credits untouched (refund/no-charge path) | ☐ | ☐ | Simulate with bad Gemini key |
| 36 | Request > size cap returns 413 without spending a credit | n/a | ☐ |  |
| 37 | Rate limit returns 429 with `X-RateLimit-Reset` | n/a | ☐ |  |
| 38 | Error responses do not contain stack traces / file paths | ☐ | ☐ | Owner checks any error response body |
| 39 | `X-Request-Id` on every response + matching `api_calls` row | n/a | ☐ |  |
| 40 | Async sibling endpoint completes large jobs without timeout | n/a | ☐ | Test with multi-page PDF |

---

**Owner sign-off:**

- [ ] CF baseline behavior matches the descriptions above (sanity check done)
- [ ] Docker build matches every row in section 6

Signed: _______________________ Date: _______________

---

## 7. Known quirks (don't flag as bugs)

- The dashboard's "Recent Activity" panel hardcodes some Thai labels in
  `renderCompareData` — this is a backlogged i18n cleanup, not a regression
- The OCR result auto-flips to fullscreen on completion — intended behavior,
  matches Compare. User can exit with Esc or X button
- Highlights for very short table cells (1–2 chars) may over-highlight all
  occurrences in the doc if AI doesn't return row context — current
  behavior, see word-level diff in `CompareWorkspace.tsx`
- Verbose `console.log` in webhook/stripe route (10 emoji-style debug
  prints) — pre-existing, will be cleaned up post-migration

## 8. If something differs

When the Docker build behaves differently from CF, capture:
1. **Step-by-step repro** (screenshots if UI)
2. **Expected** (what CF does, per this doc)
3. **Actual** (what Docker does)
4. **Console / server logs** if applicable
5. **Test data** used (file size, format, language)

Open an issue on the migration branch's PR with this template.
