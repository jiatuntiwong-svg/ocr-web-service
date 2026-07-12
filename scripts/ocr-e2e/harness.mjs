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
  await page.goto(`${baseUrl}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL(url => !url.pathname.includes("/login"), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);

  // ── 2. Navigate to OCR ─────────────────────────────────────────────────────
  await page.goto(`${baseUrl}/ocr`);
  await page.waitForLoadState("networkidle");

  // ── 3. Upload FIRST (v2 workspace shows TemplatePickerPanel only after a
  //      file is loaded — the stage machine auto-advances upload → fields for
  //      single-page files, or upload → pages for multi-page).
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(filePath);
  // Client-side PDF→PNG conversion + auto-advance settle time.
  await page.waitForTimeout(2500);

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
  const jsonTabBtn = page.getByRole("button", { name: /^JSON raw$/i }).first();
  await jsonTabBtn.waitFor({ state: "visible", timeout: 120_000 });

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
