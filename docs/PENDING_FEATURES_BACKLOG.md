# Pending Features Backlog

> สถานะ: **บันทึกไว้รอตัดสินใจ** — ยังไม่เริ่ม implement
> วันที่บันทึก: 2026-05-31
> อัปเดตล่าสุด: 2026-07-11 — OCR Stabilization sprint close (deploy `a878584d`)
> Production URL: https://ocr-web-service.jiatuntiwong.workers.dev

## ✅ Landed since last audit (2026-07-11 sprint close)

- **F4 Upload size guard** (20 MB cap, `FILE_TOO_LARGE` code) — API-3
- **Retry failed OCR UI** (temp 0.6 + overflow menu / kbd R) — OCR-3 + UI-4c
- **Page selection UI** (thumbnail picker, cap 5) — API-1 + UI-1, closes issue 1.3
- **Vertex AI provider** (express mode, `x-goog-api-key` header) — AI-1
- **Credit model switcher** (per_page default, admin-switchable to field_formula / per_file) — BILL-1
- **OCR workspace v3** (stepper, page picker, hint drawing toggle, fulldoc mode, ⚡ Quick mode) — UI-4/4b/4c, flag ON in prod
- **Template picker with delete** (⭐ favourites / 🕐 recent / 📋 all, inline-confirm delete, system templates gated) — UI-6
- **Coded errors on OCR routes** + `friendlyError()` catalog (OCR + auth flows only) — API-2 + UI-3, closes H1-H4 for those flows
- **Atomic credit charge** (`chargeCreditsAtomic()`) + admin API key masking — BILL-1

---

## 🔴 Critical — ขาดแล้วน่ากังวลสำหรับ production SaaS

### Auth & Security
- [ ] **Forgot password / reset password flow** — ไม่มีเลย user ลืม password คือล็อกเลย
- [ ] **Email verification ตอน register**
  - Decision ที่ตัดสินแล้ว: **Block login จนกว่าจะ verify** (strict)
  - Legacy users: **Backfill `email_verified_at = created_at`** (สมมติ verified ทั้งหมด)
  - Email provider: ยังไม่ตัดสิน — ตัวเลือก: Resend (แนะนำ), MailChannels (ฟรีบน CF), SendGrid, Brevo, AWS SES, NIPA/Z.com (TH)
  - Schema เตรียมไว้: `email_verifications(token PK, user_id, email, expires_at, consumed_at, created_at)` + `users.email_verified_at`
- [ ] **Rate limiting auth endpoints** — `/api/auth` ไม่กัน brute force (notify spike มี แต่ไม่ block)
- [ ] **Change password (self-service)** — user เปลี่ยน password เองไม่ได้
- [ ] **Logout from all devices / session list** — token expire 7 วัน แต่ revoke ไม่ได้
- [ ] **HIBP breach check** — ตรวจ password ที่ register/change ผ่าน haveibeenpwned k-anonymity API

### Account / GDPR-ish
- [ ] **User profile edit** (name, email)
- [ ] **Account deletion** (กฎหมายไทย/EU)
- [ ] **Data export** (download my data)
- [ ] **Avatar upload** — มี `avatar_url` column แล้ว แต่ไม่มี UI

### Billing
- [ ] **Invoice/receipt PDF download**
- [ ] **Cancel subscription UI** — มี webhook รับ canceled แต่ user กดยกเลิกจาก app ไม่ได้
- [ ] **Promo codes / coupons**
- [ ] **Trial period** (Free ตอนนี้คือ tier ไม่ใช่ trial)
- [ ] **Annual billing discount**
- [ ] **Refund flow**

---

## 🟡 High impact — ผู้ใช้น่าจะถามหา

### OCR core
- [ ] **Batch upload** (drag หลายไฟล์พร้อมกัน)
- [ ] **Bulk export** จาก Documents
- [ ] **API key management UI** — `/api/v1/extract` ตอนนี้ใช้ email+password (แม้จะ hash แล้ว ก็ไม่ใช่ industry practice — ควรเป็น API key revocable)
- [ ] **Folder / tag / label** สำหรับจัดเอกสาร
- [ ] **Search by extracted content** (ตอนนี้ search ได้แค่ filename)
- [ ] **Re-process button** (run OCR ซ้ำด้วย template ใหม่)
- [ ] **Version history** ของ OCR re-run

