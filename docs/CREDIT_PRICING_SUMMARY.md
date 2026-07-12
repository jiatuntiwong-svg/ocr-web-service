# Credit Pricing — Executive Review

> **DRAFT v1.2** · 2026-07-09 (BILL-1) · verified sprint-close 2026-07-11
> Engineering + Product
> BILL-1 landed: **1 หน้า = 1 credit** เป็น default ใหม่สำหรับ OCR, สลับได้ผ่าน admin
> Sprint-close verify (2026-07-11, deploy `a878584d`): `src/lib/pricing.ts` matches this
> doc — `CreditModel = "per_page" | "field_formula" | "per_file"`,
> `DEFAULT_CREDIT_MODEL = "per_page"`. Charging goes through
> `chargeCreditsAtomic()` in both `/api/upload` and `/api/v1/extract`.
> รอ adjust หลังรอบทดสอบกับ user จริง

---

## 🆕 BILL-1 update (2026-07-09)

**Decision (operator, 2026-07-08):** OCR credit charging **default เปลี่ยนเป็น "1 หน้า = 1 credit"** (per_page). สูตร field-formula เดิม + third option "per-file" เก็บไว้เป็น reserve models สลับได้ผ่าน admin tier-control **ไม่ต้อง redeploy**.

**Config:** `src/lib/pricing.ts` → `CreditModel = "per_page" | "field_formula" | "per_file"`, default `per_page`
**Admin toggle:** `/api/admin/tier-config` (GET returns `credit_model` + `credit_models`; POST accepts `credit_model` field)
**Charge math per model** (OCR only — Compare ใช้สูตรเดิมจนกว่าจะตัดสินแยก):

| Scenario | per_page (new default) | field_formula (reserve) | per_file |
|----------|-----------|-----------------|----------|
| 1-page PDF | 1 | ceil(ocrFactor × mult) | 1 |
| 5-page PDF, 3 pages selected | 3 | ceil(ocrFactor × mult) | 1 |
| Batch × 3 files (1 page each) | 3 (per file) | ×3 (per file) | 3 |
| Single image | 1 | ceil(ocrFactor × mult) | 1 |

**Migration**: ไม่มี retroactive change; `documents.credits_used` เก็บค่าที่ charge จริงตอนนั้น
**Metering**: `logAiUsage` ไม่แตะ — ยังบันทึก token จริงทุก run เพื่อ validate ว่า per_page cover cost (หลัง crop pass + per-page parallel Sprint 2+)

**Security fixes ที่มัดใน BILL-1** (จาก /security-review 2026-07-09):
- Credit deduction race: `/api/v1/extract` unguarded `UPDATE credits_remaining - 1` → เปลี่ยนเป็น `chargeCreditsAtomic()` (single guarded statement, `credits_remaining` drain first + spill to `extra_credits`, 0 rows = INSUFFICIENT_CREDITS). `/api/upload` refactor เข้า helper เดียวกัน ป้องกัน drift ระหว่าง 2 paths ในอนาคต
- Admin settings mask: `first6 + "...." + last4` → `<prefix>...<last4>` (fixed prefix เท่านั้น — `AIza` / `sk-` / `sk-or-` / `••••`), no key material leaked

---

---

## Slide 1 — Scope & Purpose

**เป้าหมาย:** ทบทวนโครงสร้างราคา credit ก่อน lock เป็น production

**สิ่งที่ต้องตัดสินใจ:**
- ราคาต่อ credit (top-up packs)
- Tier credit caps (Free/Starter/Pro/Enterprise)
- การคิดราคาฟีเจอร์ใหม่ (Skill, Compliance)
- Promo / Trial / Enterprise model

**สถานะ:** สูตร + formula deployed แล้ว, ตัวเลขราคา TBD รอผู้บริหารยืนยัน

---

## Slide 2 — หลักการคิด Credit

