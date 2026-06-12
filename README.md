# DOCRoom — Intelligent OCR & Document Comparison

Web platform for extracting structured data from documents and comparing them
field-by-field with AI. Built for invoices, shipping documents, contracts, and
any structured form where extraction accuracy matters.

- **OCR Workspace** — upload PDF / Excel / image, define fields, get extracted
  values with per-field confidence + manual review.
- **Compare Workspace** — diff 2–3 documents on selected fields, with
  semantic verdict modes (Smart / Strict), table row-level diff, and
  precise word-level highlights on the source.
- **Tier-based credit system** — Free / Starter / Pro / Enterprise. Pricing
  formulas in [`src/lib/pricing.ts`](src/lib/pricing.ts) and exec summary at
  [`docs/CREDIT_PRICING_SUMMARY.md`](docs/CREDIT_PRICING_SUMMARY.md).
- **Admin tooling** — user management, tier control, AI usage dashboard,
  feedback inbox, system logs.

Production: https://ocr-web-service.jiatuntiwong.workers.dev

---

## Tech Stack

- **Frontend / API:** Next.js 16 (App Router) on Cloudflare Workers via OpenNext
- **AI:** Google Gemini (Flash-Lite default, Pro for heavy compares)
- **Database:** Cloudflare D1 (SQLite-on-edge)
- **Storage:** Cloudflare R2 (uploaded files, signed URLs)
- **Payments:** Stripe (subscriptions + top-up credit packs)
- **Auth:** Password-based with PBKDF2 hashing (Google OAuth planned)
- **i18n:** Thai / English via [`src/lib/i18n`](src/lib/i18n)

---

## Local Setup

### 1. Prerequisites
- Node.js 20+
- A Cloudflare account with D1 + R2 + Workers AI bindings
- A Google AI Studio API key (Gemini)
- (Optional) Stripe test keys for billing flows

### 2. Clone + install
```bash
git clone https://github.com/jiatuntiwong-svg/ocr-web-service.git
cd ocr-web-service
npm install
```

### 3. Configure secrets
Copy the template and fill in your own keys:
```bash
cp .dev.vars.example .dev.vars
```
See [`.dev.vars.example`](.dev.vars.example) for the full list of required
variables. **Never commit `.dev.vars`** — it's already gitignored.

### 4. Bindings (D1 / R2 / AI)
The current [`wrangler.jsonc`](wrangler.jsonc) points to the production DB
binding so a clean clone will share that DB during local dev. For local-only
experiments, create your own D1 + R2 and update `database_id` / `bucket_name`
before running.

Apply schema + migrations to your D1 (order matters — run in this sequence):
```bash
npx wrangler d1 execute <YOUR_DB_NAME> --local --file=db/schema.sql
npx wrangler d1 execute <YOUR_DB_NAME> --local --file=db/migrations/user_preferences.sql
npx wrangler d1 execute <YOUR_DB_NAME> --local --file=db/migrations/feedback.sql
npx wrangler d1 execute <YOUR_DB_NAME> --local --file=db/migrations/default_templates.sql
npx wrangler d1 execute <YOUR_DB_NAME> --local --file=db/migrations/confidence_and_notifications.sql
```

### 5. Run dev server
```bash
npm run dev
```
Open http://localhost:3000.

### 6. Run on the Cloudflare runtime (closer to prod)
```bash
npm run dev:cf
```
Slower start, but uses real Wrangler so D1 / R2 / AI bindings behave as in
production.

---

## Project Structure

```
src/
  app/                       Next.js App Router routes
    api/                     Server endpoints (run on Workers)
      auth/                  Login + register + Google (planned)
      compare/               Document compare AI + verdict
      upload/                OCR upload + AI extract
      documents/             Document history + review
      notifications/         In-app bell channel
      admin/                 Admin tooling (users, tier-control, ai-usage)
    page.tsx                 Main app shell (NavRail + TopBar + active view)
  components/                React UI (OCRWorkspace, CompareWorkspace, ...)
  lib/                       Shared logic
    pricing.ts               Credit pricing formulas
    diffNormalize.ts         Semantic equality for Compare verdicts
    text-matcher.ts          OCR token ↔ value matcher (highlight math)
    table-row-diff.ts        Row-level table diff
    notifications.ts         Notification writer
    passwordHash.ts          PBKDF2 hashing + legacy upgrade
    tier-config.ts           Tier-based feature flags + credits
    i18n/                    TH/EN locales
db/
  schema.sql                 Base schema
  migrations/                Forward-only migrations (run in order)
docs/
  CREDIT_PRICING_SUMMARY.md  Exec pricing review (slide-ready)
  PENDING_FEATURES_BACKLOG.md  Full feature backlog with decisions
  PENDING_LINE_AND_INTEGRATIONS_PLAN.md  Cross-team integration plan
scripts/
  poc-*                      POC scripts for new format support
```

---

## Deploy

**Only the project owner deploys.** Collaborators submit changes via PR;
the owner reviews, merges, and then runs deploy.

```bash
npm run deploy
```

This runs OpenNext build + `wrangler deploy`. The Worker URL is
`ocr-web-service.jiatuntiwong.workers.dev`.

There is intentionally **no GitHub Actions auto-deploy** — production upgrades
go through a manual `npm run deploy` so the owner can verify the build first.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow, branch naming,
and commit message conventions. Short version:

1. Create a branch off `main`: `feat/skill-system`, `fix/table-highlight`, etc.
2. Commit + push your branch.
3. Open a Pull Request to `main`.
4. Wait for review + approval.
5. Owner merges, then deploys manually.

---

## License

All rights reserved. Contact the repository owner for usage permissions.