### Compare (จาก PENDING_ISSUES)
- [ ] **A2** Semantic equivalence (`10+5+3` ≡ `18`, `25 PCS` ≡ `25 ชิ้น`)
- [ ] **A3** Date format normalize (`26/09/2025` ≡ `26 SEP 2025`)
- [ ] **A4** Currency format normalize (`USD 51,651.11` ≡ `51651.11 USD`)
- [ ] **B** .docx fidelity decision (Hybrid / CloudConvert / Self-host LibreOffice)
- [ ] **C** .doc legacy support (POC verified `word-extractor` แล้ว ยังไม่ implement, text-only mode)
- [ ] **D 6C-3b** Native Excel Compare (ตอนนี้ image→cell-match → false-positive ได้)
- [ ] **F2** Manual override AI verdict (ปุ่ม "actually same"/"actually diff")
- [ ] **A5** List set semantics (`A,B,C` ≡ `C,A,B`)
- [ ] **A6** Thai OCR character segmentation edge cases

### Templates
- [ ] **Template sharing** (within org / public marketplace)
- [ ] **Template versioning** (กลับไปเวอร์ชันเก่าได้)
- [ ] **Field type beyond text/date/table** (currency, address, person, signature detection)

### Skill system (Compliance + Compare-with-rules) — LLM-based, .md authoring

User-authored markdown files appended to AI prompt as "additional rules". Covers two modes:
- **Mode A — Compliance check** (1 doc + rules → pass/fail report per rule). Use case: international shipping doc validation (USA Customs, EU CBAM, Thai e-Tax invoice), special-character allow-lists, country-specific unit rules.
- **Mode B — Compare + rules** (2 doc + rules override existing Compare verdict). Use case: domain-specific equality (kg ↔ ton, USD ↔ EUR within 1%, container code leading zeros).

**Why LLM not validator engine:** AI understands natural-language rules directly → user authors in plain English/Thai .md, no schema/syntax to learn. Token cost is negligible (4KB skill ≈ 1000 tokens ≈ $0.0001 vs OCR image base). Implementation cost is days not weeks (vs full validator + sandboxed expression engine = 4-5 weeks).

**Decisions already made (2026-05-31 session):**
- Pricing: **Flat +1 credit** when skill is attached to OCR/Compare; Compliance mode = OCR base × 1.5
- Tier limits on skill **authoring**: Free 0 / Starter 3 / Pro 20 / Enterprise unlimited (skill SIZE caps: Starter 2KB, Pro 8KB, Ent 32KB)
- Compliance mode (Mode A) **gated to Pro+** — premium differentiator
- Free users can *use* a public skill (lead-gen), but cannot *create* one

**Skill format (example USA Customs):**
```markdown
# USA Customs Shipping Rules

## Special characters
- PO numbers: NO special chars (no # / & @)
- Container codes must follow ISO 6346 (4 letters + 7 digits)

## Units
- Weight: kg, lb, metric ton
- Treat 1 ton = 1000 kg as EQUAL

## Compliance flags
- Origin=China AND HS Code starts with "73" → flag for review
- Total > $2500 → require formal entry declaration

## Compare exceptions
- Container codes: ignore leading zeros
- Weight: ±0.5% rounding tolerance
- USD ↔ EUR within 1% considered equal
```

**Schema:**
```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  content TEXT NOT NULL,             -- raw markdown, ≤ tier cap
  visibility TEXT DEFAULT 'private', -- 'private' | 'public' (Pro+ can publish)
  is_active INTEGER DEFAULT 1,
  use_count INTEGER DEFAULT 0,       -- for analytics + author revenue share later
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_skills_user ON skills(user_id, is_active);
CREATE INDEX idx_skills_public ON skills(visibility) WHERE visibility = 'public';
```