1. **Predictable** — user คำนวณค่าใช้จ่ายเองได้ก่อนกด
2. **Aligned with AI cost** — feature ที่เรียก AI หนัก → credit สูงตาม
3. **Transparent receipt** — UI แสดง breakdown ทุก step
4. **Integer credits** — ปัดขึ้นเสมอ (user ไม่เห็นทศนิยม)
5. **Tier-driven margin** — Free tight, Pro+ comfortable

---

## Slide 3 — สูตรคิด Credit (Live)

### OCR
```
ocrCredits = max(1, ceil(ocrFactor × modelMult))
where ocrFactor = 1 + max(0, fields − 10) × 0.1
```

### Compare
```
compareCredits = max(2, ceil(ocrFactor × numDocs × 1.5 × tableRowFactor × modelMult))
where tableRowFactor = 1 + max(0, avgRowsPerDoc − 10) × 0.05
```

**Key:** Compare = OCR × docs × 1.5 (overhead) — Compare ใช้ AI หนักกว่า OCR

---

## Slide 4 — ตัวอย่างเลขที่คิดจริง

| Operation | Fields | Docs | Credits | Notes |
|--|--|--|--|--|
| OCR | 5 | 1 | **1** | base |
| OCR | 15 | 1 | **2** | +5 fields above 10 |
| OCR | 30 | 1 | **3** | scaling |
| Compare | 5 | 2 | **2** | min cap |
| Compare | 10 | 2 | **3** | base |
| Compare | 15 | 2 | **5** | +overhead |
| Compare | 10 | 3 | **5** | +1 doc |
| Compare (25 rows) | 10 | 2 | **+1** | post-adjust |

---

## Slide 5 — Tier Structure

| | **Free** | **Starter** | **Pro** | **Enterprise** |
|--|--|--|--|--|
| Credits / month | 50 | 500 | 1,000 | Unlimited |
| Document retention | 50 ล่าสุด | 100 | 500 | 1,000 |
| OCR | ✅ | ✅ | ✅ | ✅ |
| Compare | ❌ | ✅ | ✅ | ✅ |
| Public API | ❌ | ❌ | ✅ | ✅ |
| Templates บันทึก | 3 | 20 | ∞ | ∞ |
| Custom AI config | ❌ | ❌ | ✅ (1) | ✅ (∞) |

---

## Slide 6 — Actual Usage Data (16 วันแรก)

> **ช่วง:** 2026-05-20 → 2026-06-04 · **48 calls · 1 internal tester**

| Metric | OCR | Compare |
|--|--|--|
| Calls | 15 | 28 |
| **Avg input tokens** | **1,200** | **3,289** |
| **Avg output tokens** | **380** | **1,254** |
| **Avg credits charged** | **1.00** | **2.14** |

**Compare ใช้ token ~3.7× ของ OCR** → ตรงกับสูตร × docs × 1.5

⚠️ Sample เล็ก + 1 user → ใช้เป็น baseline แรกเท่านั้น, ปรับ post-launch

---

## Slide 7 — AI Cost ต่อ Call (Flash-Lite)

**Pricing reference** (Gemini Flash-Lite):
- Input: **$0.10 / 1M tokens**
- Output: **$0.40 / 1M tokens**
- USD→THB: **฿35**

| Operation | Cost (USD) | Cost (฿) | Equivalent |
|--|--|--|--|
| **OCR** | $0.00027 | **฿0.0095** | ~1 สตางค์ |
| **Compare** | $0.00083 | **฿0.029** | ~3 สตางค์ |

→ AI cost จริงต่ำมาก, **ราคาขาย credit ส่วนใหญ่เป็น margin**

---

## Slide 8 — Margin Analysis

ทดสอบ 4 ราคา/credit:

| Price / credit | OCR margin | Compare margin | Verdict |
|--|--|--|--|
| **฿0.50** | 98.1% | 97.3% | aggressive growth |
| **฿1.00** ⭐ | 99.0% | 98.6% | **แนะนำ — balanced** |
| **฿2.00** | 99.5% | 99.3% | premium |
| **฿3.00** | 99.7% | 99.5% | high-end |

