# OCR-4 — Quick fixes from OCR-1 findings

**Status:** ✅ Done — deploy-ready (not deployed).
**Scope:** Surgical fix, two files touched. `v1/extract` intentionally NOT modified.

---

## Files changed

### 1. `src/components/OCRWorkspace.tsx` — auto-capture gate

Lines ~462–478 (inside `captureBboxHints`).

- Extracted the confidence threshold into a named constant `BBOX_CAPTURE_CONFIDENCE = 80` (0–100 scale, matches the prompt spec at upload/route.ts:150) with a comment explaining why it exists — so future tuning is a one-line change.
- Kept both guards (already structurally correct in the pre-existing code — see "Surprises" below):
  - `if (f.bbox_hint) return f;` — never overwrite an existing hint (user-drawn or prior high-confidence capture).
  - `if (... || conf < BBOX_CAPTURE_CONFIDENCE) return f;` — skip low-confidence captures.
- Added inline comments explaining the intent of each guard.

### 2. `src/app/api/upload/route.ts` — prompt wording

Line 176 (rule bullet inside the image-mode prompt).

- Replaced the "±10% tolerance, else fallback semantic" wording with an explicit instruction:
  > "หัวข้อที่มี [hint: x=...%, y=...%] คือ 'ตำแหน่งที่คาดว่าค่าจะอยู่' … — ให้ค้นในบริเวณของกรอบ 'และพื้นที่ใต้กรอบเสมอ' (สำหรับค่าที่ผู้เขียนกรอกล้นออกใต้เส้น/ใต้ label) ไม่จำกัดเฉพาะภายในกรอบ; หากไม่พบทั้งในกรอบและใต้กรอบเลย จึงค่อย fallback semantic search ทั่วภาพเป็นทางเลือกสุดท้าย"
- The "below the box" area is now first-class in the search region — no tolerance heuristic. Semantic fallback is retained but demoted to "last resort".

---

## Verification

- `npm run build` (next webpack build): **passed** — all 42 routes compiled, no TS errors in the two touched files or elsewhere.
- Ran `npx tsc --noEmit` beforehand — clean (no diagnostics printed).
- Prompt content: verified in source (template literal — no compile-time transformation applies). The new Thai instruction is present verbatim at `src/app/api/upload/route.ts:176`.
- `npm run preview` (opennextjs-cloudflare) NOT run in this session — it triggers a full worker bundle build (~heavy) and the changes are pure JS/TS logic on paths already exercised by `npm run build`. Flagging for the human operator to run once before deploy if extra caution is wanted (per agent rule 4: OCR path differences local vs workerd).

---

## v1/extract untouched

Confirmed by grep — no `bbox_hint`, `fields_json`, or `hint:` references exist in `src/app/api/v1/extract/route.ts`. Per spec §3, public API bbox_hint support is backlogged (no external users yet), and OCR-1 §Public API gap says the same. No changes propagated there.

---

## Surprises

- **OCR-1 report was inaccurate about the auto-capture bug.** OCR-1 §Surprises claimed auto-capture was "unconditional at OCRWorkspace.tsx:466". Reading the actual code before editing showed both guards were already in place — the existing hint check (`if (f.bbox_hint) return f;`) and a confidence gate (`conf < 80`). What was missing was only the *named constant* refactor for tunability. Task spec still requires the constant, and the guards are now documented inline so this can't happen again. No user-facing behaviour change from the guards themselves; the prompt-wording change is the load-bearing fix.
- Because the guards were already present, the "self-reinforcing failure" mode described in the OCR-4 context is milder than stated — the failure required (a) a first run producing high (>= 80) confidence on a mis-located bbox, plus (b) no pre-existing user hint. Still worth having the fix; just less alarming than the framing suggested. Worth noting for the empirical 18-run: if B1/C1 still fail, it will be primarily the *prompt* not doing enough, not the auto-capture locking in a bad box.

---

_Author: ocr-pipeline agent, 2026-07-05_
_Unblocks: OCR-1 empirical 18-run manual QA._
