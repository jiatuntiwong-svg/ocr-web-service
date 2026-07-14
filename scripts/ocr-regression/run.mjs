// scripts/ocr-regression/run.mjs
//
// OCR-2 / S2-1 benchmark regression runner. Reuses the TEST-1 Playwright
// harness at scripts/ocr-e2e/harness.mjs — no code duplication.
//
// Config formats supported (auto-detected):
//   1. LEGACY   — top-level `cases[]` with `assertion` + `expect` fields
//                 (scripts/ocr-regression/cases/ocr-2.json, ocr-6b.json)
//   2. BENCHMARK — S2-1 shape: top-level `categories{}` + `cases[]` with
//                 `category`, `expected`, `min_pass_rate`, `guards_issue`
//                 (scripts/ocr-regression/cases/benchmark.json)
//
// Per case:
//   - drive real UI (login → OCR page → template → upload fixture → extract)
//   - repeat N times (default 3 legacy / 10 benchmark, variance-aware)
//   - apply the case's assertion (verbatim / prefix / multiline / disambig /
//     corrections_report / table_structure)
//   - record raw value + pass/fail per run
//
// Outputs:
//   pm/reports/OCR-2-runs/<caseId>-<timestamp>.json     (raw, per case)
//   pm/reports/OCR-2-runs/_summary-<timestamp>.json     (suite roll-up + scoring)
//   pm/reports/OCR-2-latest.md                          (human 30-second read)
//
// CLI:
//   node scripts/ocr-regression/run.mjs --config <path.json>
//     [--category <name>]     run only cases in that category
//     [--case <id>]           run only that one case (comma-separated ok)
//     [--runs <N>]            override runs per case
//     [--fail-under <score>]  exit 1 if overall score < N (0..1); CI hook
//     [--log silent|normal|verbose]
//     [--dry-run]             parse + print planned matrix, don't launch browser
//     [--help]
//
// Prereqs: Playwright + `.env.local` creds. See scripts/ocr-e2e/README.md.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

// ── Arg parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { logLevel: "normal" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const eq = (k) => a === k || a.startsWith(k + "=");
    const val = (k) => a.startsWith(k + "=") ? a.slice(k.length + 1) : argv[++i];
    if (eq("--config")) out.config = val("--config");
    else if (eq("--category")) out.category = val("--category");
    else if (eq("--case")) out.case = val("--case");
    else if (eq("--runs")) out.runs = Number(val("--runs"));
    else if (eq("--fail-under")) out.failUnder = Number(val("--fail-under"));
    else if (eq("--log")) out.logLevel = val("--log");
    else if (eq("--delay-ms")) out.delayMs = Number(val("--delay-ms"));
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("--") && !out.config) out.config = a;
  }
  return out;
}

const HELP = `
OCR-2 / S2-1 benchmark regression runner

Usage:
  node scripts/ocr-regression/run.mjs --config <path.json> [flags]

Flags:
  --config <path>         case config (JSON). Required.
  --category <name>       filter by category (e.g. thai-form, dense, landscape, tables, multi-column)
  --case <id[,id...]>     filter by case id(s)
  --runs <N>              override runs-per-case
  --fail-under <score>    exit 1 if overall score < N (0..1). CI use.
  --log silent|normal|verbose
  --delay-ms <N>          sleep N ms after each PASSING run (both inter-run
                          within a case and inter-case). Skipped after the
                          final run. Default 0. Use to pace against
                          provider/edge rate limits when running the full
                          suite in one shot.
  --dry-run               parse + print planned run matrix, do not launch browser
  --help, -h              this help

Env (from .env.local or shell):
  OCR_E2E_BASE_URL, OCR_E2E_EMAIL, OCR_E2E_PASSWORD,
  OCR_E2E_REGRESSION_TEMPLATE, OCR_E2E_DENSE_TEMPLATE,
  OCR_E2E_LANDSCAPE_TEMPLATE, OCR_E2E_TABLE_TEMPLATE

See scripts/ocr-regression/README.md for the category matrix and case list.
`;

