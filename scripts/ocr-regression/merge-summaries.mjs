// scripts/ocr-regression/merge-summaries.mjs
//
// S2-1c: combine multiple `_summary-*.json` snapshots (produced by
// scripts/ocr-regression/run.mjs) into ONE baseline-shape snapshot.
//
// Why this exists: full-suite single-shot benchmarks against prod hit a
// provider/edge rate limit around case 4-5 (net::ERR_ABORTED). The proven
// workaround is to run one category per batch with a 2-3 min cooldown
// between batches — but each batch writes its own `_summary-*.json`. This
// script fuses those partial summaries into a single baseline-shape file
// suitable for `--fail-under` gating and delta tracking.
//
// CLI:
//   node scripts/ocr-regression/merge-summaries.mjs \
//     --input pm/reports/OCR-2-runs/_summary-A.json \
//     --input pm/reports/OCR-2-runs/_summary-B.json \
//     --output pm/reports/OCR-2-runs/_baseline.json
//
//   node scripts/ocr-regression/merge-summaries.mjs \
//     --glob 'pm/reports/OCR-2-runs/_summary-2026-07-13T16-*.json' \
//     --output pm/reports/OCR-2-runs/_baseline.json
//
// Output shape: same schema as an individual summary
// (`scoring.overall`, `scoring.perCategory`, `casesRun`, `cases[]`) PLUS
// `synthetic: true`, `syntheticSources[]`, `syntheticNotes`.
//
// Logic:
//   - Union of all `cases[]` across inputs.
//   - On duplicate case id, keep the entry from the input with the LATEST
//     `startedAt` timestamp; warn on the shadowed one.
//   - Recompute `scoring.overall` (pooled) and `scoring.perCategory`
//     (arithmetic mean of case pass rates + meets-threshold ratio).
//   - `casesRun` = number of unique non-skipped cases in the merged set.
//   - Reuse the first input's `suite`, `baseUrl`, `config` metadata; warn
//     on conflicts. Fail-fast if `config` paths disagree.
//
// Fail-fast on: no inputs matched, missing input file, malformed JSON,
// unknown flag, conflicting config paths.

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const HELP = `
Merge batched OCR-2 benchmark summaries into a single baseline snapshot.

Usage:
  node scripts/ocr-regression/merge-summaries.mjs [flags]

Flags:
  --input <path>          summary JSON to merge. Repeat for each input.
  --glob <pattern>        alternative to --input: expand a glob pattern
                          (e.g. 'pm/reports/OCR-2-runs/_summary-2026-07-13T16-*.json').
                          Only the '*' wildcard is honored (no '**' recursion).
  --output <path>         where to write the merged baseline JSON. Required.
  --notes <text>          override the default syntheticNotes string.
  --dry-run               parse + score + print result but don't write output.
  --help, -h              this help.

Example — lock a fresh baseline after 5 batched category runs:
  node scripts/ocr-regression/merge-summaries.mjs \\
    --glob 'pm/reports/OCR-2-runs/_summary-2026-07-13T16-*.json' \\
    --output pm/reports/OCR-2-runs/_baseline.json

Output shape:
  Same as scripts/ocr-regression/run.mjs summary
  (scoring.overall, scoring.perCategory, cases[], casesRun) plus:
    synthetic: true
    syntheticSources: [{ path, timestamp }]
    syntheticNotes:  human-readable explanation
`;

const DEFAULT_NOTES =
  "Merged from batched category runs due to Cloudflare/provider rate limit " +
  "that cuts single-shot full-suite benchmarks off around case 4-5. See " +
  "scripts/ocr-regression/README.md § Batched baseline procedure.";

function parseArgs(argv) {
  const out = { inputs: [], globs: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const eq = (k) => a === k || a.startsWith(k + "=");
    const val = (k) => a.startsWith(k + "=") ? a.slice(k.length + 1) : argv[++i];
    if (eq("--input")) out.inputs.push(val("--input"));
    else if (eq("--glob")) out.globs.push(val("--glob"));
    else if (eq("--output")) out.output = val("--output");
    else if (eq("--notes")) out.notes = val("--notes");
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

async function expandGlob(pattern) {
  // Support only '*' (single-segment wildcard) in the basename portion. That
  // covers the intended _summary-<date>*.json use case and avoids depending
  // on a glob library. If a caller needs '**' they can use --input instead.
  const abs = path.resolve(pattern);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (base.includes("**")) {
    throw new Error(`--glob '${pattern}': '**' is not supported. Use multiple --input flags or a shallower pattern.`);
  }
  const esc = base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp("^" + esc + "$");
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new Error(`--glob '${pattern}': cannot read directory ${dir}: ${err.message}`);
  }
  return entries.filter((e) => re.test(e)).map((e) => path.join(dir, e)).sort();
}

async function loadSummary(p) {
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch (err) {
    throw new Error(`Cannot read input ${p}: ${err.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed JSON in ${p}: ${err.message}`);
  }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.cases)) {
    throw new Error(`Input ${p} is not a summary JSON (missing cases[]).`);
  }
  return obj;
}

