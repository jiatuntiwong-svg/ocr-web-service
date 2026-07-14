# Work orders — ocr-pipeline agent

## OCR-8 (P1, Sprint 2) — Crop legibility: landscape "รับบริจาค" drop is vision-side

**Evidence:** `landscape-a4-widefield` 0/3 both pre- and post-S2-2 (prompt anti-example ignored). Model returns `ศูนย์บริการ...` with empty `corrections[]` — it does not perceive the "รับบริจาค" glyph cluster in the crop image (S2-2 report §Landscape verdict). Fixture HTML verified correct.

**Experiment ladder (cheapest first — stop at the first rung that hits ≥2/3):**
1. **DPI bump on crop:** render/crop the hint region at higher effective resolution (e.g. upscale crop 2× before sending, or crop from a higher-DPI page render for the crop pass only). Measure token cost delta.
2. **Retry-at-0.6 assist:** if a hinted field's value changes between temp 0 and a 0.6 retry, flag low confidence (leverages OCR-3 — no new AI machinery).
3. **Resize + re-crop pass:** send the crop at 2 scales in the same multi-image call, instruct model to reconcile.

**Acceptance:** `landscape-a4-widefield` ≥ 2/3 AND full benchmark ≥ 88.9% (no green case drops). Save snapshot per SHARED_RULES version discipline. Report pm/reports/OCR-8.md.

**Also in scope (harness, coordinate with qa-tester):** `verbatim-plastelet` intermittent 120s JSON-tab timeout — bump wait/robustify selector so scaffold flakes stop polluting scores.

---

## AI-1 (P0 🔥 URGENT) — Support Vertex AI keys as an AI provider

**Request (operator, 2026-07-09):** the AI config must accept Vertex AI credentials, alongside the existing Gemini (AI Studio key) / OpenAI / OpenRouter providers in `src/lib/ai-handler.ts`.

**Do:**
1. **Recon first:** read `src/lib/ai-handler.ts` + `src/lib/gemini.ts` + admin AI settings (`api/admin/settings`, APISettingsView) to map how providers/keys are stored and selected today.
2. **Add provider `vertex_ai` — EXPRESS MODE ONLY (confirmed by operator 2026-07-09):** key is the same AIza-style API key as today; only the endpoint changes to Vertex. REST call to `https://aiplatform.googleapis.com/v1/publishers/google/models/<model>:generateContent?key=...` — request/response shape near-identical to the current Gemini API path, so this can likely reuse the existing request builder with a different base URL. Confirm the exact endpoint/params against current Google docs at implementation time (express mode is newer and moves). Config fields: api key + model name (+ optional location if the endpoint requires it). Do NOT build the service-account/JWT path — out of scope.
3. **Route through the existing abstraction:** `generateWithAI` gains the provider — multi-image support must work (crop pass depends on it). No changes to prompts or merge logic.
4. **Admin settings UI:** provider dropdown + fields above; validate with a cheap test call ("ทดสอบการเชื่อมต่อ" button).
5. **Metering:** map Vertex usage metadata into the same `logAiUsage` fields (input/output tokens) so AI usage dashboard stays correct.
6. Secrets stay server-side (D1 settings or wrangler secret — follow the existing pattern for the Gemini key). Never expose to client.

