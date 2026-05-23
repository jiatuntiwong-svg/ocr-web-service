# OCR Web Service Project Analysis

## 1. Project Overview

This project is a document OCR and comparison web application built on:

- Next.js 16
- React 19
- TypeScript
- Cloudflare via OpenNext / Workers
- D1 for database
- Stripe for billing
- AI/OCR-assisted extraction and document comparison

The product direction is closer to an OCR SaaS platform than a simple OCR demo. It already contains:

- user authentication
- document upload and processing
- field-based extraction
- document comparison with highlight preview
- templates
- admin settings
- admin user management
- admin system logs
- usage / billing features

## 2. Main Functional Areas

### 2.1 Authentication

Relevant routes:

- `src/app/api/auth/route.ts`
- `src/app/api/auth/register/route.ts`

Functions:

- login
- logout
- registration
- session cookie handling

### 2.2 OCR Upload and Processing

Relevant routes:

- `src/app/api/upload/route.ts`
- `src/app/api/status/route.ts`
- `src/app/api/v1/extract/route.ts`

Functions:

- upload PDF/image
- start OCR / extraction pipeline
- track processing status
- return extracted result

### 2.3 Document Comparison

Relevant route:

- `src/app/api/compare/route.ts`

Relevant UI:

- `src/components/CompareWorkspace.tsx`

Functions:

- compare 2-3 documents
- compare only selected fields
- return `null` for missing fields
- prevent AI from inventing extra fields
- return per-document highlight locations
- show results in preview + results panel

### 2.4 Templates

Relevant route:

- `src/app/api/templates/route.ts`

Functions:

- save field templates
- reuse template for extraction / compare
- system + user templates

### 2.5 Admin

Relevant routes:

- `src/app/api/admin/settings/route.ts`
- `src/app/api/admin/users/route.ts`
- `src/app/api/admin/logs/route.ts`

Functions:

- manage AI config
- manage users / plans / limits
- inspect system logs

### 2.6 Billing / Payments

Relevant routes:

- `src/app/api/billing/prices/route.ts`
- `src/app/api/billing/checkout/route.ts`
- `src/app/api/webhook/stripe/route.ts`

Functions:

- show plans
- create checkout session
- receive Stripe webhook

## 3. Current Technical Direction

The project is moving from:

- AI-generated approximate highlight boxes

toward:

- structured compare results
- OCR/text-position-based highlighting
- PDF text-layer awareness
- scanned PDF/image OCR fallback

This is the correct long-term direction.

## 4. Strengths of the Project

- Feature scope is already broad and product-oriented.
- Cloudflare deployment path is already integrated.
- Compare flow now supports selected-fields-only behavior.
- Admin area is already present, which is useful for real operations.
- Logging infrastructure exists and is useful for debugging production issues.
- The compare feature has evolved beyond plain text diff and now supports visual highlight behavior.

## 5. Weaknesses / Architectural Risks

### 5.1 Highlight Accuracy Is Still the Hardest Problem

The hardest problem in this project is not OCR itself, but accurate visual highlighting.

Why this is difficult:

- finding text differences and finding the exact visual location are two different problems
- text PDF and scanned PDF need different pipelines
- tables are much harder than normal text
- Thai text, merged tokens, wrapped lines, and repeated values increase ambiguity

### 5.2 Hybrid OCR Stack Is Still In Transition

The codebase currently mixes several approaches:

- AI-based extraction
- PDF.js text positions
- OCR token matching
- front-end rendering overlays

This is normal during transition, but it increases complexity until the architecture stabilizes.

### 5.3 Optional OCR Dependencies

`tesseract.js` and `image-size` are currently optional dependencies in `package.json`.

Risk:

- environments may behave differently if these packages are missing or partially available
- scanned PDF / image fallback should be validated carefully in real deployment

### 5.4 Session / Security Design Is Still Lightweight

Based on repo history and prior inspection, authentication/session design is still fairly lightweight and should be reviewed further for production hardening.

Areas to review:

- password handling
- cookie/session integrity
- admin authorization checks

## 6. Known Product/Technical Issues

### 6.1 Compare Highlighting

Current state:

- much better than earlier versions
- still sensitive in table cases
- still depends on OCR/token quality

Remaining likely issues:

- row alignment in tables can fail if formatting differs between documents
- cell detection is still heuristic
- repeated values can still confuse match selection

### 6.2 Scanned PDF Path

The scanned PDF path now exists, but should still be treated as a critical area to test in production-like conditions.

Why:

- runtime differences between local and Cloudflare/OpenNext can expose hidden issues
- OCR quality varies heavily depending on input quality

### 6.3 Admin Logs on Cloudflare

This was previously broken because the route used `process.env.DB` instead of Cloudflare context.

Current fix:

- `src/app/api/admin/logs/route.ts` now uses `getCloudflareContext()`

This should be re-tested end-to-end:

- trigger log events
- open admin logs page
- confirm records are visible

## 7. Most Important Files

### Core Product Flow

- `src/app/api/upload/route.ts`
- `src/app/api/status/route.ts`
- `src/app/api/compare/route.ts`
- `src/components/CompareWorkspace.tsx`

### OCR / Highlight Logic

- `src/lib/text-extractor.ts`
- `src/lib/types.ts`

### Admin / Ops

- `src/app/api/admin/settings/route.ts`
- `src/app/api/admin/users/route.ts`
- `src/app/api/admin/logs/route.ts`
- `src/lib/logger.ts`

### Deployment / Infra

- `wrangler.jsonc`
- `next.config.ts`
- `open-next.config.ts`
- `package.json`

### Database

- `schema.sql`
- `seed.sql`
- `seed_users.sql`

## 8. Recommended Improvement Priorities

### Priority 1: Stabilize Highlight Accuracy

Recommended direction:

- text PDF -> PDF.js text layer highlighting
- scanned PDF / image -> OCR token coordinates
- compare logic -> match result back to OCR/text positions
- table fields -> row/cell-aware matching only

### Priority 2: Standardize Compare Architecture

Target architecture:

1. ingest document
2. extract text/tokens/positions
3. extract only selected fields
4. compare field values
5. resolve exact positions from OCR/text tokens
6. render highlights from resolved positions

### Priority 3: Production Reliability

- test admin logs on real Cloudflare deployment
- test scanned PDF OCR path in deployed environment
- validate Stripe webhook flow in production-like conditions
- review error logging and operational visibility

### Priority 4: Security Hardening

- harden auth/session flow
- review password storage / validation strategy
- review admin authorization consistency across routes

## 9. Suggested Future Enhancements

- export compare report as PDF/Excel
- save compare history
- versioned templates
- audit trail per admin action
- API keys / tenant support for enterprise customers
- better table extraction model
- confidence score per field
- queue/background job architecture for heavy OCR jobs

## 10. Questions Worth Investigating Next

- Which document types are most common in production?
- How many are text PDFs vs scanned PDFs?
- Which fields fail highlight most often?
- Are table documents common enough to justify a dedicated parser?
- Should OCR/token extraction be cached per file to reduce cost?
- Should compare results be persisted for audit and re-open flow?

## 11. Summary

This project already has strong product breadth and a useful operational structure. The main technical challenge is no longer basic OCR, but making compare/highlight reliable across text PDFs, scanned PDFs, and tables.

The project is on the right path. The best long-term improvement strategy is:

- use text-layer highlighting for text PDFs
- use OCR-token highlighting for scanned/image documents
- keep comparison field-driven
- make table matching row/cell-aware

If these areas are stabilized, this project can evolve from a useful prototype into a much more reliable production OCR comparison platform.
