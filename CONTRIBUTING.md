# Contributing to DOCRoom

Thanks for helping out. This project is collaborator-reviewed: only the
project owner pushes to `main` (via merge) and runs production deploys.
Everyone else works through Pull Requests.

---

## Quick Workflow

```
1. Sync local main           git checkout main && git pull
2. Create a branch           git checkout -b feat/short-description
3. Code + commit             git add -p && git commit -m "feat: ..."
4. Push branch               git push -u origin feat/short-description
5. Open PR on GitHub         to main
6. Wait for review           owner reviews + approves
7. Owner merges + deploys    you don't push to main, ever
```

---

## Branch Naming

Use a type prefix followed by a short kebab-case description.

| Prefix | Use for |
|--------|---------|
| `feat/` | New feature (e.g. `feat/skill-system`) |
| `fix/` | Bug fix (e.g. `fix/table-highlight`) |
| `refactor/` | Internal restructuring with no behavior change |
| `docs/` | Docs / README only |
| `chore/` | Build, deps, lint, no app behavior change |
| `test/` | Tests only |

Keep branches small and focused. One concern per PR keeps reviews fast.

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/) style.

```
<type>: <imperative summary, no period>

<optional body explaining WHY, not WHAT — the diff already shows what>

<optional footer for breaking changes, issue refs>
```

Examples:
```
feat: add Skill (.md custom rules) MVP
fix: highlight short table cells via row-derived scan
refactor: extract diffNormalize into its own module
docs: add break-even analysis to pricing summary
```

Avoid:
- `update code`, `fix bug`, `wip` — no signal for reviewers
- Trailing period
- Mixed scopes in one commit

---

## Pull Request Checklist

Before opening a PR, run locally:

```bash
npx tsc --noEmit         # type check passes
npm run build            # production build succeeds
```

In the PR description, include:

1. **What** — one-paragraph summary
2. **Why** — the user-facing problem this solves
3. **How tested** — manual steps you took (URLs, screenshots if UI)
4. **Risk / scope** — what could break, what production state changes

Smaller PRs get merged faster. Keep diffs under ~400 lines when you can.

---

## Code Style

- **TypeScript strict mode** is on — no `any` unless really necessary.
- **No `eval` / `new Function`** — Cloudflare Workers blocks them. Use the
  shunting-yard pattern in [`src/lib/diffNormalize.ts`](src/lib/diffNormalize.ts)
  as a template for expression-style logic.
- **Comments explain WHY, not WHAT** — the code shows what it does.
- **Don't add error handling for impossible cases.** Trust framework
  guarantees. Validate only at boundaries (user input, external APIs).
- **i18n** — all user-facing strings go in `src/lib/i18n/locales/en.ts` and
  `th.ts`. Never hardcode UI strings in components.

---

## Database Migrations

Migrations are forward-only and live in [`db/migrations/`](db/migrations/).
Naming: `<short_description>.sql` (no timestamps — order is by feature).

When you add a migration:

1. Write it as idempotent SQL where reasonable (CREATE TABLE IF NOT EXISTS,
   ALTER TABLE ADD COLUMN with a comment about re-run behavior).
2. Run it on your local D1 first to verify.
3. The owner runs it on production D1 as part of the deploy after merge.
4. Add a one-line entry in the PR description describing what changes.

---

## What NOT to Commit

The `.gitignore` already handles most of these — but be vigilant:

- `.dev.vars` — has real Gemini / Stripe keys
- `.claude/` — Claude Code per-machine permissions
- `public/pdf.worker.min.mjs` — generated at build time
- `test_compare/` — real-looking customer documents
- `scripts/poc-*/samples/` — same
- `.open-next/`, `.wrangler/` — build / dev artifacts

If you ever accidentally commit a secret, rotate it immediately — even if
you reset history, search engines scrape public GitHub fast.

---

## Where to Look First

- **Compare verdict logic** — [`src/app/api/compare/route.ts`](src/app/api/compare/route.ts) + [`src/lib/diffNormalize.ts`](src/lib/diffNormalize.ts)
- **OCR pipeline** — [`src/app/api/upload/route.ts`](src/app/api/upload/route.ts) + [`src/lib/ai-handler.ts`](src/lib/ai-handler.ts)
- **Highlight matcher** — [`src/components/CompareWorkspace.tsx`](src/components/CompareWorkspace.tsx) + [`src/lib/text-matcher.ts`](src/lib/text-matcher.ts)
- **Pricing** — [`src/lib/pricing.ts`](src/lib/pricing.ts) + [`docs/CREDIT_PRICING_SUMMARY.md`](docs/CREDIT_PRICING_SUMMARY.md)
- **Tier feature gates** — [`src/lib/tier-config.ts`](src/lib/tier-config.ts)
- **Feature backlog** — [`docs/PENDING_FEATURES_BACKLOG.md`](docs/PENDING_FEATURES_BACKLOG.md)
- **Cross-team plan** — [`docs/PENDING_LINE_AND_INTEGRATIONS_PLAN.md`](docs/PENDING_LINE_AND_INTEGRATIONS_PLAN.md)

---

## Questions

Open a GitHub Discussion or ping the owner directly. For security issues
(leaked secret, auth bug, data leak path), do NOT open a public issue —
contact the owner privately.