// Recompute overall + per-category scoring from a merged case list.
// Each case entry is baseline-shape:
//   { id, category, skipped, skipReason, runs, passRate, minPassRate, meetsThreshold }
// where `runs` is a COUNT (not an array).
function scoreMerged(cases) {
  const byCat = {};
  let sumPass = 0;
  let sumRuns = 0;
  let sumCases = 0;
  for (const c of cases) {
    if (c.skipped) continue;
    const total = Number(c.runs) || 0;
    const rate = Number(c.passRate) || 0;
    const passes = Math.round(rate * total);
    sumPass += passes;
    sumRuns += total;
    sumCases += 1;
    if (!byCat[c.category]) byCat[c.category] = { cases: 0, sumRate: 0, meets: 0 };
    byCat[c.category].cases += 1;
    byCat[c.category].sumRate += rate;
    if (c.meetsThreshold) byCat[c.category].meets += 1;
  }
  const perCategory = Object.fromEntries(
    Object.entries(byCat).map(([k, v]) => [k, {
      cases: v.cases,
      passRate: v.cases ? v.sumRate / v.cases : 0,
      meetsThreshold: v.cases ? v.meets / v.cases : 0,
    }])
  );
  return {
    overall: sumRuns ? sumPass / sumRuns : 0,
    perCategory,
    casesRun: sumCases,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  // Resolve --glob → paths, dedup with --input paths (order preserved).
  const globbed = [];
  for (const g of args.globs) {
    const matched = await expandGlob(g);
    if (!matched.length) {
      throw new Error(`--glob '${g}' matched no files.`);
    }
    globbed.push(...matched);
  }
  const seen = new Set();
  const paths = [];
  for (const p of [...args.inputs, ...globbed]) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    paths.push(abs);
  }

  if (!paths.length) {
    console.error("No inputs. Use --input <path> (repeatable) or --glob <pattern>.");
    console.error(HELP);
    process.exit(1);
  }
  if (!args.output && !args.dryRun) {
    console.error("Missing --output. (Use --dry-run to preview without writing.)");
    process.exit(1);
  }

  // Load all inputs.
  const summaries = [];
  for (const p of paths) {
    const s = await loadSummary(p);
    summaries.push({ path: p, summary: s });
  }

  // Sort by startedAt ascending so "latest wins" is deterministic on dup case ids.
  summaries.sort((a, b) => String(a.summary.startedAt || "").localeCompare(String(b.summary.startedAt || "")));

  // Metadata reconciliation — first non-empty wins, warn on conflicts.
  let suite = null;
  let baseUrl = null;
  let cfg = null;
  for (const { path: p, summary: s } of summaries) {
    if (!suite && s.suite) suite = s.suite;
    else if (suite && s.suite && s.suite !== suite) {
      console.warn(`[merge] suite mismatch in ${path.relative(repoRoot, p)}: '${s.suite}' vs '${suite}' — keeping first.`);
    }
    if (!baseUrl && s.baseUrl) baseUrl = s.baseUrl;
    else if (baseUrl && s.baseUrl && s.baseUrl !== baseUrl) {
      console.warn(`[merge] baseUrl mismatch in ${path.relative(repoRoot, p)}: '${s.baseUrl}' vs '${baseUrl}' — keeping first.`);
    }
    if (!cfg && s.config) cfg = s.config;
    else if (cfg && s.config && s.config !== cfg) {
      throw new Error(`config path mismatch: '${s.config}' (${p}) vs '${cfg}'. Refusing to merge summaries from different suites.`);
    }
  }

  // Dedup cases by id — LATEST timestamp wins.
  const byId = new Map();
  for (const { path: p, summary: s } of summaries) {
    const ts = String(s.startedAt || "");
    for (const c of s.cases) {
      if (!c || !c.id) continue;
      const prev = byId.get(c.id);
      if (prev) {
        // summaries are sorted ascending → current one is newer (or equal).
        console.warn(`[merge] duplicate case id '${c.id}': keeping entry from ${path.relative(repoRoot, p)} (${ts}), shadowing ${path.relative(repoRoot, prev.sourcePath)} (${prev.sourceTs}).`);
      }
      byId.set(c.id, { ...c, sourcePath: p, sourceTs: ts });
    }
  }

  // Strip provenance fields we tacked on for warning purposes.
  const mergedCases = [...byId.values()].map(({ sourcePath, sourceTs, ...rest }) => rest);

  const scoring = scoreMerged(mergedCases);

  const syntheticSources = summaries.map(({ path: p, summary: s }) => ({
    path: path.relative(repoRoot, p).replace(/\\/g, "/"),
    timestamp: s.startedAt || null,
  }));

  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const out = {
    suite: suite || "unnamed",
    startedAt: now,
    baseUrl: baseUrl || null,
    config: cfg || null,
    scoring,
    delta: null,
    previousSummary: null,
    cases: mergedCases,
    synthetic: true,
    syntheticSources,
    syntheticNotes: args.notes || DEFAULT_NOTES,
  };

  const pct = (n) => `${Math.round(n * 1000) / 10}%`;
  console.log(`Merged ${summaries.length} summaries → ${mergedCases.length} unique cases (${scoring.casesRun} scored, ${mergedCases.length - scoring.casesRun} skipped).`);
  console.log(`Overall: ${pct(scoring.overall)}`);
  for (const [cat, s] of Object.entries(scoring.perCategory)) {
    console.log(`  ${cat.padEnd(14)} ${pct(s.passRate)}  (${s.cases} cases, meets ${pct(s.meetsThreshold)})`);
  }

  if (args.dryRun) {
    console.log("\n[dry-run] not writing output.");
    return;
  }

  const outPath = path.resolve(args.output);
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote: ${outPath}`);
}

main().catch((err) => { console.error(String(err?.message || err)); process.exit(1); });
