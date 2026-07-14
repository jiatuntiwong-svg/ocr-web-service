// scripts/ocr-e2e/harness.mjs
//
// Pure Playwright flow: login → OCR page → pick template → upload file → click
// extract → wait for result → scrape the target field's value from the result
// table. Returns the raw string (or null on failure).
//
// This is the FRONTEND path — the client converts PDF → 3600px PNG before
// POST /api/upload, so this exercises the real production pipeline (qa-tester
// rule #1). NEVER call /api/upload directly for OCR correctness testing.

// NOTE: requires @playwright/test — see README.md. This file is written to be
// syntactically parseable without the dep installed; the import is dynamic.

// OCR-2 extension: when `withCorrections: true` is passed, the return shape
// becomes `{ value, corrections: [{ original, corrected }] }` instead of a
// bare string. The corrections badge is `✎ แก้คำ N` (see OCRWorkspace.tsx:1966)
// with an expanded list of `original → corrected` rows in the same result cell.
export async function runOcrCase({ page, baseUrl, email, password, filePath, templateName, targetField, withCorrections = false }) {
  // ── 1. Login ───────────────────────────────────────────────────────────────
  //
  // S2-1b: harden against two intermittent flakes seen in benchmark runs:
  //   (a) `button[type="submit"]` "element was detached from the DOM" retry
  //       loop that eventually times out at 30s. Root cause: login form
  //       re-renders (state update / conditional `<form>` swap) between
  //       locator resolution and click.
  //   Fix: wait for networkidle so the initial render settles → resolve the
  //   button explicitly to attached+enabled → try click; if the detached
  //   error fires, re-locate and retry once (max 2 attempts). If both fail,
  //   fall back to `form.evaluate(f => f.submit())` which is immune to the
  //   detached-element race.
  await page.goto(`${baseUrl}/login`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);

  const clickSubmitWithRetry = async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const btn = page.locator('button[type="submit"]').first();
      try {
        await btn.waitFor({ state: "attached", timeout: 15_000 });
        // `click` internally re-checks visibility/enabled, and honors the
        // shorter timeout below so we don't burn 30s waiting on a detach loop.
        await btn.click({ timeout: 10_000 });
        return;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        process.stderr.write(`[HARNESS_RETRY] login submit click attempt ${attempt} failed: ${msg.split("\n")[0]}\n`);
        if (!/detached|Timeout|not visible|not enabled/i.test(msg)) throw err;
        await page.waitForTimeout(500);
      }
    }
    // Final fallback: submit the form directly via DOM. Sidesteps any
    // locator-vs-render race entirely.
    process.stderr.write(`[HARNESS_RETRY] login submit click exhausted; falling back to form.submit()\n`);
    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form');
      if (!form) return false;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return true;
    });
    if (!submitted) throw lastErr || new Error("login submit failed: no <form> found");
  };

  await Promise.all([
    page.waitForURL(url => !url.pathname.includes("/login"), { timeout: 30_000 }),
    clickSubmitWithRetry(),
  ]);

  // ── 2. Navigate to OCR ─────────────────────────────────────────────────────
  await page.goto(`${baseUrl}/ocr`);
  await page.waitForLoadState("networkidle");

  // ── 3. Upload FIRST (v2 workspace shows TemplatePickerPanel only after a
  //      file is loaded — the stage machine auto-advances upload → fields for
  //      single-page files, or upload → pages for multi-page).
  //
  // S2-1b: the v2 workspace stage machine renders `<input type="file">` only
  // under specific conditions (upload stage active). On cold Workers the
  // initial hydration can drift past the default 30s locator timeout →
  // `setInputFiles: Timeout 30000ms exceeded`. Explicitly wait for the
  // input to be *attached* (v2 keeps it visually hidden but DOM-reachable)
  // with a 45s budget to absorb the cold-start tail.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 45_000 });
  await fileInput.setInputFiles(filePath);

  // Signal-based wait instead of a fixed sleep: watch for any of the
  // positive post-upload signals (stage moved off "upload" — i.e. we can
  // see the pages picker, the template picker, or the run CTA). Falls back
  // to a short settle if none is seen within ~10s so we never regress worse
  // than the old 2.5s wait on the happy path.
  const uploadAcceptedSignals = [
    page.getByRole("button", { name: /Next: Fields|ถัดไป: ฟิลด์/i }).first(),
    page.getByRole("button", { name: /Next: Run|ถัดไป: รัน/i }).first(),
    page.getByText(templateName, { exact: true }).first(),
  ];
  const settled = await Promise.race([
    ...uploadAcceptedSignals.map(l => l.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => null)),
    page.waitForTimeout(10_000).then(() => false),
  ]);
  if (!settled) {
    process.stderr.write(`[HARNESS_RETRY] upload settle signal not seen within 10s; continuing anyway\n`);
  }

  // ── 4. If we landed on the pages stage (multi-page), click "Next: Fields".
  const pagesNextBtn = page.getByRole("button", { name: /Next: Fields|ถัดไป: ฟิลด์/i }).first();
  if (await pagesNextBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await pagesNextBtn.click();
    await page.waitForTimeout(500);
  }

  // ── 5. Fields stage: click the template row inside TemplatePickerPanel. ───
  const templateLocator = page.getByText(templateName, { exact: true }).first();
  await templateLocator.waitFor({ state: "visible", timeout: 15_000 });
  await templateLocator.click();
  await page.waitForTimeout(400);

  // ── 6. Click "Next: Run" to leave fields stage.
  const fieldsNextBtn = page.getByRole("button", { name: /Next: Run|ถัดไป: รัน/i }).first();
  await fieldsNextBtn.waitFor({ state: "visible", timeout: 5_000 });
  await fieldsNextBtn.click();

  // ── 7. Click "Start extract" (run stage CTA). ─────────────────────────────
  const extractBtn = page.getByRole("button", { name: /Start extract|เริ่มสกัด/i }).first();
  await extractBtn.waitFor({ state: "visible", timeout: 5_000 });
  await extractBtn.click();

  // Some templates trigger a confirm dialog for large field sets — accept if present.
  const confirmBtn = page.getByRole("button", { name: /confirm|ยืนยัน|proceed/i });
  if (await confirmBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await confirmBtn.click();
  }

  // ── 6. Wait for the results stage — the "JSON raw" tab button appears
  //      once `result` state populates and the workspace auto-advances from
  //      run → results. Timeout generous for slow AI round-trips.
  //
  //      OCR-8: bumped 120s → 180s. `verbatim-plastelet` intermittently
  //      exceeded 120s during S2-2 runs (crop pass adds a second Gemini call
  //      that can drift into the 90-110s range on cold Workers). The extra
  //      minute costs nothing on the happy path (the wait resolves as soon
  //      as the tab appears) and prevents a scaffold flake from masquerading
  //      as an OCR regression. Selector is also robustified: match
  //      "JSON raw" OR "JSON" prefix so a future rename can't silently break
  //      the harness.
  const jsonTabBtn = page.getByRole("button", { name: /^JSON( raw)?$/i }).first();
  await jsonTabBtn.waitFor({ state: "visible", timeout: 180_000 });

  // ── 7. Read the raw JSON directly instead of scraping cards. v2's fields
  //      tab wraps each entry in a card with an overflow ⋯ button, uppercase
  //      label divs, badges, etc. — DOM heuristics kept landing on the ⋯
  //      glyph. The JSON raw tab renders `JSON.stringify(result, null, 2)`
  //      inside a single <pre>, so parsing is deterministic.
  await jsonTabBtn.click();
  await page.waitForTimeout(300);

  const rawJson = await page.evaluate(() => {
    const pre = document.querySelector("pre");
    return pre ? pre.textContent || "" : "";
  });

  let parsed = null;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = null;
  }

  // v2 result shape: `result[field]` is either a scalar (older) or
  // `{ value, confidence, corrections, source, bbox, ... }` (v2 default).
  const entry = parsed && Object.prototype.hasOwnProperty.call(parsed, targetField)
    ? parsed[targetField]
    : null;

  const extractValue = (e) => {
    if (e == null) return null;
    if (typeof e === "string" || typeof e === "number") return String(e);
    if (typeof e === "object" && "value" in e) {
      const v = e.value;
      if (v == null) return null;
      if (typeof v === "string" || typeof v === "number") return String(v);
      // Tables land here — array of rows or object. Stringify so callers
      // that only need presence checks still work, and structured
      // assertions can JSON.parse it back.
      return JSON.stringify(v);
    }
    // Bare array/object (no `value` wrapper) — stringify.
    return JSON.stringify(e);
  };

  const value = extractValue(entry);

  if (!withCorrections) return value;

  const corrections = entry && typeof entry === "object" && Array.isArray(entry.corrections)
    ? entry.corrections.map((c) => ({
        original: String(c.original ?? ""),
        corrected: String(c.corrected ?? ""),
      }))
    : [];

  return { value, corrections };
}
