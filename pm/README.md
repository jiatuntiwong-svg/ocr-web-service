# `pm/` — Internal Sprint-Tracking System

> **If you're new here:** this folder is **not** user-facing product
> documentation — that lives in `docs/`. This folder is the project
> owner's internal system for running development work across a set of
> specialized AI agent roles (ocr-pipeline, frontend-ui, backend-api,
> qa-tester, database, billing-payment, devops-cloudflare, docs-manager).
> If you're a new engineer, contractor, or the receiving team on a
> handoff, read this page first so the rest of the folder makes sense —
> then treat it as a detailed change log / decision log, not a spec.

## What's in here

| File | What it is | Read it for |
|--|--|--|
| `BOARD.md` | The sprint board — one row per task ID (e.g. `OCR-6`, `API-2`, `UI-4c`), its status, and a running decision log underneath | "What shipped, when, and why was this decision made" — the single richest history of the project's recent evolution |
| `tasks/<agent>.md` | Work orders per agent role — the brief each agent was given for its tasks | Understanding *why* a piece of code exists the way it does — the task file usually explains the constraint or context that shaped the implementation |
| `reports/<ID>.md` | One file per completed task ID, written by the agent that did the work | The actual detail: files changed, what was verified, open follow-ups. This is more granular and more current than anything in `docs/` — when in doubt about whether a feature is really shipped, check here before trusting a `docs/` file, since `docs/` is synced from here (not the other way around) |

## How to read a task ID

Task IDs are prefixed by area: `OCR-*` (extraction pipeline), `API-*`
(backend routes), `UI-*` (frontend), `BILL-*` (billing/credits), `DB-*`
(schema), `OPS-*` (infra/Cloudflare), `TEST-*` / `S2-*` (QA, Sprint-2
scaffolding), `DOC-*` (docs sync), `AI-*` (AI provider integration). The
number after the prefix is sequential within that area, not global — `AI-1`
and `API-1` are unrelated tasks that happened to both be "the first one."

## Status symbols (from `BOARD.md`)

`⏳ todo` → `🔨 in progress` → `👀 review` → `✅ done` (owner-approved) |
`🚫 blocked` | `⚪ hold` (deliberately paused, not abandoned)

A `👀 review` row means an agent finished and wrote its report, but the
project owner hasn't signed off yet — treat review-status work as
provisional, not confirmed-shipped, until the BOARD row flips to `✅`.

## Why this exists / how it's meant to be used

The project owner runs feature work by opening a session against a
specific `pm/tasks/<agent>.md` file (e.g. "use the ocr-pipeline agent to
work on OCR-9"), the agent does the work and writes `pm/reports/OCR-9.md`,
then the owner reviews and flips the `BOARD.md` row to `✅`. `docs-manager`
is itself one of these agent roles — its job is specifically to keep the
files in `docs/` (the actual product-facing living docs: testing log,
behavior reference, pending issues, etc.) in sync with what `BOARD.md` +
`reports/` say actually shipped. See `pm/reports/DOC-1-sprint-close.md` for
an example sync pass, including what it deliberately chose *not* to touch
and why.

## If you're using this folder to catch up on the project

Read in this order: `BOARD.md`'s status table (top) for the current
state → the "Decision log" underneath it for *why* things went the way
they did → `docs/BEHAVIOR_REFERENCE.md` for what the shipped product
actually does, flow by flow → individual `reports/<ID>.md` files only when
you need implementation-level detail on one specific piece.

Don't expect this folder to explain the product to a customer or a
non-technical stakeholder — for that, `README.md` (root) and `docs/`
are the right entry points.
