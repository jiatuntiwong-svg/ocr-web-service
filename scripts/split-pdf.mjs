// scripts/split-pdf.mjs
//
// Split a multi-page PDF into (a) a page-1-only extract and (b) preserve the
// full bundle at a stable path under test_fixtures/. Built for TEST-1
// (control test: single-page split of the Thai form) — see pm/tasks/qa-tester.md.
//
// Usage:
//   node scripts/split-pdf.mjs <source.pdf>
//
// Example:
//   node scripts/split-pdf.mjs "C:/Users/User/Downloads/ใบตัดจ่ายภาคฯ 3 รอบที่ 2 ม.ค.69.pdf"
//
// Outputs (relative to repo root):
//   test_fixtures/thai-form/page1-only.pdf
//   test_fixtures/thai-form/full-7page.pdf   (copy of the source)
//
// Notes:
// - Depends only on pdf-lib (already in package.json).
// - Does NOT commit the outputs. Operator must confirm PII policy before `git add`.

import { PDFDocument } from "pdf-lib";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "test_fixtures", "thai-form");

async function main() {
  const src = process.argv[2];
  if (!src) {
    console.error("Usage: node scripts/split-pdf.mjs <source.pdf>");
    process.exit(1);
  }
  if (!existsSync(src)) {
    console.error(`Source file not found: ${src}`);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });

  const bytes = await readFile(src);
  const srcDoc = await PDFDocument.load(bytes);
  const pageCount = srcDoc.getPageCount();
  console.log(`Loaded source: ${pageCount} page(s)`);

  // Build page-1-only doc
  const outDoc = await PDFDocument.create();
  const [copiedPage] = await outDoc.copyPages(srcDoc, [0]);
  outDoc.addPage(copiedPage);
  const outBytes = await outDoc.save();

  const page1Path = path.join(outDir, "page1-only.pdf");
  const fullPath = path.join(outDir, "full-7page.pdf");
  await writeFile(page1Path, outBytes);
  await copyFile(src, fullPath);

  console.log(`Wrote: ${page1Path}`);
  console.log(`Wrote: ${fullPath}`);
  console.log("Done. Remember: do NOT commit these files without operator PII sign-off.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