**🔒 SECURITY REQUIREMENTS (mandatory — this is a PRODUCTION key, zero-leak tolerance):**
1. **Key in header, NOT query string:** use the `x-goog-api-key` request header instead of `?key=...` in the URL. Keys in URLs leak into logs, error messages, `wrangler tail`, and any request tracing. This is non-negotiable.
2. **Never return the full key to the client:** audit `GET /api/admin/settings` — if it currently returns stored keys to populate the settings form, change to masked form (`AIza...****1234`, last 4 chars). Full key is write-only from the client's perspective. Apply the same masking to the EXISTING Gemini key while you're there.
3. **Never log the key:** grep the entire request path (logger.ts, console.*, error handlers, `detail` fields) — provider error objects can echo the request URL/config; sanitize before logging. Add a `redactSecrets()` helper if needed.
4. **No client-side usage:** verify the vertex path is server-only (`upload/route.ts` / `v1/extract`). Audit `src/lib/gemini.ts` / `frontend-ocr.ts` for any client-side AI calls — the PRD key must never reach the browser bundle. No `NEXT_PUBLIC_*` anywhere near it.
5. **Storage:** follow the existing server-side pattern (D1 settings / wrangler secret). Never write the key into code, fixtures, pm/reports, or docs — including in the AI-1 report (use placeholders).
6. **Error responses:** provider failures return `code: "AI_FAILED"` only (per API-2/UI-3 pattern) — assert no Google error body containing the key/URL passes through to the user.

**Acceptance:** switch provider to vertex_ai in admin → run OCR (single + crop pass) end-to-end in preview successfully; switching back to Gemini needs no redeploy; **security checklist above verified item-by-item in the report** + run the `/security-review` skill on the branch changes before handing over; report `pm/reports/AI-1.md`.

---

Sprint: OCR Stabilization. Update pm/BOARD.md status when you start/finish a task. Write findings to pm/reports/<ID>.md.

---

## OCR-1 (P0) — Verify bbox_hint against out-of-line values (issue 1.2)

**Context:** bbox_hint MVP deployed (`c71be2eb`). Issue 1.2 (values written below the form line get dropped) is still unsolved — the plan says bbox_hint *might* fix it if the hint box covers the area under the line. This has never been verified. Decision on two-pass extraction depends on this result.

**Do:**
1. Read `docs/OCR_TESTING_LOG.md` §1.2, §1.4 and the bbox_hint implementation (search `bbox_hint` in `src/lib` and `src/app/api`).
2. Test with Thai form fixtures (test docs from the 2026-07-02 session; if unavailable, use `test_compare/` docs and construct an equivalent case).
3. Matrix: field with value on the line / below the line / spanning both — with hint drawn tight vs wide.
4. Verdict: does a wide bbox_hint reliably capture below-line values? Include per-run results (run each case 3× because of Gemini variance).

**Done when:** report in `pm/reports/OCR-1.md` with a clear GO (bbox_hint sufficient) / NO-GO (two-pass extraction needed) recommendation. Update OCR_TESTING_LOG §4 row 1.

---

## OCR-4 (P0) — Quick fixes from OCR-1 findings ✅ APPROVED 2026-07-05

**Context:** OCR-1 static review found (a) unconditional auto-capture at `OCRWorkspace.tsx:466` can persist a tight on-line bbox that permanently masks below-line values, (b) the "±10% tolerance" prompt wording likely doesn't cover below-line content. PM approved both fixes before the empirical run.

**Do:**
1. **Gate auto-capture:** only write returned `bbox` back into `bbox_hint` when that field's `confidence > 0.8` (threshold constant, easy to tune). Never overwrite a hint the user drew manually.
2. **Prompt wording:** in `src/app/api/upload/route.ts:176`, replace the ±10% rule with explicit instruction to always search the hint box AND the area below it (e.g. "ให้ค้นในบริเวณกรอบและใต้กรอบเสมอ ไม่จำกัดเฉพาะในกรอบ") — keep the semantic fallback as last resort.
3. Do NOT touch `v1/extract` (public API bbox_hint support is backlogged — no users yet).
4. Sanity-check both changes in `npm run preview`.

**Done when:** both fixes deployed-ready, report in `pm/reports/OCR-4.md`. This unblocks the user's 18-run empirical test (OCR-1 protocol).

---

## OCR-1 — NEXT STEP (after OCR-4)

User will run the 18-run manual QA per the protocol in `pm/reports/OCR-1.md` §Manual QA, using the original Thai form. Prepare a fill-in results table template at the end of that report to make recording easy. Decision on two-pass extraction waits for cells B2/C2.