**Key insight:** ที่ราคา ฿1/credit:
- Free tier (50 credits) = มูลค่า **฿50/เดือน/user**
- Starter (500) ขาย ฿299-499 → margin ~90%
- Pro (1,000) ขาย ฿799-1,499 → margin ~95%

---

## Slide 9 — Cost ที่ยังไม่รวมในสูตร AI

| Item | ประมาณ | กระทบ |
|--|--|--|
| **Stripe fees** | 2.95% + ฿10/transaction | ⚠️ ใหญ่สุด — pack เล็กเจ็บ |
| Cloudflare Workers | ~$5/เดือน/10K user | เล็ก |
| D1 reads/writes | $0.001 / 1M reads | เล็ก |
| R2 storage | $0.015/GB/เดือน | เล็ก |
| Bandwidth (R2 egress) | ฟรีผ่าน CF | — |
| Dev/Support | ตามทีม | fixed |

→ ออกแบบ pack ใหญ่ขึ้น (≥฿299) เพื่อ absorb Stripe fee

---

## Slide 10 — Break-even Analysis: ที่ราคาเท่าไหร่ขาดทุน?

**3 ระดับ break-even** (จาก loose → strict)

### Layer 1 — AI cost only (absolute floor)
ราคาขั้นต่ำ/credit เพื่อไม่ขาดทุนจาก AI:

| Mix | Cost/credit | Break-even |
|--|--|--|
| All OCR (best case) | ฿0.0095 | **≥ ฿0.010** |
| Average mix (60% Compare) | ฿0.022 | **≥ ฿0.022** |
| All Compare (worst case) | ฿0.029 / 2.14 = ฿0.014 | **≥ ฿0.014** |

→ ราคา < **฿0.022/credit** ขาดทุน AI ทันที (mixed workload)

---

## Slide 11 — Break-even ระดับ 2: AI + Stripe Fee

Stripe = 2.95% + ฿10/transaction (per top-up purchase)

| Pack | Credits | Stripe Fee | AI cost (all Compare) | Break-even pack price | Break-even/credit |
|--|--|--|--|--|--|
| Small | 50 | ฿12.92 | ฿0.70 | **฿14** | **฿0.27** |
| Medium | 200 | ฿18.82 | ฿2.80 | **฿22** | **฿0.11** |
| Large | 500 | ฿27.67 | ฿7.00 | **฿35** | **฿0.07** |
| Bulk | 2,000 | ฿68.97 | ฿28.00 | **฿97** | **฿0.05** |

**Insight:** Pack ใหญ่ break-even ต่อ credit ต่ำลงเรื่อยๆ เพราะ Stripe fee ฿10 ถูกหารด้วย credit เยอะ — **Bulk pack ขายได้ถูกสุดโดยไม่ขาดทุน**

---

## Slide 12 — Break-even ระดับ 3: Free Tier Subsidy + Infra

**Assumption:** 1,000 active users mix, 5% paid conversion

| Item | Free user | Paid user (Pro) |
|--|--|--|
| Count | 950 | 50 |
| Monthly cost (AI + infra share) | ~฿30/user | ~฿100/user |
| Monthly revenue | ฿0 | ฿1,500/user |
| Subtotal cost/mo | ฿28,500 | ฿5,000 |
| Subtotal revenue/mo | ฿0 | ฿75,000 |

**Net margin:** ฿75,000 − ฿33,500 = **฿41,500/mo (~55%)**

### Conversion break-even
ที่ราคา ฿1/credit + Pro = ฿1,500/mo:
- ต้องการ paid conversion **≥ 2.5%** เพื่อ cover free tier
- < 2.5% → free tier subsidy เกิน, ขาดทุนรายเดือน
- **Industry benchmark: B2B SaaS = 3-5%** → safe zone

---

## Slide 13 — ราคาเสนอเทียบ Break-even