// ── Env / interpolation ─────────────────────────────────────────────────────
async function loadEnvLocal() {
  try {
    const raw = await readFile(path.join(repoRoot, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* optional */ }
}

function interpolate(str) {
  return typeof str === "string"
    ? str.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "")
    : str;
}

// ── Assertions ──────────────────────────────────────────────────────────────
// Each assertion returns { pass: bool, reason: string }.
const ASSERTIONS = {
  verbatim({ value, corrections = [] }, spec) {
    const expected = spec.expected;
    if (value === expected) return { pass: true, reason: "exact match" };
    const reported = corrections.some(c => c.original && c.original.includes(expected));
    if (reported) return { pass: true, reason: "AI corrected but reported via corrections[]" };
    return { pass: false, reason: `got "${value}", expected "${expected}"; no corrections[] entry` };
  },
  prefix({ value }, spec) {
    if (typeof value !== "string") return { pass: false, reason: "no value" };
    if (value.startsWith(spec.prefix)) return { pass: true, reason: `starts with "${spec.prefix}"` };
    return { pass: false, reason: `got "${value}" — missing prefix "${spec.prefix}"` };
  },
  multiline({ value }, spec) {
    if (typeof value !== "string") return { pass: false, reason: "no value" };
    // Normalize any run of whitespace (incl. newlines) to a single space
    // before matching — line-wrap variance in AI output shouldn't fail
    // semantic content. The join-preservation check below still verifies
    // the lines are separated (originally by \n).
    const norm = s => s.replace(/\s+/g, " ").trim();
    const stripWs = s => s.replace(/\s+/g, "");
    const nValue = norm(value);
    const sValue = stripWs(value);
    // Thai text doesn't use whitespace as word separator, so mid-word line
    // wraps from AI output shouldn't fail semantic content. Match against
    // whitespace-normalized AND whitespace-stripped forms.
    const missing = spec.lines.filter(l => !nValue.includes(norm(l)) && !sValue.includes(stripWs(l)));
    if (missing.length) return { pass: false, reason: `missing lines: ${JSON.stringify(missing)}` };
    if (spec.mustNotContain) {
      const bad = spec.mustNotContain.filter(x => nValue.includes(norm(x)));
      if (bad.length) return { pass: false, reason: `contains forbidden phrases: ${JSON.stringify(bad)}` };
    }
    // Line separation check: original value must have SOME whitespace/newline
    // between adjacent expected lines (not concatenated).
    for (let i = 0; i < spec.lines.length - 1; i++) {
      const a = norm(spec.lines[i]);
      const b = norm(spec.lines[i + 1]);
      const joined = nValue.indexOf(a + b);
      const sep = nValue.indexOf(a + " " + b);
      if (joined !== -1 && sep === -1) {
        return { pass: false, reason: `lines "${spec.lines[i]}" and "${spec.lines[i + 1]}" appear concatenated without separator` };
      }
    }
    return { pass: true, reason: "all lines present with separators" };
  },
  disambiguation({ value }, spec) {
    if (value === spec.expected) return { pass: true, reason: "picked target column" };
    if (value === spec.sibling) return { pass: false, reason: "picked SIBLING column's value" };
    return { pass: false, reason: `got "${value}" (neither target nor sibling)` };
  },
  corrections_report({ value, corrections = [] }, spec) {
    if (value === spec.original) return { pass: true, reason: "returned original, no correction attempted" };
    if (value === spec.corrected) {
      const entry = corrections.find(c => c.original === spec.original && c.corrected === spec.corrected);
      if (entry) return { pass: true, reason: "correction reported via corrections[]" };
      return { pass: false, reason: `silent correction — value="${spec.corrected}" but corrections[] missing "${spec.original}"→"${spec.corrected}"` };
    }
    return { pass: false, reason: `got "${value}" — neither original nor corrected` };
  },
  // S2-1: structured table assertion. Expects observed.value to be either an
  // array of rows, or a string representation the harness scraped. We accept
  // both and match row-by-row with whitespace tolerance.
  table_structure({ value }, spec) {
    const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();
    let rows = null;
    if (Array.isArray(value)) rows = value;
    else if (typeof value === "string") {
      try { const j = JSON.parse(value); if (Array.isArray(j)) rows = j; } catch {}
      if (!rows) rows = value.split(/\n+/).map(r => r.split(/\t|\s{2,}|\|/).map(norm).filter(Boolean));
    }
    if (!rows || !rows.length) return { pass: false, reason: `no table rows parseable from value` };
    const expected = spec.rows;
    if (rows.length < expected.length) {
      return { pass: false, reason: `got ${rows.length} rows, expected ${expected.length}` };
    }
    // Coerce each row into an array of cell strings. AI may return rows as
    // arrays (["a","b"]) OR objects ({col1:"a",col2:"b"}) OR strings.
    // Row-object shapes seen from AI:
    //   {"Header":"Value"}                  → [Header, Value] (row-header table)
    //   {"col1":"a","col2":"b","col3":"c"}  → [a, b, c]       (column table w/ AI-invented keys)
    // Distinguish by expected row length: if expected has 2 cells and object
    // has 1 key, treat key as first cell + value as second. Otherwise use
    // Object.values() (drop keys — column-name variance shouldn't matter).
    const rowToCells = (r, expectedLen) => {
      if (Array.isArray(r)) return r.map(norm);
      if (r && typeof r === "object") {
        const keys = Object.keys(r);
        if (expectedLen === 2 && keys.length === 1) return [norm(keys[0]), norm(r[keys[0]])];
        return Object.values(r).map(norm);
      }
      if (typeof r === "string") return r.split(/\t|\s{2,}|\|/).map(norm).filter(Boolean);
      return [];
    };
    for (let i = 0; i < expected.length; i++) {
      const expRow = expected[i].map(norm);
      const gotRow = rowToCells(rows[i], expRow.length);
      for (let j = 0; j < expRow.length; j++) {
        if (!gotRow[j] || !gotRow[j].includes(expRow[j])) {
          return { pass: false, reason: `row ${i + 1} col ${j + 1}: got "${gotRow[j] ?? ""}", expected to contain "${expRow[j]}"` };
        }
      }
    }
    return { pass: true, reason: `${expected.length} rows matched` };
  },
};

// ── Config normalization ────────────────────────────────────────────────────
// Bring legacy + benchmark shapes to a single internal form:
//   { suite, defaults, categories: {id: {label, description}}, cases: [{
//     id, category, fixture, template, field, assertion, expectedSpec,
//     minPassRate, runs, guardsIssue, skipIfMissing, notes }] }
function normalizeConfig(cfg) {
  const isBench = !!cfg.categories && cfg.cases?.[0]?.category;
  const defaults = cfg.defaults || {};
  const defaultRuns = defaults.runs ?? (isBench ? 10 : 3);
  const defaultMin = defaults.min_pass_rate ?? 0.8;
  const categories = isBench
    ? cfg.categories
    : { legacy: { label: "Legacy", description: cfg.description || "legacy suite" } };

  const cases = (cfg.cases || []).map(c => {
    if (isBench) {
      return {
        id: c.id,
        category: c.category,
        fixture: c.fixture,
        template: interpolate(c.template || defaults.templateName),
        field: c.field,
        assertion: c.assertion,
        expectedSpec: c.expected,
        minPassRate: c.min_pass_rate ?? defaultMin,
        runs: c.runs ?? defaultRuns,
        guardsIssue: c.guards_issue || null,
        skipIfMissing: c.skip_if_missing ?? false,
        notes: c.notes || null,
      };
    }
    // legacy
    return {
      id: c.id,
      category: "legacy",
      fixture: c.file,
      template: interpolate(c.templateName || defaults.templateName),
      field: c.targetField,
      assertion: c.assertion,
      expectedSpec: c.expect,
      minPassRate: defaultMin,
      runs: c.runs ?? defaultRuns,
      guardsIssue: null,
      skipIfMissing: false,
      notes: c.description || null,
    };
  });

  return {
    suite: cfg.suite || "unnamed",
    description: cfg.description || "",
    defaults,
    categories,
    cases,
    isBench,
  };
}

// ── Scoring ─────────────────────────────────────────────────────────────────
function scoreSuite(cases) {
  const byCat = {};
  let sumPass = 0, sumRuns = 0, sumCases = 0;
  for (const cr of cases) {
    if (cr.skipped) continue;
    const passes = cr.runs.filter(r => r.verdict.pass).length;
    const total = cr.runs.length;
    const rate = total ? passes / total : 0;
    cr.score = rate;
    cr.meetsThreshold = rate >= cr.minPassRate;
    sumPass += passes; sumRuns += total; sumCases += 1;
    if (!byCat[cr.category]) byCat[cr.category] = { cases: 0, sumRate: 0, meets: 0 };
    byCat[cr.category].cases++;
    byCat[cr.category].sumRate += rate;
    if (cr.meetsThreshold) byCat[cr.category].meets++;
  }
  const perCategory = Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, {
    cases: v.cases,
    passRate: v.cases ? v.sumRate / v.cases : 0,
    meetsThreshold: v.cases ? v.meets / v.cases : 0,
  }]));
  const overall = sumRuns ? sumPass / sumRuns : 0;
  return { overall, perCategory, casesRun: sumCases };
}