---

## OCR-5 (P0) — Hint guardrails *(start only if control test fails — see BOARD decision log 2026-07-06)*

**Context:** First empirical run: field `ผู้รับโอน` with a wide hint on page 1 of a 7-page bundle returned the value of `ผู้โอน` from pages 4/5/7 — cross-page label confusion. Two code-level (not prompt-only) guardrails were approved in principle:

**Do:**
1. **bbox-overlap validation (server-side):** after extraction, if a field has a `bbox_hint` and the AI's returned `bbox` has zero overlap with the hint (same page, expand hint by ~30% down per OCR-4 semantics), discard the value → set `value: null`, `confidence: 0`, flag `hint_miss: true` so UI can show "ไม่พบในตำแหน่งที่กำหนด". Code check in `upload/route.ts` post-processing — deterministic, prompt-independent.
2. **No-fallback rule (prompt):** for hinted fields, remove whole-image semantic fallback — instruct: not found in box/below-box → return null. Null is better than a wrong value.
3. Verify hint coordinate semantics on multi-page stacked images: is `y%` relative to the single page or the full stacked image? If mismatched, fix the mapping (this alone may explain the miss).

**Done when:** wrong-location values can no longer reach the user; report `pm/reports/OCR-5.md`.

---

## OCR-6 (P0) — Crop-based extraction for hinted fields ✅ APPROVED 2026-07-06

**Evidence chain (all manual runs by operator, see pm/reports/OCR-2.md Case 6):**
- Dense page (doc1): `ผู้รับโอน` line 2 dropped 3/3 — deterministic
- Sparse page (doc2), same form/value: 3/3 correct
- Widest possible hint on doc1: still fails → hint/prompt approaches exhausted
- **Manual crop of the header region → correct 2 lines** → crop removes the attention distraction. GO.

**Design:**
1. **Client-side crop** in `OCRWorkspace.tsx`: for each field with `bbox_hint`, crop from the already-rendered 3600px PNG (same pixels the model would see). Expand the hint region: ±15% X, +40% down (below-line spillover per OCR-4), and include the label side (extend left/up enough to keep the field label in frame — the model needs the label for confirmation).
2. **One extra AI call per run (batched):** send ALL crops as multiple images in a single request with a focused prompt: "แต่ละภาพคือบริเวณของ field ต่อไปนี้ ... อ่านค่าให้ครบทุกบรรทัดที่เห็น" — not one call per field.
3. **Merge policy:** crop result wins for hinted fields; whole-image result stays for non-hinted fields. If crop returns null → fall back to whole-image value + flag `crop_miss: true` in raw_json for observability.
4. **API contract:** coordinate with backend-api — extend `fields_json` upload to carry crop images (or a second request). Keep metering as ONE extraction run (confirm with `ai-usage.ts`; token cost of crops is small).
5. **Batch mode** (`runBatchItem`) gets the same treatment.

**Acceptance:**
- Case 6 doc1 (dense page): ≥ 3/3 both lines via the new path
- OCR-2 synthetic suite: no regression (run after implementation)
- Works in `npm run preview` (workerd)

**First-run behavior (no hints yet) — by design:**
- Run 1: whole-image extraction as today. AI returns `bbox` per field → auto-capture persists to template (confidence ≥ 80 gate from OCR-4).
- Run 2+: hinted fields take the crop path automatically. The +40% downward expansion means even a tight auto-captured bbox (from a run-1 partial read) will cover below-line content — self-healing.
- Do NOT add an automatic same-run verify pass (whole image → crop → re-check) — PM deferred it pending cost/miss-rate data after OCR-6 ships.

**Out of scope:** full two-pass with suspect-field detection (OCR-1 sketch) — this simpler always-crop-hinted-fields version supersedes it unless data says otherwise.

---

## OCR-6b (P0) — Debug: crop pass not delivering on new form

