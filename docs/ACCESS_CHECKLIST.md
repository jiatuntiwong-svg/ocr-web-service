# Access & Ownership Checklist

> **Purpose:** a single place listing which accounts/services this project
> depends on, who owns them today, and what a new collaborator needs
> before they can develop, debug, or deploy. This is a **template** —
> Claude filled in the structure and what's inferable from the repo
> (env var names, service names), but the actual account emails, billing
> owners, and access-granting steps need the project owner to fill in.
> Treat every `[ FILL IN ]` marker as an open item.

---

## 1. Accounts / services this project depends on

| Service | Used for | Account owner | How to request access |
|--|--|--|--|
| **Cloudflare** | Workers hosting, D1 database, R2 storage, deploy | [ FILL IN — account email ] | [ FILL IN ] |
| **GitHub** (`jiatuntiwong-svg/ocr-web-service`) | Source, PRs | [ FILL IN ] | [ FILL IN — org invite? direct add? ] |
| **Google AI Studio** | Gemini API key (`GEMINI_API_KEY`) | [ FILL IN ] | https://aistudio.google.com/app/apikey — note whether this is a personal or shared/service account |
| **Google Cloud / Vertex AI** | Vertex AI Express-mode key (alternate AI provider) | [ FILL IN ] | Only needed if switching the active provider to Vertex in Admin → API Settings |
| **Stripe** | Billing (subscriptions + credit top-ups) | [ FILL IN ] | Dashboard: https://dashboard.stripe.com — clarify test vs. live mode access separately |
| **Production URL / DNS** | `ocr-web-service.jiatuntiwong.workers.dev` (Workers subdomain — is there a custom domain planned?) | [ FILL IN ] | n/a unless custom domain exists |

## 2. What's manual-only (no self-service today)

- **Deploys are owner-only.** Per `README.md` / `docs/OPS_RUNBOOK.md` §1 —
  collaborators open PRs; only the owner runs `npm run deploy`. There is no
  CI/CD auto-deploy gate.
- **Production secrets** (`SESSION_SECRET`, `GEMINI_API_KEY`, Stripe keys)
  are set via `npx wrangler secret put` — requires Cloudflare account
  access with Workers write permission. See `docs/OPS_RUNBOOK.md` §4.
- **AI provider key rotation** (Gemini/OpenAI/OpenRouter/Vertex) can be
  done by any **admin user** of the app itself (Admin → API Settings) —
  does not require Cloudflare/infra access. Clarify who currently holds
  admin role on the production database: [ FILL IN ].

## 3. New-collaborator onboarding checklist

For whoever picks this up next (contractor, new hire, future you):

- [ ] GitHub repo access (read or write — clarify PR vs. direct-push policy)
- [ ] Local `.dev.vars` set up from `.dev.vars.example` — needs at minimum a
      `GEMINI_API_KEY` (free tier at https://aistudio.google.com/app/apikey)
      to run OCR locally; Stripe keys only needed for billing work
- [ ] Confirm whether they need a Cloudflare account invite (only needed for
      deploy/secrets access, not for day-to-day feature dev — `npm run dev`
      and `npm run preview` don't require it)
- [ ] Test user credentials for the app itself (see
      `docs/BEHAVIOR_REFERENCE.md` §3 for the test-account convention:
      free/pro/admin roles) — [ FILL IN whether these exist in prod or need
      to be created ]
- [ ] Point them at `README.md` (setup), `docs/MIGRATION.md` (architecture,
      if relevant to their task), `docs/BEHAVIOR_REFERENCE.md` (expected
      behavior), `docs/SECURITY_HANDOFF.md` (what's reviewed vs. open),
      `pm/README.md` (how the internal sprint-tracking folder works)

## 4. Billing / cost ownership

- Cloudflare Workers/D1/R2 usage bill: [ FILL IN — which card/account ]
- Stripe account fees + payout destination: [ FILL IN ]
- Google AI Studio / Vertex API usage cost: [ FILL IN — is there a budget
  alert configured? Admin → AI Usage dashboard shows token counts but not
  a $ figure tied to a billing alert ]

## 5. Emergency contacts / escalation

- Security-sensitive issue (leaked secret, auth bug): contact the owner
  directly, **not** a public GitHub issue (per `docs/MIGRATION.md` §11).
- Production incident: [ FILL IN — is there any monitoring/alerting beyond
  `wrangler tail` manual checks? Per `docs/PENDING_FEATURES_BACKLOG.md`,
  "Error tracking (Sentry / better CF logs)" and "Health check endpoint
  monitoring" are both still open items, not yet in place ]

---

**Next step:** if this project is actually being handed off soon, the
`[ FILL IN ]` markers above are the concrete list of things to gather
before the handoff, not just documentation nice-to-haves.
