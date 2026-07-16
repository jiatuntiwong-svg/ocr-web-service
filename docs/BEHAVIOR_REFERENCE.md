# Behavior Reference — Cloudflare Production Baseline

> **Purpose:** Owner-side checklist for verifying that the Docker build
> behaves identically to the Cloudflare production app.
> **Snapshot date:** 2026-07-16 (extends the 2026-07-11 OCR Stabilization
> sprint-close snapshot with Sprint 2 items shipped since: UI-7 batch v2,
> OCR-8/8b landscape dual-scale, API-4/API-4b fulldoc mode, OCR-9 multi-page
> same-field rule. Latest deploy referenced: `fb169356`, 2026-07-13.)
> **Production URL:** https://ocr-web-service.jiatuntiwong.workers.dev
>
> Use this doc to:
> 1. Walk through every flow on the live CF app and note the **current**
>    behavior (the receiving team will reproduce it).
> 2. Replay the same flows on the Docker build and compare outcomes.
> 3. Sign off when every row in §6 (acceptance matrix) matches.
>
> **2026-07-16 sync note:** §4.2 (fulldoc row) and §6 rows 41-44 were
> updated/added in this pass to close the gap the docs-manager agent
> flagged in `pm/reports/DOC-1-sprint-close.md` ("§6 acceptance matrix
> still references the pre-v2 workspace... left alone to avoid churning
> the migration audit"). This pass folds in everything that shipped
> between the 2026-07-11 sprint close and 2026-07-16, grounded in
> `pm/BOARD.md` + the individual `pm/reports/*.md` for each item — it has
> **not** re-derived every claim from source line numbers the way the
> original DOC-1 pass did, so treat the new rows as report-verified,
> not code-verified, and spot-check before a real sign-off.

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

### 4.2 OCR Workspace v2 (single doc extract)

Since 2026-07-11 the flag `ENABLE_OCR_WORKSPACE_V2` is **ON in prod** —
`src/app/(app)/ocr/page.tsx` routes to `OCRWorkspaceV2.tsx`. The legacy
`OCRWorkspace.tsx` remains behind the flag as rollback surface only; every
row below describes v2 behavior.

**v2 shell:** 6-step stepper (Upload → Pages → Template → Fields → Extract →
Result), progressive disclosure, keyboard-first (kbd R = retry in the
result overflow menu), stage-machine driven so ⚡ Quick mode can auto-advance.

| Step | Expected behavior | Notes |
|--|--|--|
| Click "OCR" in NavRail | v2 workspace loads with the stepper collapsed to step 1 (Upload). No template rail — templates picked in step 3 via `<TemplatePickerPanel>` (⭐ favourites / 🕐 recent / 📋 all + delete). System templates cannot be deleted (button disabled with tooltip); user templates get inline-confirm delete with optimistic reconcile | `pm/reports/UI-4c.md`, `pm/reports/UI-6.md`, `pm/reports/UI-6-delete.md` |
| Toggle ⚡ Quick mode (topbar) | Auto-advances Upload → Pages → Extract on file drop when a default template + fields are already set. Credit-confirm dialog still fires (never bypassed) | UI-6 §B |
| Toggle "Full document" (topbar mode switch) | Extraction sends the whole document instead of the field-list prompt. Result view renders one text block per page (copy button per page) + export as .txt/.md/.docx (Excel/CSV hidden — doesn't apply). Backend went live with API-4 (curl UAT passed 2026-07-13); response shape is `{ data: { pages: [{page, text}] } }`, `_meta.partial: true` if the model didn't return valid per-page JSON (falls back to a single raw dump) | UI-4c §3d, `pm/reports/API-4.md` |
| Toggle "Show hint boxes" (topbar) | Overlays saved `bbox_hint` rectangles on the preview; drawing/edit is a separate expander in step 3 | UI-4c §3e |
| Pick a template that has 5 fields | Fields chip row populates with 5 chips |  |
| Drop a Thai PDF | Preview appears in left panel + "Extract" button enabled |  |
| Drop a PDF > 1 page | **Page picker** appears below preview (thumbnail grid). Defaults to `[1..min(N, 5)]` selected | Cap `PAGE_SELECTION_MAX` (default 5) — tunable via `NEXT_PUBLIC_PAGE_SELECTION_MAX` |
| Drop a PDF with > 5 pages | Amber warning: "Document has {N} pages — pick up to 5". Extract still runs on the (≤5) selection | Server also enforces the cap; direct API calls without a selection get `TOO_MANY_PAGES` (400) |
| Clear all page selections | Extract CTA disabled + tooltip "Select at least one page" |  |
| Upload > 20 MB | Rejected before any credit deduction or AI call with `FILE_TOO_LARGE` (413) — localized toast | Cap `MAX_UPLOAD_SIZE_MB`, env-tunable; applies to `/api/upload` + `/api/v1/extract` |
| Click "Extract" | Spinner appears; `processStep` text cycles (mini-story panel driven by `ENABLE_LOADING_STORY`) | Credit cost shown next to the button, computed via active `credit_model` — see §4.9 below |
| Click "Retry" (result overflow menu / kbd R) | Re-runs the same file with `temperature: 0.6` to shake stuck-deterministic answers. Same credit charge as a fresh extract — retry is a full run, not a refund | OCR-3; UI merged into UI-4c overflow. Retry does not fix variance, it just gives the user a re-roll |
| Extraction completes | **Fullscreen overlay opens** with preview (L) + result table (R) | Auto-flip to fullscreen is intended |
| Result shows | Each field's value + confidence badge (green ≥80, amber 60-79, red <60) |  |
| If any field confidence < user's threshold | **Notification bell** gets a "Document needs review" entry | Threshold default 70%, slider in Documents view |
| Press Esc | Fullscreen exits, result stays visible in normal layout |  |
| Click "Expand fullscreen" again | Fullscreen overlay re-opens |  |
| Click "Export Excel" / "Export CSV" | Browser downloads the file with field/value columns |  |
| Click "New document" | Workspace resets, fullscreen exits |  |
| Insufficient credits when clicking Extract | Modal: smart-confirm if borderline, hard error `INSUFFICIENT_CREDITS` if zero |  |

#### 4.2a Hinted fields (`bbox_hint`) + crop-based extraction

Templates may attach a `bbox_hint` (page + x/y/w/h in 0..1 normalized coords) to
any field, either auto-captured on first extract or user-drawn via the preview.
Two things happen when a field has a hint:

| Behavior | Notes |
|--|--|
| The hint is included in the whole-image extraction prompt as a spatial anchor ("search around this region, including below if value overflows the line") | Helps disambiguate 2-column layouts and repeated labels |
| On upload, the client crops the hinted region out of the same 3600px stacked PNG and sends the crops as `crop_<idx>` parts + a `field_crops` JSON manifest | One extra multi-image AI call per upload; skipped when no field has a hint |
| Server merge policy: for hinted fields only, a non-null crop value **replaces** the whole-image value and the field object gains `source: "crop"`; a null crop value keeps the whole-image value and flags `crop_miss: true` in `raw_json` | Non-hinted fields are untouched; unknown crop keys are ignored |
| Metering | Both AI calls' tokens accumulate into a single `ai_usage` row; the user is charged once per operation (unchanged) |
| Backward-compat | Uploads without hints / without `field_crops` follow the pre-OCR-6 path exactly. Public API `/api/v1/extract` does NOT participate in the crop pass (per OCR-4 decision) |
| Landscape / dense-page legibility | Hinted crops on landscape A4 pages are sent at two scales (hi 7200px + lo 3600px, `ENABLE_DUAL_SCALE_CROPS`) and reconciled by a shared multi-scale prompt rule — fixes a deterministic glyph-drop the model had at single-scale (e.g. missing "รับบริจาค"). Benchmark: 36/36 = 100% across categories as of deploy `fb169356` (2026-07-13) | `pm/reports/OCR-8.md`, `pm/reports/OCR-8b.md` |
| Same field label appears on 2+ pages with different values | Model returns a single joined string `"[หน้า 1: X \| หน้า 2: Y]"` instead of silently keeping only page 1's value. If all pages have the same value, returns that single value with no page prefix. This is a prompt-rule fix (shared rules v2026-07-15-v3), not a schema change — the field stays a plain string | `pm/reports/OCR-9.md`. Structured multi-value (`values: [{page, value}]`) deferred to follow-up OCR-9b if needed |

Reference: `pm/reports/OCR-6.md`, `pm/reports/OCR-6b.md` (prompt-parity + merge-provenance fix),
`pm/reports/OCR-6c.md` (hint coordinate space = pdfjs raster), `src/lib/field-crops.ts`,
`src/app/api/upload/route.ts` (crop-merge block).

#### 4.2b Error UX (OCR + auth flows)

Since 2026-07-09, `/api/upload`, `/api/status`, `/api/v1/extract` return
`{ ok: false, code, error, vars? }` on every failure — never a raw
`err.message` / stack. The frontend routes those through a small i18n
catalog (`errorCodes.*` + `errors.*`) via `apiError()` / `friendlyError()`,
so users see a localized message keyed by the code (not the backend string).
`OCRWorkspace`, login, and register have zero raw-message setError sites.
Compare / admin views are still on the pre-catalog path (Phase 7.5).

Reference: `pm/reports/API-2.md`, `pm/reports/API-3.md`,
`pm/reports/UI-3.md`, `src/lib/friendlyError.ts`, `src/lib/errorCodes.ts`.

#### 4.2c Credit model (BILL-1, in prod since 2026-07-09)

OCR credit charging is admin-switchable at runtime via
`/api/admin/tier-config` — no redeploy needed. Default in prod is
`per_page`.

| Model | Charge math (OCR) | When it fires |
|--|--|--|
| **`per_page`** (default) | 1 credit per PDF page in the selection (or `total_pages` if no subset). Single image / .docx / .xlsx = 1 credit | Runtime default since deploy `a878584d`. Matches the "1 หน้า = 1 credit" mental model users have |
| `field_formula` (reserve) | `max(1, ceil(ocrFactor × modelMult))` where `ocrFactor = 1 + max(0, fields − 10) × 0.1` | Legacy path. Kept as reserve so admins can revert if per-page ends up under-covering AI cost after the crop pass |
| `per_file` | Flat 1 credit per file, regardless of pages/fields | Simplest option for batch-heavy workflows |

Compare pricing is **NOT** model-switchable — it always uses the field
formula (Compare rework deferred to a future task).

Charging is done through `chargeCreditsAtomic()`
(`src/lib/credits.ts`) — a single guarded UPDATE that drains
`credits_remaining` first then spills to `extra_credits`, returning 0 rows
= `INSUFFICIENT_CREDITS`. Both `/api/upload` and `/api/v1/extract` share
the helper so the two paths cannot drift.

Reference: `src/lib/pricing.ts` (`CreditModel`, `DEFAULT_CREDIT_MODEL`),
`src/lib/credits.ts`, `pm/reports/BILL-1.md`,
`docs/CREDIT_PRICING_SUMMARY.md`.

#### 4.2d Batch mode (v2-native, since UI-7 / deploy `fb169356`)

Toggling "หลายไฟล์" (multiple files) in the topbar mode switch no longer
opens the legacy `OCRWorkspace.tsx` embed — since UI-7 it mounts a
self-contained `OCRBatchViewV2.tsx` with its own state and stepper.

| Behavior | Notes |
|--|--|
| Same 6-step shell (upload → pages → fields → run → results → export) as single-file v2 | One shared field/template selection applies to every file in the batch — no per-file template override |
| Per-file page picker | Each uploaded file gets its own tab with its own page selection; a file over the page cap shows `⚠ (N/M)` and blocks advancing until reduced |
| Sequential extraction, not parallel | Files run one at a time with a small pacing delay between them (deliberately more conservative than v1's concurrency of 3, to keep headroom against AI rate limits) |
| Credit estimate | `CreditConfirmDialog` shows a per-file breakdown row plus a Total row; the existing T1-T4 smart-confirm triggers still apply, evaluated against the batch total — batch cannot bypass confirmation |
| Results | Spreadsheet-style table: one row per file, columns = union of field keys across the batch, each cell shows value + confidence badge |
| Full-document mode combined with batch | Allowed — each file transcribes independently |
| Rollback | Flipping `ENABLE_OCR_WORKSPACE_V2` off restores the pre-UI-7 behavior (single + batch both fall back to v1 verbatim) — `OCRWorkspace.tsx` was left byte-identical (md5-verified) by this change |

Reference: `pm/reports/UI-7.md`, `pm/reports/UI-7-uat-r1.md` through `r6`,
`src/components/OCRBatchViewV2.tsx`.

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
| Admin → API Settings → provider dropdown | Options include Gemini, OpenAI, OpenRouter, and **Vertex AI (Express)**. Vertex uses `x-goog-api-key` header + global endpoint (no OAuth / service-account) | Routing option only — no change to OCR extraction semantics. See `pm/reports/AI-1.md` |
| Admin → API Settings → load form | Stored keys return **masked** (`AIzaXX....XXXX`) for every provider. Submitting the form without editing the key preserves the stored value (mask marker = "keep existing"); pasting a new key overrides | Applies to Gemini + Vertex + OpenAI + OpenRouter uniformly |
| Admin → API Settings → "Test" button per config | `POST /api/admin/settings/test` with just `{ id }`; server loads the key, runs a 1-token probe, returns success/`AI_FAILED` only. Plaintext key never touches the browser | New endpoint from AI-1 |

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
| **Sprint 2 additions (added 2026-07-16, not yet owner-ticked on CF)** |  |  |  |  |
| 41 | Batch mode: multi-file upload, per-file page picker, sequential run, spreadsheet results | ☐ | ☐ | v2-native since UI-7, `deploy fb169356` |
| 42 | Full-document mode end-to-end (single + batch): per-page transcript, .txt/.md/.docx export | ☐ | ☐ | API-4; `_meta.partial` fallback path also worth exercising with a deliberately malformed response |
| 43 | Landscape / dense-page crop legibility (dual-scale reconciliation) | ☐ | ☐ | `ENABLE_DUAL_SCALE_CROPS`; benchmark fixture `landscape-a4-widefield` |
| 44 | Same field on 2+ pages with different values returns joined `[หน้า N: ...]` string, not just page 1 | ☐ | ☐ | OCR-9; identical-value case must NOT get the page-prefix treatment |

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