**Repro (operator, 2026-07-07):** form "ใบโอนย้ายสินทรัพย์ถาวร" (single page), field `ชื่อและรหัสศูนย์รับผิดชอบ` with hint drawn. Expected 3 parts: `3 6` + `ศูนย์รับบริจาคโลหิตและพลาสมา` + `สถานีกาชาดที่11 วิเศษนิยม บางแค`.
- Full-PDF run (post OCR-6 deploy `5ab63cac`): returns `3 6 ศูนย์บริการโลหิตและพลาสมา` — line 3 missing AND spelling silently corrected (`รับบริจาค`→`บริการ`), confidence 100%
- Manual crop of the region uploaded as image: **all 3 lines correct, correct spelling** → model can do it; our crop path isn't delivering it

**Investigate in order:**
1. Did the crop pass fire? Reproduce in dev — check `[OCR-6] field crops` console.debug rects + confirm `field_crops` manifest in the request. Verify hint was persisted in the template at run time.
2. If fired: check the doc's `raw_json` — does the field carry `source:"crop"` / `crop_miss:true` / nothing? "Nothing" = the documented merge observability gap (crop response key didn't match the Thai fieldName) — fix key matching (normalize whitespace) AND close the gap: always record crop provenance per manifest entry.
3. Compare crop-pass prompt vs whole-image prompt: port the critical rules into the crop prompt — multi-line ("เอาทุกบรรทัดที่เห็น คั่น \n"), no-autocorrect/verbatim, "ข้อความทั้งหมดในภาพนี้คือค่าของ field นี้ ห้ามกรองทิ้ง". The manual test succeeded under the FULL prompt — that's the strongest signal the mini-prompt is the culprit.
4. Verify crop rect actually covers line 3 (the +40% bottom margin vs a hint drawn tight).

**PM file inspection findings (2026-07-07, doc `TR07246900009- กาชาด 11.pdf`):**
- **Page 1 is LANDSCAPE, page 2 portrait (photos only).** Top suspect: rotation/orientation handling — scanned landscape pages often carry /Rotate metadata. Verify `pdfFileToImageDetailed` raster orientation matches the preview canvas where hints are drawn (a mismatch silently crops the wrong region → crop null/garbage → fallback to whole-image). Also verify stacked-image width normalization when pages have different widths (x% scale per page, not per stack).
- **The wrong value is a BLEND of neighbors:** returned `ศูนย์บริการโลหิตและพลาสมา` = `ศูนย์บริการโลหิตแห่งชาติ` (value of adjacent `รหัสสำนักงาน/ศูนย์`) × `ศูนย์รับบริจาคโลหิตและพลาสมา` (true value). Row has 3 similar label+value groups side-by-side — whole-image pass will keep blending these; only a correctly-placed crop fixes it. Add this doc as a regression fixture (landscape + sibling-label case).
- Operator's manual crop of the region → all 3 lines + correct spelling (model capability confirmed; delivery path is at fault).

**Acceptance:** this doc returns all 3 lines with correct spelling ≥ 2/3 runs in preview; regression: doc1 (dense ใบจ่าย) still passes 3/3.

## OCR-6c (P0) — Hint coordinate space broken on landscape/letterboxed preview

**Evidence (operator DevTools, 2026-07-07, doc TR07246900009):** field `ชื่อและรหัสศูนย์รับผิดชอบ` in raw_json shows `crop_miss: true` — crop pass fired, fieldName matched, but the model returned null for the crop → crop image is off-target. This is OCR-6b's Red Flag #3 confirmed: the hint is drawn over an `<iframe>` PDF preview (`view=FitH`), and hint fractions are measured against the WRAPPER rect, not the rendered page box. A landscape page letterboxed inside the wrapper produces systematically wrong y (and possibly x) fractions. The hint overlay LOOKS correct in preview because it renders with the same wrong transform. Portrait doc1 mostly matches wrapper aspect → worked; landscape form → crop hits empty area → model null → `crop_miss` → silent fallback to whole-image value.

