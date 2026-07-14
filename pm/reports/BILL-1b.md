# BILL-1b — Upload estimate ignores active credit model (hotfix)

**Status:** 👀 review
**Date:** 2026-07-12
**Owner:** billing-payment
**Discovered by:** API-4 §8.2 red flag (pre-existing since BILL-1, 2026-07-08)
**Verify:** `npx tsc --noEmit` exit 0 · `npm run build` clean (43 routes) · reasoning below

## Bug

`/api/upload` (field mode) called `estimateCredits({ operation: "ocr", fields: fieldCount })` with **no `creditModel`** parameter. `estimateCredits` interprets missing `creditModel` as `"field_formula"` (see `src/lib/pricing.ts:117` — `input.creditModel ?? "field_formula"`). That silent default overrode the admin's runtime setting.

Client (`OCRWorkspaceV2.tsx:702`) already passes `creditModel: activeCreditModel`, and the credit-confirm dialog previews the correct amount. On submit, server recomputed under the wrong model → estimate/charge diverged from the preview and from `chargeCreditsAtomic`'s deduction (which uses the server's `estimate.credits`).

The fulldoc branch (upload/route.ts:204 pre-fix) was independently wrong in the other direction: it hardcoded `"per_page"`, so an admin toggle to `per_file` would still bill fulldoc as per_page.

## Fix

**`src/app/api/upload/route.ts`** (~10 lines):

1. Import `getActiveCreditModel` alongside `estimateCredits`.
2. Before the estimate branch, read the active model once:
   ```ts
   const creditModel = await getActiveCreditModel(env);
   ```
3. Pass `creditModel` (and `pages: chargePageCount`) to **both** the fulldoc and field branches. Removed the hardcoded `"per_page"` in the fulldoc branch.

The downstream deduction path (`chargeCreditsAtomic(env, userId, estimate.credits)`) is unchanged — it consumes the corrected number.

**`src/app/api/v1/extract/route.ts`** (comment only, no behavior change):

Public API v1 field mode stays BC-pinned to a flat `1` credit (`per_file` semantics) per the BOARD/API-4 red flag #3 — cached scripts/partner integrations rely on the historical fixed cost. Added an explicit BILL-1b comment explaining why we deliberately do NOT plumb `getActiveCreditModel(env)` here, and pointing to `/api/upload` as the reference if the policy is ever revisited. Fulldoc branch already computes `max(1, pages)` via `chargeCreditsAtomic` directly, unchanged.

### Diff (essentials)

`src/app/api/upload/route.ts`:
```diff
-import { estimateCredits } from "@/lib/pricing";
+import { estimateCredits, getActiveCreditModel } from "@/lib/pricing";
 ...
-    const chargePageCount = Math.max(1, selectedPages.length || totalPages || 1);
-    const estimate = isFulldoc
-      ? estimateCredits({
-          operation: "ocr",
-          fields: 0,
-          pages: chargePageCount,
-          creditModel: "per_page",
-        })
-      : estimateCredits({ operation: "ocr", fields: fieldCount });
+    const creditModel = await getActiveCreditModel(env);
+    const chargePageCount = Math.max(1, selectedPages.length || totalPages || 1);
+    const estimate = isFulldoc
+      ? estimateCredits({
+          operation: "ocr",
+          fields: 0,
+          pages: chargePageCount,
+          creditModel,
+        })
+      : estimateCredits({
+          operation: "ocr",
+          fields: fieldCount,
+          pages: chargePageCount,
+          creditModel,
+        });
```

`src/app/api/v1/extract/route.ts` — comment block added above `chargeAmount` explaining the BC pin.

## Scenario audit — 3-page PDF, 5 fields, field mode

Tracing `estimateCredits({ operation:"ocr", fields:5, pages:3, creditModel:X })` through `src/lib/pricing.ts:109`:

| Admin `CREDIT_MODEL` | Path in `estimateCredits` | Math | Estimate |
|---|---|---|---|
| `per_page` | `model === "per_page"` branch (L120) | `max(1, pages=3)` | **3 credits** ✅ |
| `field_formula` | fallthrough legacy branch (L146) | `fF = 1 + max(0, 5-10)*0.1 = 1.0`; `raw = 1.0 * 1 = 1.0`; `max(1, ceil(1.0))` | **1 credit** (legacy formula for ≤10 fields) ✅ |
| `per_file` | `model === "per_file"` branch (L133) | `credits = OCR_MIN = 1` | **1 credit** ✅ |

All three now match the client-side preview (`OCRWorkspaceV2.tsx:702` passes the same `activeCreditModel`). Pre-fix, all three scenarios produced **1 credit** on server regardless of admin setting — because `input.creditModel ?? "field_formula"` clobbered the model.

Note on `field_formula` at 5 fields: the field-formula floor is 1 credit until the base factor exceeds 1 (i.e. fields > 10). At 15 fields it becomes `ceil(1 + 5*0.1) = ceil(1.5) = 2`. So the observable difference between `per_file` and `field_formula` only surfaces on larger prompts — but the SEMANTIC difference (which formula was applied) matters for receipts, admin audits, and future planned-feature pricing.

Fulldoc branch, same 3-page input (`fields:0`):

| Admin model | Estimate |
|---|---|
| `per_page` | 3 (same as before fix) |
| `field_formula` | `fF=1`, `raw=1`, `ceil→1` |
| `per_file` | 1 |

Pre-fix fulldoc always billed 3 regardless of admin. If the admin has intentionally set `per_file` for cost-simplicity reasons, fulldoc now follows suit — matching the task brief's expectation of "use the active model everywhere".

## BC preservation

- **v1/extract field mode**: unchanged (comment-only). Public API contract preserved.
- **v1/extract fulldoc**: unchanged.
- **`chargeCreditsAtomic`**: unchanged — takes a computed cost.
- **`estimateCredits` internals**: untouched.
- **Compare**: `/api/compare` continues to call `estimateCredits({operation:"compare",...})` without `creditModel` — Compare is intentionally not model-switchable (`src/lib/pricing.ts:26-28` comment). Unchanged.
- **`actualCredits`** (post-run): delegates to `estimateCredits(input)` for OCR (L190), so it inherits the same fix as long as callers pass `creditModel`. Post-run for OCR still doesn't add a supplement (it's a straight re-estimate), so no drift possible between estimate and actual.

## Other estimateCredits call sites audited

Server-side, OCR ops only:
- `src/app/api/upload/route.ts` — **FIXED**.
- `src/app/api/v1/extract/route.ts` — does not call `estimateCredits`; BC pin documented.
- `src/app/api/compare/route.ts` — Compare, intentionally out of scope.

Client-side (informational, no server billing impact):
- `src/components/OCRWorkspaceV2.tsx:702` — already correct (passes `activeCreditModel`).
- `src/components/OCRWorkspace.tsx:745,960,1103,1171` — v1 workspace, FROZEN. Passes no `creditModel`. Client-side estimate for local UX; server no longer trusts anything client-side.
- `src/components/CompareWorkspace.tsx:1654` — Compare, out of scope.

## Deploy

Do NOT deploy. Bundle with OCR-8 / API-4 rollout per PM plan.

## Files changed

- `src/app/api/upload/route.ts` (import + estimate block, ~10 lines net)
- `src/app/api/v1/extract/route.ts` (comment block only, no behavior change)
- `pm/reports/BILL-1b.md` (this file)
- `pm/BOARD.md` (BILL-1b row → 👀 review)