**Implementation breakdown (~3-4 days fulltime):**
- Mode A (Compliance): 11 hr — skill CRUD (2h) + `/api/compliance` route + prompt template (3h) + result schema (1h) + Compliance workspace UI (4h) + violation highlight on doc (3h, can defer)
- Mode B (Compare + rules): 2.5 hr — append skill content to compare prompt (1h) + skill selector next to verdict-mode dropdown (1h) + cache key incl. skill.id+updated_at (0.5h)
- Shared: 5 hr — skill picker UI + preview + i18n (2h) + manual test + polish (3h)

**Scope tiers (pick when implementing):**
1. **MVP smallest** (~0.5 day) — Just textarea on CompareWorkspace ("Custom Rules" text field, no save). User pastes rules → appended to prompt. No skill CRUD, no library. Cache key hashes the rules text.
2. **Mid MVP** (~2 days) — Add skills table + UI list + .md upload. Compliance mode: AI returns `{pass:[], fail:[]}`, UI shows plain list (no highlight box yet).
3. **Full MVP** (~3-4 days) — Includes violation highlights + skill cards/list + import-export.

**Abuse / safety:**
- Hard cap skill size at 8KB regardless of tier (prompt bomb defense)
- Rate limit skill update: 30/day
- Sanitize skill content for prompt injection markers ("[SYSTEM]", "Ignore previous instructions", etc.) — flag but don't auto-reject
- Skills affect only the calling user's own request — no cross-user impact

**Future phases (not now, for context):**
- Public marketplace (browse / clone / star / rating)
- Author revenue share when public skill is used
- Skill bundles ("Logistics Bundle" sub for 50 credit/mo)
- Verified Skill badge (admin-approved)
- Custom enterprise skill (service revenue: we author for Enterprise customers)

**Risks:**
- AI compliance verdict may be wrong → pair with per-rule confidence + F2 manual override
- Token cost grows if user authors very long skills → 8KB cap + show estimated token count in editor
- Prompt injection attempts inside skill → sanitization + per-user scope already isolates damage

### Google Sign-In + Drive Picker
ทั้งคู่ใช้ OAuth client เดียวกันได้ — แนะนำทำคู่กันเพื่อแชร์ setup

**Part A — Login with Google** (~1 วัน)
- OAuth 2.0 flow: redirect → consent → callback → exchange code → verify id_token
- DB: `users.google_id TEXT UNIQUE`, `users.auth_provider TEXT DEFAULT 'password'` ('password' | 'google' | 'both')
- Account linking: ถ้า email ตรง → auto-link (Google verify email ให้แล้ว → ตั้ง `email_verified_at` ด้วย)
- New routes: `/api/auth/google/start`, `/api/auth/google/callback`
- UI: "Continue with Google" button บน login/register page
- Edge cases: existing email/password user signs in with Google ครั้งแรก → auto-link เพราะ Google verify email ให้แล้ว

**Part B — Import from Google Drive** (~0.5-1 วัน)
- Scope: `drive.file` (เฉพาะไฟล์ที่ user pick ผ่าน Picker) — ไม่ต้อง Google app verification
- Google Picker API JS widget (load จาก `apis.google.com/js/api.js`)
- Flow: คลิก "Import from Drive" → tokenClient.requestAccessToken → Picker → user pick → Drive API download → blob → ส่งเข้า upload pipeline เดิม
- UI: ปุ่ม "📁 Import from Drive" ใน OCR + Compare workspace ติดข้าง upload button

**Google Cloud setup ต้องทำก่อน implement:**
1. console.cloud.google.com → สร้าง project
2. APIs & Services → OAuth consent screen → fill app info + scopes (`openid email profile drive.file`)
3. Credentials → Create OAuth Client ID → Web application
   - Authorized JavaScript origins: production URL
   - Authorized redirect URIs: `<URL>/api/auth/google/callback`