**Fix direction (pick the robust one):**
1. **Preferred:** replace the iframe-based hint-drawing surface with the SAME pdfjs canvas raster used for upload (`pdfFileToImageDetailed`) — one coordinate space end-to-end, letterboxing impossible. Overlay + drawing math already exists.
2. Minimum viable: compute the rendered page box inside the iframe wrapper (aspect-fit math: scale = min(wrapW/pageW, wrapH/pageH), offsets = centering) and convert wrapper fractions ↔ page fractions on BOTH write (draw/save hint) and read (render overlay). Must handle per-page orientation (landscape p.1, portrait p.2).
3. Migration: existing saved hints were recorded in wrapper space — decide: invalidate hints on aspect-mismatched pages (prompt user to redraw) or attempt best-effort conversion. Document the choice.

**Acceptance:**
- On TR07246900009 (landscape): `crop_0` payload visibly contains the target text; field returns all 3 lines, correct spelling, `source:"crop"`, ≥ 2/3 runs
- doc1 (portrait ใบจ่าย): still 3/3 both lines — no regression
- Hint overlay position identical before/after save+reload on both orientations

**Added scope (from API-1 follow-up, same file):** `buildFieldCrops()` must accept the page-selection array and translate `hint.page` → rendered index via `remapBboxHintPage()` from `src/lib/pageSelection.ts` (skip hints whose page was dropped). See pm/reports/API-1.md §Follow-ups. Do this while you're in `field-crops.ts` for the rotation/orientation fix — one pass, both fixes.

---

## OCR-2 (P1) — Prompt regression suite

**Context:** Session 2026-07-02 shipped prompt fixes v1/v2 for: auto-correction (`Plastelet`→`Platelet`), prefix dropping (`คลัง...`), multi-line values, label confusion. These are 🟡 mitigated, not solved — and every future prompt change risks regressing them.

**Do:**
1. **Reuse the existing Playwright harness** (`scripts/ocr-e2e/` — built by qa-tester for TEST-1, config-driven case JSONs). Do NOT hit `/api/v1/extract` directly — it bypasses the client-side PDF→PNG conversion.
   **Priority case (added 2026-07-06, now P0):** `ผู้รับโอน` on `test_fixtures/thai-form/page1-only.pdf` — intermittently drops line 2 (`วัตถุดิบและงานระหว่างทำ`). Run 10× to get a real pass rate; this number decides whether we need self-consistency voting.
2. Cases minimum: verbatim word preservation, prefix retention, multi-line join with `\n`, 2-column label disambiguation, `corrections[]` reporting.
3. Each case: run 3×, record pass rate (variance-aware).

**Done when:** script runs green (or documents current pass rates), usage documented in the script README. Report in `pm/reports/OCR-2.md`.

---

## OCR-3 (P1) — Retry mechanism with temperature 0.6

**Context:** Gemini variance (issue 2.5): same file sometimes right, sometimes wrong at temp 0. Agreed plan: a Retry button that re-runs extraction with temperature 0.6.

**Do:**
1. In `src/lib/ai-handler.ts` / `src/lib/gemini.ts`: support a `retry` mode — same prompt, temperature 0.6, mark response metadata `isRetry: true`.
2. Expose via the extract API (coordinate param naming with backend-api agent — see API-1/API-2 in their file).
3. Credits: a retry consumes credits like a normal run (confirm against `src/lib/ai-usage.ts` metering; do NOT bypass metering).

**Done when:** API supports retry end-to-end (UI-2 by frontend-ui depends on this). Report in `pm/reports/OCR-3.md`.

---

**Out of scope for you this sprint:** compare prompt overhaul (§A), OCR Rulebase (not approved), two-pass extraction (only if OCR-1 = NO-GO, then propose plan first).
