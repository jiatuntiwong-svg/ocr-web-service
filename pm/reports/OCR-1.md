# OCR-1 — Verify bbox_hint against out-of-line values

**Status:** Static review only — not empirical.
**Verdict:** **NO-GO (with caveat)** — recommend planning two-pass extraction, keep bbox_hint MVP as a partial mitigation.
**Confidence:** Medium (static review; empirical result still required before final decision).

---

## TL;DR

The deployed `bbox_hint` prompt (`c71be2eb`, at `src/app/api/upload/route.ts:176`) tells the model:

> "หัวข้อที่มี [hint: x=...%, y=...%] คือ 'ตำแหน่งที่คาดว่าค่าจะอยู่' (0-100% ของขนาดภาพ, มุมซ้ายบน = 0,0) — ให้ค้นในบริเวณนั้นก่อน; ยอมให้เผื่อขอบเขต ±10% ได้ ถ้าไม่พบในนั้นเลยค่อย fallback semantic search ทั่วภาพ"

For issue 1.2 ("value written below the form line gets dropped") this is architecturally suspect:

1. **The hint is a soft prompt, not a crop.** Gemini still sees the entire image; the visual bias that mis-attributes below-line strokes back to the line (or ignores them) is unchanged. The hint influences *where the model prefers to look*, not the tokenised visual input.
2. **±10% tolerance is small.** With a "tight" hint drawn on the form line, ±10% often will not cover the row of handwritten text below. To succeed, the user must remember to draw a *wide* hint spanning both line + below-line area — this is undocumented in UI and never enforced.
3. **The semantic fallback is exactly what was failing before.** If the hint region search yields nothing, the model falls back to whole-image semantic search — i.e. the same pass that dropped the value in the first place. Net result: bbox_hint only helps when the value is already inside the drawn box.
4. **Public API cannot use it.** `src/app/api/v1/extract/route.ts` has no `bbox_hint` / `fields_json` support. Any user relying on the public API is unaffected by the fix.

The bbox_hint MVP is a good spatial disambiguation aid for issue 1.4 (2-column label confusion) — where the value *is* on the line, just at the wrong side of the page. It is unlikely to be sufficient for 1.2, where the layout intent is violated by the writer.

---

## What was verified (static review)

Because this environment has no way to burn Gemini credits against the deployed worker while capturing 18 comparable results without contaminating the user's production credit balance, we did not run empirical tests. Verification is code + prompt inspection per the task spec's documented fallback ("code + prompt inspection review").

### 1. Prompt actually contains the hint rule — verified

`src/app/api/upload/route.ts:161-187` — the image-mode prompt (used for all non-Excel uploads) includes both:
- Rule stating hint semantics and ±10% tolerance (line 176)
- Response schema requiring `bbox` back for auto-capture (line 180-181)

### 2. Hint reaches the model — verified

- Frontend (`src/components/OCRWorkspace.tsx:619,723`) posts `fields_json` on both single-file and batch paths.
- Server parses `fields_json` into `structuredFields` (route.ts:32-39) and interpolates a `[hint: x=A%-B%, y=C%-D%, page N]` string per field into the field descriptor block (route.ts:43-52).
- No hint is passed when `fields_json` is absent — falls back to comma-separated field names. So legacy clients see zero regression.

### 3. Response bbox capture round-trip — verified

- Schema requires `bbox: {x,y,width,height,page}` per field (route.ts:180-181).
- Auto-capture: `OCRWorkspace.tsx:463-494` writes the returned `bbox` back into `bbox_hint` on fields that don't already have one, and persists to the template. So the second run of the same template has hints pre-populated even if the user never manually drew one.

### 4. Public API (`/api/v1/extract`) — NOT integrated

Read `src/app/api/v1/extract/route.ts:9-80` — no `fields_json`, no `bbox_hint` handling, no structured field block in the prompt. Any external caller of the public API sees the pre-c71be2eb behaviour.

---

## Test matrix — would-have-tested

Documented for a human operator to run against the deployed worker. Each cell should be run 3× because of Gemini variance (issue 2.5).

| # | Value position   | Hint shape | Expected outcome                                | Runs |
|---|------------------|-----------|-------------------------------------------------|------|
| A1| On the line      | Tight     | Baseline — should hit 3/3                       | 3    |
| A2| On the line      | Wide      | Baseline — should hit 3/3                       | 3    |
| B1| Below the line   | Tight     | Predicted miss — value is outside hint + ±10%  | 3    |
| B2| Below the line   | Wide (covers below-line area) | Predicted partial hit — depends on visual bias | 3    |
| C1| Spans both       | Tight     | Predicted partial — only on-line half captured | 3    |
| C2| Spans both       | Wide      | Predicted best case — should merge with `\n`   | 3    |

Total: 18 runs.

### Fixtures — limitation

The `test_compare/` directory holds shipping documents (BL/SI PDFs, XLS, DOC) — none exhibit the Thai form "value written below the line" case seen in session 2026-07-02. The original Thai คลังกลาง form fixture is not committed to the repo. **A human operator must supply the original Thai form (or a scanned equivalent) to run this matrix.** Do not synthesise a fake form — the failure mode is specifically about human handwriting behaviour on a printed form, and generated PDFs won't reproduce it.

---

## Recommendation — plan for two-pass extraction

Sketch (rough, to be fleshed out only if empirical run confirms NO-GO):