4. เก็บ secrets ใน CF: `wrangler secret put GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
5. (เพิ่ม) Domain verification + Privacy Policy/ToS URLs ใน consent screen ก่อนเปิด Production mode

**ข้อควรระวัง:**
- `drive.readonly` (เห็นทุกไฟล์) ต้อง app verification 1-3 เดือน + security audit (อาจ $15-75k ถ้า restricted scope) — **อย่าใช้**, ให้ใช้ `drive.file` แทน
- OAuth consent screen ใน Testing mode = สูงสุด 100 users — ต้องสลับ Production ก่อน launch
- `refresh_token` ถ้าจะเก็บใน DB ต้อง encrypt
- Domain verification ของ Google Search Console ต้องทำสำหรับ custom domain

**ผลพลอย:** Login ด้วย Google → email_verified อัตโนมัติ → ลดการพึ่งพา Email verification flow (#2 ในลำดับเร่งด่วน)

---

### Screen-capture input (LINE-style paste-to-preview)
ลด friction ตอน user อยากเอาภาพหน้าจอเข้าระบบ — ปัจจุบันต้อง save → upload ทีละ 2 step

**Level 1 — Paste from clipboard** (แนะนำเริ่ม)
- เพิ่ม `paste` event listener บน OCR + Compare drop zones
- รับ `clipboardData.items` type=image → convert เป็น `File` → ส่งเข้า upload pipeline เดิม
- เพิ่ม hint "📋 หรือกด Ctrl+V หลัง capture ด้วย Win+Shift+S / Cmd+Shift+4"
- Toast แจ้งถ้า detect ว่า clipboard มีรูปอยู่
- ใช้เวลา ~30 นาที

**Level 2 — Drag & drop image** (น่าจะรองรับอยู่แล้ว — ตรวจสอบ)
- Verify drop zone รับ `image/*` MIME types ตรงๆ ได้

**Level 3 — In-browser screen capture** (deferred — ปุ่ม Capture screen)
- ใช้ `navigator.mediaDevices.getDisplayMedia()` → ขอ permission → snapshot frame
- แสดงใน modal + rectangle crop tool (canvas-based)
- Crop เสร็จ → ส่งเข้า upload pipeline
- ข้อจำกัด: browser แสดง "stop sharing" bar กวน + permission popup ทุกครั้ง
- ใช้เวลา ~2-3 วัน

**ที่ทำไม่ได้ใน browser:**
- แบบ LINE desktop ที่ dim ทั้งจอ + ลากกรอบบน desktop จริง — browser sandbox ไม่อนุญาตให้ overlay เกินขอบ window
- ต้องเป็น Electron/Tauri app หรือ browser extension เท่านั้น

### Admin
- [ ] **Manual credit grant / topup** จาก admin + audit trail
- [ ] **Send announcement** ถึง user ทั้งหมด (broadcast email/in-app)
- [ ] **Search/filter users** ในหน้า AdminUsers
- [ ] **Stripe sync repair tool** (กรณี webhook miss)
- [ ] **AI cost per user breakdown** (มี admin/ai-usage แต่ยังไม่ break down ระดับ user?)

### Notifications (เพิ่ง ship — เหลือ polish)
- [ ] **Email channel** — ตอนนี้ in-app เท่านั้น user ที่ไม่ได้ login จะไม่เห็น
- [ ] **Per-user notification preferences** (toggle เรื่องไหนอยากรับ)
- [ ] **Daily digest email**
- [ ] **Full notifications page** (dropdown แสดง 50 — ถ้าเยอะกว่านี้ดูไม่ได้)
- [ ] **WebSocket/SSE แทน 30s polling** (real-time + ประหยัด request)

---

## 🟢 Nice-to-have — ขาด แต่ไม่ใช่ blocker

### UX / Onboarding
- [ ] **First-time tutorial / walkthrough**
- [ ] **Sample documents to try**
- [ ] **Help docs / FAQ page**
- [ ] **In-app changelog** (อะไรใหม่)
- [ ] **Tooltips บน UI ซับซ้อน**
- [ ] **G1k Settings UI** สำหรับ smart-confirm threshold (T1-T4)
- [ ] **G1h "How credits work" explainer page**

### Mobile / PWA
- [ ] **Mobile responsive audit** (CompareWorkspace น่าจะพังบนมือถือ)
- [ ] **PWA install** (Add to Home Screen)
- [ ] **Camera capture upload** (ถ่ายเอกสารจากมือถือ → upload เลย)

### Compliance / Legal
- [ ] **Terms of Service page**
- [ ] **Privacy Policy page**
- [ ] **Cookie consent banner** (สำหรับ EU)
- [ ] **User-visible audit log** (system_logs มี แต่ user ดูของตัวเองไม่ได้)

### Reliability / Ops
- [ ] **Error tracking** (Sentry / Cloudflare logs ที่ดูง่ายขึ้น)
- [ ] **Background job queue** (OCR ยาวๆ ใช้ `ctx.waitUntil` ซึ่งจะ kill ที่ ~30s)
- [x] **Retry failed OCR UI** — done 2026-07-11 (OCR-3 handler `temperature: 0.6` + UI-4c overflow menu "Retry" / kbd R in `OCRWorkspaceV2`). See `pm/reports/OCR-3.md`, `pm/reports/UI-4c.md`
- [ ] **Health check endpoint monitoring** (มี `/api/status` แต่ใครเรียก / monitor อยู่?)
- [ ] **Reduce verbose console.log** ใน webhook/stripe (10 จุด emoji-style debug logs)

### i18n leftover
- [ ] **E i18n** — `renderCompareData` ใน DashboardView ยังมี hardcoded Thai
- [ ] เพิ่มภาษาอื่น? RTL support?

### Testing / CI
- [ ] **Unit tests** — เท่าที่ดูไม่มีเลย
- [ ] **E2E tests** (Playwright)
- [ ] **CI/CD pipeline** — Cloudflare deploy ตรง ไม่มี gate ตรวจ
- [ ] **Fix ESLint** — `eslint-config-next` ขัดแย้งกับ zod version, `npm run lint` ใช้ไม่ได้
- [ ] **Tests for G3:** assert ไม่มี `err.stack` หลุดใน response body, ไม่มี `setError(rawError)` ใน frontend
- [ ] **Tests for compare:** row-diff math (LCS pair, missing rows, diff_columns), friendlyError pattern matching

### Other UX
- [ ] **F1** PDF page navigator buttons
- [ ] **F3** Light-theme palette QA
- [x] **F4** Upload size guard — done 2026-07-09 (API-3, 20 MB cap, `pm/reports/API-3.md`)
- [ ] **F5** Mixed file types in Compare

---

## 🔵 Roadmap items (deferred — รอ stakeholder/meeting)

### Pending cross-team meeting
- [ ] **LINE OA channel** + **Webhook delivery (downstream integration)** — full plan at [docs/PENDING_LINE_AND_INTEGRATIONS_PLAN.md](PENDING_LINE_AND_INTEGRATIONS_PLAN.md)
  - n8n / Make / Zapier presets
  - Email / Slack / Discord / Google Sheets integrations
  - LINE link account flow + Flex Message + reply/push pattern
  - Webhook payload contract + HMAC signing + retry/circuit-breaker

### Big phase work
- [ ] **G2 Skill.md rules** (biggest competitive moat, Phase 8 scope ใหญ่)
- [ ] **G4** 4-doc compare + XML support
- [ ] **G5** Webhook + bulk export + n8n connector

---

## 🧹 House-keeping ก่อน push to git (ถ้าจะทำ)

### ควรเพิ่มใน .gitignore
```
.claude/
public/pdf.worker.min.mjs
/*.html
design_handoff_docroom_redesign/
```

### ไฟล์ขยะใน working tree
- `DOCRoom Logo _Standalone_.html` (root, ชื่อมี space)
- `design_handoff_docroom_redesign/` (~60KB)

---

## 🎯 ลำดับเร่งด่วนที่แนะนำ (จากการคุย session ล่าสุด)

| # | งาน | เหตุผล |
|--|--|--|
| 1 | **Forgot password** | ทุก SaaS ต้องมี — user ลืมก็จบ |
| 2 | **Email verification** | กัน fake account, จำเป็นถ้าจะส่ง email digest. Decision: Block login strict + backfill legacy |
| 3 | **API key management** | `/api/v1/extract` ใช้ email+password เป็น anti-pattern |
| 4 | **Cancel subscription / invoice download** | ลูกค้าจ่ายเงินแล้วจะอยากกดเอง |
| 5 | **A2-A4 prompt overhaul** | ลด false-positive ใน Compare ที่ user complain บ่อยสุด |
| 6 | **Email channel ของ notifications** | leverage งานที่เพิ่ง ship — ขยาย reach |
