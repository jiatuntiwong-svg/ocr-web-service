// scripts/ocr-regression/generate-fixtures.mjs
//
// Render every regression HTML fixture to a matching PDF.
//
// S2-1 layout:
//   test_fixtures/regression/<category>/*.html      →   .../<category>/generated/*.pdf
//   test_fixtures/regression/*.html (legacy flat)   →   .../generated/*.pdf
//
// Uses Playwright chromium (already required by the runner) — no extra dep.
// If Playwright is not installed, prints operator instructions and exits 1.
//
// Usage:
//   node scripts/ocr-regression/generate-fixtures.mjs
//   node scripts/ocr-regression/generate-fixtures.mjs --category thai-form
//   node scripts/ocr-regression/generate-fixtures.mjs --dry-run
//
// Design notes:
// - HTML sources are the commit-safe source of truth. PDFs are gitignore-eligible.
// - A4 portrait by default; category "landscape" is rendered A4 landscape so the
//   letterbox coordinate-remap path (OCR-6c) is actually exercised.
// - Content deliberately large + high contrast so the client-side 3600px
//   rasterization (OCRWorkspaceV2 upstream of /api/upload) renders crisp text.

import { readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const rootSrc = path.join(repoRoot, "test_fixtures", "regression");

const CATEGORIES = ["thai-form", "dense", "landscape", "tables", "multi-column", "multi-page"];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--category") out.category = argv[++i];
    else if (a.startsWith("--category=")) out.category = a.slice("--category=".length);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

// Enumerate {srcHtml, outPdf, landscape} tuples from the fixture tree.
async function collectFixtures(only) {
  const jobs = [];
  // Flat legacy files under regression/ (kept for backward compat)
  const rootEntries = (await readdir(rootSrc)).filter(f => f.endsWith(".html"));
  for (const f of rootEntries) {
    if (only && only !== "_legacy") continue;
    jobs.push({
      category: "_legacy",
      srcHtml: path.join(rootSrc, f),
      outPdf: path.join(rootSrc, "generated", f.replace(/\.html$/, ".pdf")),
      landscape: false,
    });
  }
  // Categorized fixtures
  for (const cat of CATEGORIES) {
    if (only && only !== cat) continue;
    const catDir = path.join(rootSrc, cat);
    if (!(await isDir(catDir))) continue;
    const files = (await readdir(catDir)).filter(f => f.endsWith(".html"));
    for (const f of files) {
      jobs.push({
        category: cat,
        srcHtml: path.join(catDir, f),
        outPdf: path.join(catDir, "generated", f.replace(/\.html$/, ".pdf")),
        landscape: cat === "landscape",
      });
    }
  }
  return jobs;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("Usage: node scripts/ocr-regression/generate-fixtures.mjs [--category NAME] [--dry-run]");
    return;
  }

  const jobs = await collectFixtures(args.category);
  if (!jobs.length) {
    console.error(`No .html fixtures found${args.category ? ` in category "${args.category}"` : ""}.`);
    process.exit(1);
  }
  console.log(`Planned: ${jobs.length} fixture${jobs.length === 1 ? "" : "s"}`);
  for (const j of jobs) {
    console.log(`  [${j.category.padEnd(12)}] ${path.relative(repoRoot, j.srcHtml).replace(/\\/g, "/")} → ${path.relative(repoRoot, j.outPdf).replace(/\\/g, "/")}${j.landscape ? "  (landscape)" : ""}`);
  }
  if (args.dryRun) return;

  let playwright;
  try { playwright = await import("@playwright/test"); }
  catch {
    console.error("\n@playwright/test not installed. See scripts/ocr-e2e/README.md.");
    process.exit(1);
  }
  const { chromium } = playwright;

  const browser = await chromium.launch();
  const context = await browser.newContext();
  for (const j of jobs) {
    await mkdir(path.dirname(j.outPdf), { recursive: true });
    const page = await context.newPage();
    const url = "file://" + j.srcHtml.replace(/\\/g, "/");
    await page.goto(url);
    await page.emulateMedia({ media: "print" });
    await page.pdf({
      path: j.outPdf,
      format: "A4",
      landscape: j.landscape,
      printBackground: true,
      margin: { top: "15mm", bottom: "15mm", left: "15mm", right: "15mm" },
    });
    await page.close();
    console.log(`Wrote: ${path.relative(repoRoot, j.outPdf).replace(/\\/g, "/")}`);
  }
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