async function findPreviousSummary(outDir) {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(outDir)).filter(f => f.startsWith("_summary-") && f.endsWith(".json"));
    files.sort();
    return files.length ? path.join(outDir, files[files.length - 1]) : null;
  } catch { return null; }
}

function diffScores(current, previousSummary) {
  if (!previousSummary?.scoring) return null;
  const prev = previousSummary.scoring;
  const delta = { overall: current.overall - prev.overall, perCategory: {} };
  for (const cat of Object.keys(current.perCategory)) {
    const p = prev.perCategory?.[cat]?.passRate ?? 0;
    delta.perCategory[cat] = current.perCategory[cat].passRate - p;
  }
  return delta;
}

// ── Markdown summary ────────────────────────────────────────────────────────
function pct(n) { return `${Math.round(n * 1000) / 10}%`; }
function fmtDelta(d) { if (d === null || d === undefined) return ""; const s = d >= 0 ? "+" : ""; return ` (${s}${pct(d)})`; }

function renderMarkdown({ suite, timestamp, cases, scoring, delta, cfgPath }) {
  const lines = [];
  lines.push(`# ${suite} — latest benchmark run`);
  lines.push("");
  lines.push(`**Timestamp:** \`${timestamp}\`  `);
  lines.push(`**Config:** \`${path.relative(repoRoot, cfgPath).replace(/\\/g, "/")}\``);
  lines.push("");
  lines.push(`## Overall score: **${pct(scoring.overall)}**${fmtDelta(delta?.overall)}`);
  lines.push("");
  lines.push("## Per category");
  lines.push("");
  lines.push("| Category | Cases | Pass rate | Meets threshold | Δ vs prev |");
  lines.push("|---|---|---|---|---|");
  for (const [cat, s] of Object.entries(scoring.perCategory)) {
    const d = delta?.perCategory?.[cat];
    lines.push(`| ${cat} | ${s.cases} | ${pct(s.passRate)} | ${pct(s.meetsThreshold)} | ${d !== undefined ? fmtDelta(d).slice(2, -1) : ""} |`);
  }
  lines.push("");
  lines.push("## Per case");
  lines.push("");
  lines.push("| Case | Category | Runs | Pass rate | Threshold | Status | Guards |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const c of cases) {
    if (c.skipped) {
      lines.push(`| ${c.id} | ${c.category} | — | — | — | ⏭ skipped: ${c.skipReason} | ${c.guardsIssue || ""} |`);
      continue;
    }
    const passes = c.runs.filter(r => r.verdict.pass).length;
    const status = c.meetsThreshold ? "✅" : (c.score >= c.minPassRate * 0.5 ? "🟡" : "🔴");
    lines.push(`| ${c.id} | ${c.category} | ${passes}/${c.runs.length} | ${pct(c.score)} | ${pct(c.minPassRate)} | ${status} | ${c.guardsIssue || ""} |`);
  }
  lines.push("");
  lines.push("_Legend: ✅ meets threshold · 🟡 mitigated but marginal · 🔴 below half of threshold · ⏭ skipped._");
  lines.push("");
  lines.push(`_Raw per-run values in \`pm/reports/OCR-2-runs/*-${timestamp}.json\`._`);
  return lines.join("\n") + "\n";
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }
  if (!args.config) { console.error(HELP); process.exit(1); }
  await loadEnvLocal();

  const cfgPath = path.resolve(args.config);
  const cfgRaw = JSON.parse(await readFile(cfgPath, "utf8"));
  const cfg = normalizeConfig(cfgRaw);

  // Filter
  let selected = cfg.cases;
  if (args.category) selected = selected.filter(c => c.category === args.category);
  if (args.case) {
    const ids = new Set(args.case.split(",").map(s => s.trim()));
    selected = selected.filter(c => ids.has(c.id));
  }
  if (args.runs) selected = selected.map(c => ({ ...c, runs: args.runs }));

  const log = (level, ...m) => {
    const rank = { silent: 0, normal: 1, verbose: 2 };
    if (rank[args.logLevel] >= rank[level]) console.log(...m);
  };

  log("normal", `Suite: ${cfg.suite}`);
  log("normal", `Config: ${cfgPath}`);
  log("normal", `Cases planned: ${selected.length}${cfg.isBench ? " (benchmark)" : " (legacy)"}`);
  if (args.category) log("normal", `Category filter: ${args.category}`);
  if (args.case) log("normal", `Case filter: ${args.case}`);

  if (args.dryRun) {
    console.log("\n== Dry run matrix ==");
    for (const c of selected) {
      console.log(`  [${c.category}] ${c.id}  → field="${c.field}"  runs=${c.runs}  min=${Math.round(c.minPassRate * 100)}%  fixture=${c.fixture}`);
    }
    console.log(`\nTotal: ${selected.length} cases, ${selected.reduce((a, b) => a + b.runs, 0)} runs.`);
    return;
  }

  // Env checks (skipped in dry-run)
  // Default matches OpenNext preview's actual port (8787). Override via OCR_E2E_BASE_URL
  // (e.g. point at prod when templates/accounts live in the prod D1).
  const baseUrl = process.env.OCR_E2E_BASE_URL || "http://127.0.0.1:8787";
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
  try { playwright = await import("@playwright/test"); }
  catch {
    console.error("@playwright/test not installed. See scripts/ocr-e2e/README.md.");
    process.exit(1);
  }
  const { chromium } = playwright;
  const { runOcrCase } = await import("../ocr-e2e/harness.mjs");

  const outDir = path.join(repoRoot, "pm", "reports", "OCR-2-runs");
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const caseResults = [];

  const delayMs = Number(args.delayMs) > 0 ? Number(args.delayMs) : 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let ci = 0; ci < selected.length; ci++) {
    const c = selected[ci];
    const assertionFn = ASSERTIONS[c.assertion];
    if (!assertionFn) {
      log("normal", `[${c.id}] unknown assertion "${c.assertion}" — skipping`);
      caseResults.push({ ...c, skipped: true, skipReason: `unknown assertion ${c.assertion}`, runs: [] });
      continue;
    }
    if (!c.template) {
      log("normal", `[${c.id}] no template resolved (env var unset) — skipping`);
      caseResults.push({ ...c, skipped: true, skipReason: "template env var unset", runs: [] });
      continue;
    }
    const absFixture = path.resolve(repoRoot, c.fixture);
    if (c.skipIfMissing && !existsSync(absFixture)) {
      log("normal", `[${c.id}] fixture missing (skip_if_missing) — skipping: ${absFixture}`);
      caseResults.push({ ...c, skipped: true, skipReason: "fixture file absent", runs: [] });
      continue;
    }
    const withCorrections = c.assertion === "corrections_report" || c.assertion === "verbatim";
    const runsOut = [];
    for (let i = 0; i < c.runs; i++) {
      // Clear cookies before each case so a prior successful login doesn't
      // auto-redirect /login → /dashboard (session persists across pages in
      // the shared context; without this the email input never appears on
      // runs 2+ and every case times out).
      await context.clearCookies();
      const page = await context.newPage();
      let raw = null, error = null;
      const t0 = Date.now();
      try {
        raw = await runOcrCase({ page, baseUrl, email, password, filePath: absFixture, templateName: c.template, targetField: c.field, withCorrections });
      } catch (err) {
        error = String(err?.message || err);
      }
      const ms = Date.now() - t0;
      const observed = withCorrections
        ? (raw && typeof raw === "object" ? raw : { value: raw, corrections: [] })
        : { value: raw, corrections: [] };
      let verdict;
      if (error) {
        verdict = { pass: false, reason: `error: ${error}` };
      } else {
        try {
          verdict = assertionFn(observed, c.expectedSpec);
        } catch (err) {
          verdict = { pass: false, reason: `assertion crash: ${String(err?.message || err)}` };
        }
      }
      runsOut.push({ i: i + 1, ms, observed, verdict });
      log("normal", `[${c.id}] run ${i + 1}/${c.runs}: ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.reason} (${ms} ms)`);
      await page.close();
      // Rate-limit pacing (S2-1c): sleep after a passing run when another
      // run follows — either later in this case or in a subsequent case.
      // Failing runs skip the delay (no point pacing a broken run).
      if (delayMs > 0 && verdict.pass) {
        const hasNextInCase = i + 1 < c.runs;
        const hasNextCase = ci + 1 < selected.length;
        if (hasNextInCase || hasNextCase) {
          log("verbose", `[DELAY] sleeping ${delayMs}ms before next run`);
          await sleep(delayMs);
        }
      }
    }
    const cr = { ...c, runs: runsOut };
    caseResults.push(cr);
    const casePath = path.join(outDir, `${c.id}-${timestamp}.json`);
    await writeFile(casePath, JSON.stringify(cr, null, 2));
    log("verbose", `Wrote: ${casePath}`);
  }

  await browser.close();

  // Score + diff
  const scoring = scoreSuite(caseResults);
  const prevPath = await findPreviousSummary(outDir);
  let prev = null;
  if (prevPath) {
    try { prev = JSON.parse(await readFile(prevPath, "utf8")); } catch {}
  }
  const delta = prev ? diffScores(scoring, prev) : null;

  const summary = {
    suite: cfg.suite,
    startedAt: timestamp,
    baseUrl,
    config: path.relative(repoRoot, cfgPath),
    scoring,
    delta,
    previousSummary: prevPath ? path.relative(repoRoot, prevPath) : null,
    cases: caseResults.map(c => ({
      id: c.id, category: c.category, skipped: !!c.skipped, skipReason: c.skipReason || null,
      runs: c.runs.length, passRate: c.score ?? 0, minPassRate: c.minPassRate,
      meetsThreshold: !!c.meetsThreshold,
    })),
  };

  const summaryPath = path.join(outDir, `_summary-${timestamp}.json`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  const md = renderMarkdown({ suite: cfg.suite, timestamp, cases: caseResults, scoring, delta, cfgPath });
  const mdPath = path.join(repoRoot, "pm", "reports", "OCR-2-latest.md");
  await writeFile(mdPath, md);

  log("normal", `\nSuite summary: ${summaryPath}`);
  log("normal", `Markdown:      ${mdPath}`);
  log("normal", `Overall score: ${pct(scoring.overall)}${fmtDelta(delta?.overall)}`);
  for (const [cat, s] of Object.entries(scoring.perCategory)) {
    log("normal", `  ${cat.padEnd(14)} ${pct(s.passRate)}  (${s.cases} cases)`);
  }

  if (args.failUnder !== undefined && scoring.overall < args.failUnder) {
    console.error(`Overall score ${pct(scoring.overall)} < --fail-under ${pct(args.failUnder)}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
