// scripts/ocr-regression/smoke-config.mjs
//
// Config-schema smoke — parses a case config and prints the plan. No browser,
// no network, no Playwright. Use to catch JSON errors + category misassignments
// before an operator burns credits.
//
// Usage:
//   node scripts/ocr-regression/smoke-config.mjs scripts/ocr-regression/cases/benchmark.json

import { readFile } from "node:fs/promises";
import path from "node:path";

const cfgPath = path.resolve(process.argv[2] || "scripts/ocr-regression/cases/benchmark.json");
const cfg = JSON.parse(await readFile(cfgPath, "utf8"));

const isBench = !!cfg.categories && cfg.cases?.[0]?.category;
console.log(`Config: ${cfgPath}`);
console.log(`Suite:  ${cfg.suite}   (${isBench ? "BENCHMARK" : "LEGACY"} shape)`);
console.log(`Cases:  ${cfg.cases.length}`);
if (isBench) {
  const byCat = {};
  for (const c of cfg.cases) byCat[c.category] = (byCat[c.category] || 0) + 1;
  console.log("\nPer category:");
  for (const [cat, meta] of Object.entries(cfg.categories)) {
    const n = byCat[cat] || 0;
    const flag = n >= 2 ? "OK " : "!! ";
    console.log(`  ${flag}${cat.padEnd(14)} ${n} case${n === 1 ? "" : "s"}  — ${meta.label}`);
    if (n < 2) console.log(`     WARN: fewer than 2 cases; S2-1 target is >= 2 per category.`);
  }
  const orphan = cfg.cases.filter(c => !cfg.categories[c.category]);
  if (orphan.length) {
    console.log("\nOrphan cases (category not declared in categories{}):");
    for (const c of orphan) console.log(`  - ${c.id} → "${c.category}"`);
  }
  const missingGuards = cfg.cases.filter(c => !c.guards_issue);
  if (missingGuards.length) {
    console.log("\nCases missing guards_issue link:");
    for (const c of missingGuards) console.log(`  - ${c.id}`);
  }
}
console.log("\nSmoke OK.");
