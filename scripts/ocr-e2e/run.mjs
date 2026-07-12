// scripts/ocr-e2e/run.mjs
//
// CLI entry for the OCR e2e harness. Loads a JSON case file, opens a Playwright
// browser, runs each case N times, records raw returned values, and writes a
// JSON result file the operator can paste into pm/reports/TEST-1.md.
//
// Usage:
//   node scripts/ocr-e2e/run.mjs --config scripts/ocr-e2e/cases/test-1.json
//
// Prereqs: see scripts/ocr-e2e/README.md. Playwright must be installed and
// OCR_E2E_* env vars set (via .env.local or shell).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

// ── env loader (minimal .env.local parser — no dotenv dep) ─────────────────
async function loadEnvLocal() {
  try {
    const raw = await readFile(path.join(repoRoot, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* .env.local optional */ }
}

function interpolate(str) {
  return typeof str === "string"
    ? str.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "")
    : str;
}

async function main() {
  await loadEnvLocal();

  const cfgArgIdx = process.argv.indexOf("--config");
  if (cfgArgIdx === -1) {
    console.error("Usage: node scripts/ocr-e2e/run.mjs --config <case.json>");
    process.exit(1);
  }
  const cfgPath = path.resolve(process.argv[cfgArgIdx + 1]);
  const cfg = JSON.parse(await readFile(cfgPath, "utf8"));

  const baseUrl = process.env.OCR_E2E_BASE_URL || "http://localhost:8788";
  const email = process.env.OCR_E2E_EMAIL;
  const password = process.env.OCR_E2E_PASSWORD;

  const missing = [];
  if (!email) missing.push("OCR_E2E_EMAIL");
  if (!password) missing.push("OCR_E2E_PASSWORD");
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}. See scripts/ocr-e2e/README.md.`);
    process.exit(1);
  }

  let playwright;
  try {
    playwright = await import("@playwright/test");
  } catch {
    console.error("@playwright/test is not installed. Run: npm install --save-dev @playwright/test && npx playwright install chromium");
    process.exit(1);
  }
  const { chromium } = playwright;
  const { runOcrCase } = await import("./harness.mjs");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const results = { suite: cfg.suite, startedAt: new Date().toISOString(), baseUrl, cases: [] };

  for (const c of cfg.cases) {
    const templateName = interpolate(c.templateName || cfg.defaults.templateName);
    const targetField = c.targetField || cfg.defaults.targetField;
    const expected = c.expected || cfg.defaults.expected;
    const runs = c.runs || cfg.defaults.runs || 3;
    const filePath = path.resolve(repoRoot, c.file);

    const caseResult = { id: c.id, file: c.file, expected, runs: [] };
    for (let i = 0; i < runs; i++) {
      const page = await context.newPage();
      let value = null, error = null;
      const t0 = Date.now();
      try {
        value = await runOcrCase({ page, baseUrl, email, password, filePath, templateName, targetField });
      } catch (err) {
        error = String(err?.message || err);
      }
      const ms = Date.now() - t0;
      caseResult.runs.push({ i: i + 1, value, error, ms });
      console.log(`[${c.id}] run ${i + 1}/${runs}: ${value ? JSON.stringify(value) : `ERROR: ${error}`} (${ms} ms)`);
      await page.close();
    }
    results.cases.push(caseResult);
  }

  await browser.close();

  const outDir = path.join(repoRoot, "pm", "reports", "test-1-runs");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `run-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`Wrote: ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
