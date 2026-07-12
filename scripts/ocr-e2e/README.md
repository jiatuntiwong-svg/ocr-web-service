# ocr-e2e — Playwright harness for OCR regression / TEST-1

Purpose: drive the real DOCRoom OCR UI end-to-end (login → OCR page → template select → upload → extract → scrape a specific field value). Built as the foundation for TEST-1 (control test) and OCR-2 (regression suite).

## Prerequisites (operator)

Playwright is **not** currently installed in this repo. Add it before running:

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

Confirm with the maintainer before committing — Playwright + chromium is a ~200 MB dev dep bump.

## Required env vars

Add to `.env.local` (or set in shell before running):

```
OCR_E2E_BASE_URL=http://localhost:8788      # 8788 = wrangler/preview default
OCR_E2E_EMAIL=<dev/test account email>
OCR_E2E_PASSWORD=<dev/test account password>
OCR_E2E_TEMPLATE_NAME=<name of the template with ผู้รับโอน bbox_hint already persisted>
```

The harness reads `.env.local` at startup. Never hardcode credentials.

## Running TEST-1

1. Start the app in preview mode (workerd):
   ```bash
   npm run preview
   ```
2. In a second shell:
   ```bash
   node scripts/ocr-e2e/run.mjs --config scripts/ocr-e2e/cases/test-1.json
   ```

The runner executes each case N times (default 3), logs the raw returned value per run, and writes a JSON result file under `pm/reports/test-1-runs/` for the human to paste into `pm/reports/TEST-1.md`.

## Files

- `run.mjs` — CLI entry, loads config + env, drives Playwright.
- `harness.mjs` — the pure Playwright flow (login → OCR → scrape).
- `cases/test-1.json` — TEST-1 matrix (page1-only × 3, full-7page × 3).

## Extensibility (OCR-2)

Each case is a JSON object `{ id, file, templateName, targetField, expected, runs }`. Add new cases by dropping new JSON files under `cases/`. Same harness, no code changes.