1. **Pass 1 (unchanged):** current prompt + bbox_hint, returns tentative values + confidence + bbox.
2. **Detect suspect fields:** any field with (a) `value === null`, or (b) `confidence < threshold`, or (c) returned `bbox` sits noticeably above the hint centre (heuristic for "line-anchored, missed below-line content").
3. **Pass 2 (targeted):** for each suspect field, send the hint region cropped from the source image (widen by +30% on Y-axis) plus a focused prompt: "This crop should contain the value for '<field>'. Extract any handwriting or printed text visible in it. Return raw." — no schema, minimal semantic priors.
4. **Merge:** if pass 2 returns text absent from pass 1's value, join with `\n`. Log `pass2Used: true` in raw_json for observability.

Cost: roughly +1 Gemini call per suspect field. For a typical Thai form with ~15 fields and ~2 suspects, ~13% extra tokens. Latency ~+3-5s.

An alternative worth prototyping first: swap the "±10% tolerance" prompt wording for something explicit like "ให้ค้นในบริเวณกรอบและใต้กรอบเสมอ (ไม่จำกัดที่กรอบ)" — cheap, and if it works, no two-pass needed. Verify empirically before committing to two-pass.

---

## Manual QA protocol (for human operator)

1. Log into the deployed worker as a test account with ≥ 30 credits.
2. Load the original Thai คลังกลาง form (or an equivalent hand-annotated print where at least one field's value is clearly below the printed line).
3. Configure a template with two fields on that same value location — one with a tight hint (line only), one with a wide hint (line + ~30% below).
4. Run OCR 3× per cell in the matrix above. Record for each run: returned `value`, returned `bbox`, whether it matches expected. Do not clear credits between runs — variance matters.
5. Fill in pass rates per cell. Cells B2 and C2 are the decision cells.
   - **GO** if B2 ≥ 2/3 AND C2 ≥ 2/3.
   - **NO-GO** if either is ≤ 1/3.
   - **Inconclusive** otherwise — run 3 more, re-evaluate.
6. Append raw table to this report under a "## Empirical results" heading and update BOARD.md.

---

## Surprises worth flagging

- **Coordinate drift.** Frontend renders PDFs at 3600px client-side (issue 2.4 fix). The hint coords are stored as 0-1 relative to the *original preview*. The AI receives the client-rendered PNG. If DPI or page selection changes between hint capture and OCR run, the hint may point off-target. Worth spot-checking during empirical run.
- **Wide hints may over-include.** If two fields are stacked vertically and the user draws hint wide for the top field to catch below-line content, that hint may spill into the next field's row. Prompt has no rule against this — model may return the neighbour's value.
- **Public API gap.** Any promise of "bbox_hint mitigates 1.2" is currently a UI-only claim. If the public API is on the roadmap, `v1/extract` needs `fields_json` support before this fix ships to external users.
- **Auto-capture masks user intent.** The first successful run writes the AI's returned `bbox` back into the template as the persistent hint. If pass 1 dropped a below-line value but hit the on-line portion, the auto-captured hint will be tight-on-line, and future runs on this template will *never* look below. Consider gating auto-capture on `confidence > 0.8` (currently unconditional at OCRWorkspace.tsx:466).

---

_Author: ocr-pipeline agent, 2026-07-05_
_Related: docs/OCR_TESTING_LOG.md §1.2, §4 row 1_

---

## Empirical results (กรอกหลังรันเทสจริง — บน build ที่รวม OCR-4 แล้ว)

วันที่เทส: ____ | Build/version: ____ | เอกสาร: ____

ต่อ run กรอก ✅ (ได้ค่าครบถูกต้อง) / ⚠️ (ได้บางส่วน) / ❌ (ผิด/หาย)

| Cell | ตำแหน่งค่า | Hint | Run 1 | Run 2 | Run 3 | Pass rate |
|------|-----------|------|-------|-------|-------|-----------|
| A1 | บนเส้น | แคบ | | | | /3 |
| A2 | บนเส้น | กว้าง | | | | /3 |
| B1 | ใต้เส้น | แคบ | | | | /3 |
| **B2** | ใต้เส้น | กว้าง | | | | /3 ← ตัวตัดสิน |
| C1 | คร่อมทั้งสอง | แคบ | | | | /3 |
| **C2** | คร่อมทั้งสอง | กว้าง | | | | /3 ← ตัวตัดสิน |

เกณฑ์: **GO** = B2 ≥ 2/3 และ C2 ≥ 2/3 | **NO-GO** = ตัวใดตัวหนึ่ง ≤ 1/3 | ก้ำกึ่ง = รันเพิ่ม 3 รอบ

หมายเหตุ (ค่าที่ AI คืน, bbox ที่คืน, พฤติกรรมแปลก): ____

### Observed run — 2026-07-06 (ก่อน control test)

- เอกสาร: "ใบตัดจ่ายภาคฯ 3 รอบที่ 2 ม.ค.69.pdf" — 7 หน้า, ปน 4 ฟอร์ม (ใบจ่าย p.1-3, ใบเบิก p.4-5, ใบจ่าย p.6, ใบเบิก p.7)
- Field: `ผู้รับโอน` + wide hint บนหน้า 1 (คลุมทั้ง 2 บรรทัด) — user รัน 2-3 รอบ
- Expected: `คลังภาคบริการโลหิตแห่งชาติที่ 3 จ.ชลบุรี\nวัตถุดิบและงานระหว่างทำ`
- Got: `ศูนย์บริการโลหิตแห่งชาติ` ❌
- **Diagnosis:** ค่าที่คืนคือค่าของ field `ผู้โอน` ในหน้า 4/5/7 — cross-page label confusion (ผู้โอน ≈ ผู้รับโอน) เพราะ pipeline stack ทั้ง 7 หน้าเป็นภาพเดียว + สงสัย hint coordinate drift ใน stacked image
- **Action:** control test — แยกหน้า 1 เป็น PDF เดี่ยว รัน 3× เพื่อแยกตัวแปร multi-page ออกจาก hint mechanism (ดู BOARD decision log 2026-07-06)