| Price/credit | vs Break-even | Margin range | Risk level |
|--|--|--|--|
| ฿0.05 | < Bulk break-even | -100% | 🔴 ขาดทุนทันที |
| ฿0.10 | ใกล้ Bulk break-even | -50% | 🔴 อันตราย |
| ฿0.30 | กำไรทุก pack | +30-80% | 🟡 thin margin |
| ฿0.50 | ห่าง break-even 7-23× | +90-98% | 🟢 OK |
| **฿1.00 ⭐** | **ห่าง break-even 14-45×** | **+97-99%** | **🟢 แนะนำ** |
| ฿2.00 | ห่าง break-even 28-90× | +99%+ | 🟢 premium |

### Safety buffer ที่ ฿1.00/credit รองรับได้:
- ✅ AI cost พุ่ง 2-3× (ถ้า upgrade เป็น Gemini Pro)
- ✅ Stripe fee เพิ่ม (ถ้าเปลี่ยน PSP)
- ✅ Free tier abuse / fake account
- ✅ Infra cost พุ่ง 10× (ถ้า user grow เร็ว)
- ✅ Support cost จริงสูงกว่าคาด

**→ ราคา ฿1.00/credit มี buffer สูง เผื่อ unknowns**

---

## Slide 14 — Top-up Pack Pricing (รอยืนยัน)

| Pack | Credits | ราคาที่เสนอ | ราคา/credit | Margin หลัง Stripe |
|--|--|--|--|--|
| Small | 50 | ฿99 | ฿1.98 | ~93% |
| Medium | 200 | ฿299 | ฿1.50 | ~94% |
| Large | 500 | ฿599 | ฿1.20 | ~96% |
| Bulk | 2,000 | ฿1,999 | ฿1.00 | ~97% |

> **ตัวเลขเสนอเบื้องต้น** — รอผู้บริหารตัดสินใจตาม market positioning

---

## Slide 15 — ฟีเจอร์ที่ Ship แล้ว (ไม่คิด credit เพิ่ม)

| Feature | Date | Pricing |
|--|--|--|
| ✅ G3 Confidence + Manual Review | 2026-05-30 | ไม่คิดเพิ่ม |
| ✅ Notifications + Bell | 2026-05-30 | ไม่คิดเพิ่ม |
| ✅ Smart/Strict Verdict mode | 2026-05-30 | ไม่คิดเพิ่ม |
| ✅ Password hash (security) | 2026-05-28 | ไม่คิดเพิ่ม |

**เหตุผล:** UX/security/infrastructure — ไม่กระทบ AI call

---

## Slide 16 — ฟีเจอร์ Planned + Pricing เสนอ

### Skill System (Markdown-based custom rules)
| Operation | Credit |
|--|--|
| OCR + skill | base **+1** |
| Compare + skill | base **+1** |
| **Compliance mode** (Mode A) | base **× 1.5** |

### Skill creation limits per tier
| | Free | Starter | Pro | Enterprise |
|--|--|--|--|--|
| สร้าง skill | 0 | 3 | 20 | ∞ |
| Max skill size | — | 2 KB | 8 KB | 32 KB |
| Compliance mode | ❌ | ❌ | ✅ | ✅ |
| Share public | ❌ | ❌ | ✅ | ✅ |

---

## Slide 17 — ฟีเจอร์ Planned (ไม่คิด credit)

| Feature | Pricing | เหตุผล |
|--|--|--|
| Email verification | ฟรี | infra |
| Forgot password | ฟรี | infra |
| Google Login | ฟรี | auth |
| Google Drive import | ฟรี (ไฟล์ที่ import คิดตาม OCR ปกติ) | input method |
| Screen capture paste | ฟรี | input method |
| LINE OA upload | **TBD** — รอ meeting | cross-team |
| Webhook delivery | **TBD** — รอ meeting | downstream |

---

## Slide 18 — ความเสี่ยง / ที่ต้องระวัง

| Risk | Mitigation |
|--|--|
| User เลือก Pro AI model (Gemini Pro/Thinking) → cost แพง 10-50× | เพิ่ม **model multiplier** ใน pricing (1.5-2.5×) |
| Free tier ใช้เกินจุดคุ้มทุน | Caps + push upgrade UI |
| Skill content ยาวเกิน → token แพง | Hard cap 8 KB + warning |
| Stripe fee กิน margin pack เล็ก | ขั้นต่ำ ฿99/pack |
| Margin จริงต่ำกว่าคาด (infra ใหญ่ขึ้น) | Quarterly review + adjustment |
| Enterprise unlimited abuse | Fair-use policy + soft caps |

