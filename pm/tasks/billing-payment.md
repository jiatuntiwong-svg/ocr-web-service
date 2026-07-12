# Work orders — billing-payment agent

Sprint: OCR Stabilization (tail) / Sprint 2. Update pm/BOARD.md status when you start/finish.

---

## BILL-1 (P1) — Switchable credit model: per-page (default) / field-formula / per-file

**Decision (operator, 2026-07-08):** credit charging for OCR changes to **1 page = 1 credit** as the new default. The existing field-count formula AND a third model (1 file = 1 credit) must be kept as switchable reserves — not deleted.

**Do:**
1. **Config:** `CREDIT_MODEL = "per_page" | "field_formula" | "per_file"` — single source of truth in `src/lib/pricing.ts`, surfaced in Admin tier-control (`api/admin/tier-config` + AdminTierControlView) so switching needs no redeploy. Default: `per_page`.
2. **Charging logic:**
   - `per_page`: credits = จำนวนหน้าที่เลือก (page selection จาก API-1); ไฟล์ภาพเดี่ยว = 1 หน้า; batch = รวมต่อไฟล์ตามหน้าของไฟล์นั้น
   - `field_formula`: พฤติกรรมปัจจุบัน (field count based) — keep byte-identical
   - `per_file`: 1 credit ต่อไฟล์ ไม่สนหน้า/field
3. **Estimate + UI:** `CreditConfirmDialog` and the credit-estimate card must compute from the active model (frontend reads model from an existing config endpoint — coordinate with frontend-ui; UI-4b's estimate card shows "X หน้า × 1 credit").
4. **Metering unchanged:** `logAiUsage` still records real tokens per run regardless of model — we need this data to validate whether 1 หน้า/1 credit covers cost (esp. with crop pass + future per-page parallel).
5. **Docs:** update `docs/CREDIT_PRICING_SUMMARY.md` — mark the G1 multiplicative formula as "reserve model", record this decision + date.
6. **Migration:** no retroactive changes to charged credits. `documents.credits_used` keeps whatever was charged at run time.

**Out of scope / flagged open questions for PM:**
- **Compare pricing** — decision covers OCR only. Compare ยังใช้สูตรเดิมจนกว่าจะตัดสินใจแยก (per-page × num_docs?)
- Full-document OCR mode (UI-4b) ใช้ per_page โดยธรรมชาติ — no special case needed
- Flash→Pro escalation multiplier (Sprint 2+) จะคูณบนโมเดลที่ active

**Added scope (from /security-review 2026-07-09 — fix while you're in the credit code):**
- `v1/extract` credit deduction race: change the unguarded `UPDATE credits_remaining - 1` to a guarded atomic form (`... SET credits_remaining = credits_remaining - ? WHERE id = ? AND credits_remaining >= ?`) and treat 0 rows affected as INSUFFICIENT_CREDITS. Check `/api/upload`'s deduction too — review said upload is already guarded; verify and align both paths on the same helper.
- Tighten admin settings key masking from `first6 + "...." + last4` to `AIza...` + last 4 only (`admin/settings/route.ts:55`).

**Acceptance:** switching model in admin takes effect on next run without redeploy; all 3 models unit-verified against: 1-page PDF, 5-page PDF with 3 pages selected, batch 3 files, single image; estimate shown to user matches actual deduction in every case; both security-review observations above fixed.