---

## Slide 19 — Decisions ที่ต้องผู้บริหารยืนยัน

1. **ราคาต่อ credit** — ฿0.50 / ฿1.00 / ฿2.00? (แนะนำ ฿1.00)
2. **Top-up pack sizes + ราคา** — ตาม slide 10 หรือปรับ?
3. **Trial period** สำหรับ Pro — 7/14 วันฟรี?
4. **Promo launch** — ลด 30% เดือนแรก?
5. **Enterprise model** — flat fee/เดือน หรือ custom contract?
6. **Skill marketplace** (Phase 2) — เก็บ commission กี่ %?
7. **LINE OA upload** — คิด credit เหมือนเว็บ หรือ premium?

---

## Slide 20 — Action Plan หลัง Approval

| Week | Action |
|--|--|
| 1 | Lock pricing + update Stripe prices |
| 1 | Update UI ราคา + receipt strings |
| 2 | Open soft-launch กับ test cohort (~20 user) |
| 4 | Collect usage data + margin analysis รอบ 2 |
| 6 | Adjust formulas ตาม actual data (v2 ของเอกสารนี้) |
| 8 | Open public (ถ้า margin OK) |

---

## Appendix A — สูตรในโค้ด

| Logic | File | Function |
|--|--|--|
| Pre-run estimate | [src/lib/pricing.ts](../src/lib/pricing.ts) | `estimateCredits()` |
| Post-run actual | [src/lib/pricing.ts](../src/lib/pricing.ts) | `actualCredits()` |
| Credit charging (shared helper) | [src/lib/credits.ts](../src/lib/credits.ts) | `chargeCreditsAtomic()` — used by `/api/upload` + `/api/v1/extract` |
| Active credit model lookup | [src/lib/credits.ts](../src/lib/credits.ts) | `getActiveCreditModel(env)` |
| Tier config | [src/lib/tier-config.ts](../src/lib/tier-config.ts) | `loadTierCredits()` |
| Admin tuning UI | [src/components/AdminTierControlView.tsx](../src/components/AdminTierControlView.tsx) | — |

---

## Appendix B — Raw Data Snapshot (2026-05-20 → 2026-06-04)

### Per model × function (Flash-Lite only — ตัด Flash 3.5 ออก)

| Function | Model | Calls | Avg in tok | Avg out tok |
|--|--|--|--|--|
| compare | gemini-3.1-flash-lite | 17 | 3,412 | 1,369 |
| compare | gemini-3.1-flash-lite-preview | 11 | 3,062 | 997 |
| ocr | gemini-3.1-flash-lite-preview | 10 | 1,106 | 354 |
| ocr | gemini-3.1-flash-lite | 5 | 1,386 | 431 |

### Documents charged (period)
| Type | Records | Avg credits | Total credits |
|--|--|--|--|
| compare | 37 | 2.14 | 79 |
| ocr | 16 | 1.00 | 16 |

### หมายเหตุ
- Flash 3.5 (5 calls) ตัดออกจาก analysis เพราะ thinking tokens ทำให้ output spike → ไม่ representative
- Sample size เล็ก (n=43 Flash-Lite calls, 1 user)
- จะมี analysis รอบ 2 หลังเปิด test cohort ที่มี user หลากหลาย

---

## Revision History

| Version | Date | Change | Author |
|--|--|--|--|
| v1.0 (DRAFT) | 2026-05-31 | Initial draft — formulas + planned features | Eng |
| v1.1 | 2026-06-04 | เพิ่ม actual usage data + margin analysis, slide-ready format | Eng |
| **v1.2** | **2026-06-04** | **เพิ่ม Break-even analysis 3 layers (Slide 10-13)** | **Eng** |
| v2.0 | TBD | Lock pricing หลัง executive approval | TBD |
| v2.1 | TBD | Adjust หลัง test cohort | TBD |
