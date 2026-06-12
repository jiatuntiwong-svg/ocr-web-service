# LINE OA + Downstream Integration — Pending Plan

> สถานะ: **รอประชุมร่วมกับอีกทีม** ก่อนเริ่ม implement
> วันที่บันทึก: 2026-05-28
> Scope: เพิ่ม LINE OA channel ให้ user ส่งเอกสารผ่าน LINE + forward ผล OCR ไประบบปลายทาง (ERP / n8n / webhook)

---

## Part A — LINE OA Integration

### A.1 LINE Channel setup
- สร้าง Messaging API channel บน LINE Developers Console
- Env vars: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`
- Webhook URL: `https://<domain>/api/line/webhook`
- ปิด auto-reply / greeting (reply เองผ่าน API)

### A.2 Database schema
```sql
CREATE TABLE line_accounts (
  line_user_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  link_token TEXT,
  link_token_expires_at DATETIME,
  linked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_line_accounts_user ON line_accounts(user_id);
```

### A.3 Webhook endpoint `/api/line/webhook`
- **Verify signature** (HMAC-SHA256 raw body กับ `X-Line-Signature`) — บังคับ
- Events:
  - `follow` → reply ทักทาย + ลิงก์ link account
  - `message` (text) → command: `/link`, `/credit`, `/help`, `/unlink`
  - `message` (image/file) → download → OCR
  - `unfollow` → soft-disable (ไม่ลบ row)
- Return 200 ภายใน 1 วินาที → งานหนัก async ผ่าน `ctx.waitUntil()` หรือ Queue

### A.4 Account linking — แนะนำ Link Token (UX ง่ายสุด)
1. User add LINE OA → reply "พิมพ์ `/link`"
2. User พิมพ์ `/link` → bot สร้าง 6-8 หลัก token (expire 10 นาที)
3. Bot reply "เข้าเว็บ → Settings → Connect LINE → ใส่รหัส **ABC123**"
4. User login web → กรอกรหัส → API verify + เซ็ต user_id
5. Bot push "เชื่อมต่อสำเร็จ ✅"

ทางเลือก B: LINE Login OAuth — UX ดีกว่าแต่ต้องเพิ่ม channel แยก + redirect

### A.5 Document processing flow
```
LINE ส่งไฟล์ → webhook ได้ messageId
  → ตรวจ line_accounts (link แล้วหรือยัง)
  → GET https://api-data.line.me/v2/bot/message/{messageId}/content
  → ตรวจ credit (reuse logic /api/upload)
  → R2 upload + OCR pipeline (reuse ai-handler)
  → reply กลับ LINE: text สั้น หรือ Flex Message + deeplink
```

### A.6 Reply patterns
- **Reply API** (replyToken, ฟรี, 30 วินาที, ใช้ครั้งเดียว) → ack ทันที
- **Push API** (มีค่าใช้จ่าย, นับ MAU) → ส่งผลเมื่อ OCR เสร็จ
- Pattern: reply "กำลังประมวลผล..." → push ผลเมื่อเสร็จ

### A.7 Edge cases
| Case | Handling |
|------|----------|
| ไฟล์ใหญ่ > 10MB (image) / 300MB (file) | LINE block + เช็คซ้ำฝั่งเรา |
| ส่งหลายไฟล์ติด | Queue ทีละ event, กัน rate limit |
| ยังไม่ link แต่ส่งรูป | reject หรือเก็บ R2 ชั่วคราว 24 ชม. |
| Webhook retry | Idempotency key = `event.webhookEventId` |
| Free tier หมด | Reply พร้อมลิงก์ topup |
| AI error | Reply friendly + คืน credit |
| LINE user ไม่เคย register | Reply ชวนสมัคร + ลิงก์ register |

### A.8 Security checklist
- ✅ Verify signature ทุก request
- ✅ Rate limit per `line_user_id`
- ✅ Sanitize filename
- ✅ Link token: short-lived, single-use, secure random
- ✅ Log line_user_id แยกจาก user_id (PII isolation)
- ✅ ปุ่ม disconnect ใน Settings

### A.9 Component changes
- **Settings**: section "Connect LINE" + ช่องกรอก code + ปุ่ม disconnect
- **Documents**: badge "via LINE" + เพิ่ม column `source` ใน `documents` (`web` | `line` | `api`)
- **Admin**: usage breakdown by source

### A.10 Cost considerations
- Free tier: 200 push msg/เดือน → ถ้าเยอะต้องอัป Light/Standard (~฿1,200+/เดือน)
- **Reply messages ฟรีไม่จำกัด** — ออกแบบให้ใช้ reply เป็นหลัก, push เฉพาะ async จริง

---

## Part B — Downstream Integration (forward OCR result)

### B.1 รูปแบบที่รองรับ
| Pattern | เหมาะกับ |
|---------|----------|
| Webhook (push) | ระบบมี HTTP endpoint รับ — แนะนำเริ่มที่นี่ |
| Queue (pull) | ปลายทางหลัง firewall |
| Direct API / n8n / Make / Zapier | end-user no-code |
| Email / Slack / Discord | end-user ดูเอง |

### B.2 Database schema
```sql
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'webhook' | 'n8n' | 'make' | 'email' | 'slack'
  endpoint TEXT NOT NULL,
  secret TEXT,                          -- HMAC signing secret
  headers_json TEXT,
  trigger_source TEXT,                  -- 'web' | 'line' | 'api' | NULL=all
  trigger_template_id TEXT,
  trigger_min_confidence REAL,
  enabled INTEGER DEFAULT 1,
  last_delivery_at DATETIME,
  last_error TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE integration_deliveries (
  id TEXT PRIMARY KEY,
  integration_id TEXT REFERENCES integrations(id),
  document_id TEXT,
  payload_json TEXT,
  status TEXT NOT NULL,                 -- 'pending' | 'success' | 'failed' | 'dead'
  attempt INTEGER DEFAULT 0,
  http_status INTEGER,
  response_body TEXT,
  next_retry_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);
CREATE INDEX idx_deliveries_pending ON integration_deliveries(status, next_retry_at);
CREATE INDEX idx_deliveries_doc ON integration_deliveries(document_id);
```

### B.3 Webhook payload contract
```json
{
  "event": "document.processed",
  "version": "1",
  "delivery_id": "del_abc123",
  "timestamp": "2026-05-28T10:23:45Z",
  "document": {
    "id": "doc_xyz",
    "source": "line",
    "filename": "invoice_001.pdf",
    "mime_type": "application/pdf",
    "pages": 2,
    "uploaded_at": "..."
  },
  "ocr": {
    "template_id": "tpl_invoice_v2",
    "confidence_overall": 0.92,
    "fields": {
      "invoice_no": { "value": "INV-2026-0042", "confidence": 0.98 },
      "total": { "value": 51651.11, "confidence": 0.95, "currency": "USD" }
    },
    "tables": [],
    "raw_text": "..."
  },
  "user": {
    "id": "usr_001",
    "email": "...",
    "line_user_id": "U..."
  },
  "links": {
    "view": "https://app.../documents/doc_xyz",
    "download_original": "https://app.../api/documents/doc_xyz/file?token=..."
  }
}
```

**Security headers:**
- `X-Signature: sha256=<hmac>` — HMAC raw body ด้วย secret
- `X-Delivery-Id: del_abc123` — idempotency key
- `X-Timestamp: <unix>` — reject ถ้าเก่ากว่า 5 นาที (กัน replay)

### B.4 Retry strategy
```
processed event → INSERT integration_deliveries (status='pending')
  ↓
Cron Trigger ทุก 1 นาที:
  SELECT * WHERE status='pending' AND next_retry_at <= NOW() LIMIT 50
  → POST endpoint, timeout 10s
    2xx → success
    4xx (≠ 429) → dead (ปลายทางผิด, ไม่ retry)
    429 / 5xx / timeout → backoff: 1m, 5m, 15m, 1h, 6h, 24h (max 6)
```

Circuit breaker: `consecutive_failures >= 10` → auto-disable + แจ้ง user

### B.5 Trigger points
จุดที่ enqueue delivery (ทุกจุดที่ OCR เสร็จ):
- `src/app/api/upload/route.ts` — web
- `/api/v1/extract` — API path
- `/api/line/webhook` — LINE

→ Extract util: `enqueueIntegrationDeliveries(doc, user)` ที่ทุกจุดเรียกหลัง OCR commit

### B.6 UI ที่ต้องเพิ่ม
**Settings → Integrations tab**
- List + status (✅ healthy / ⚠️ failing / 🔴 dead)
- Add wizard: kind, endpoint, **Test connection**, trigger rules, secret display (copy ครั้งเดียว)
- Per-integration **Delivery log** (last 100) + replay button
- Sample payload viewer + docs

**Admin**
- Global view + failure rate
- Force disable / blacklist endpoint

### B.7 Preset integrations
- **n8n / Make** — paste webhook URL (static token แทน HMAC)
- **Email** — HTML summary + JSON attach
- **Google Sheets** — Apps Script template
- **Slack / Discord** — summary card
- **Zapier** — partner program (ภายหลัง)

### B.8 Field mapping (Phase 2)
```json
{
  "field_map": {
    "invoice_no": "$.fields.InvoiceNumber",
    "total_amount": "$.fields.GrandTotal"
  }
}
```
JSONPath transform ก่อนส่ง — Phase 1 ส่ง payload เดิม

### B.9 Edge cases
| Case | Handling |
|------|----------|
| Endpoint hang | timeout 10s = failure |
| 200 แต่ body error | ปลายทางต้องคืน non-2xx |
| เปลี่ยน secret ขณะ pending | snapshot secret ตอน enqueue |
| Document ใหญ่ (raw_text > 1MB) | truncate + `truncated: true` + download link |
| PII / sensitive | per-integration toggle "include PII" / "include raw_text" |
| Private IP (SSRF) | block 10.*, 192.168.*, 127.*, 169.254.* |
| Test connection | ส่ง `{event: "test"}` + ตรวจ 2xx |

---

## Part C — Combined Flow

```
LINE user ส่งไฟล์
  → webhook verify + dedup
  → download from LINE Content API
  → OCR pipeline (reuse) → หัก credit
  → save document (source='line')
  → reply LINE: "เสร็จแล้ว ดูที่ [link]"
  ─────────────────────────────────  ← integration hook ตรงนี้
  → enqueueIntegrationDeliveries(doc, user)
  → cron worker pickup → POST webhook to ERP/n8n
  → ERP บันทึก invoice อัตโนมัติ
```

**Key insight:** integration logic ไม่ผูกกับ source — enqueue หลัง OCR เสร็จ → reuse ได้ทุก channel (web, LINE, API)

---

## Part D — Implementation Roadmap

### LINE OA (4 sprints)
- **Sprint A1** — Foundation: channel setup, env, `line_accounts` table, webhook skeleton, Settings UI link form
- **Sprint A2** — Linking: `/link` flow, text commands (`/credit`, `/help`, `/unlink`)
- **Sprint A3** — Document: file download from LINE, OCR pipe, reply text + deeplink, `source` column
- **Sprint A4** — Polish: Flex Message, idempotency, rate limit, admin breakdown, error UX + refund

### Integration (4 sprints)
- **Sprint B1** — Core: tables + migrations, `enqueueIntegrationDeliveries`, HMAC util, cron worker, Settings UI add/list/delete
- **Sprint B2** — UX: test connection, delivery log + replay, trigger rules, circuit breaker, admin
- **Sprint B3** — Presets: n8n, Make, Email, Slack/Discord, Google Sheets
- **Sprint B4** — Advanced: field mapping, bulk replay, metrics dashboard, pull API

### Recommended order
1. **Password hash** (security blocker — ทำก่อน production ทุกอย่าง)
2. **B1 + A1** คู่กัน (foundation ทั้งสองฝั่ง)
3. **A2 + A3** (LINE end-to-end)
4. **B2** (delivery ops)
5. **A4 + B3** (polish + presets)

---

## ประเด็นที่ต้องเคลียร์ในประชุมร่วมทีม

### ฝั่ง LINE OA
- [ ] Channel จะใช้ของบริษัทไหน / ใครเป็น admin LINE Developers
- [ ] รับงบ Light/Standard plan หรือเริ่ม Free tier ก่อน
- [ ] Branding / persona ของ bot (ชื่อ, รูป, greeting)
- [ ] ภาษา reply (ไทย/อังกฤษ/auto-detect จาก profile)
- [ ] User flow: LINE-first sign up ได้ไหม หรือต้อง register web ก่อนเสมอ

### ฝั่ง Integration
- [ ] ปลายทางหลักคือระบบอะไร (ERP เฉพาะ / n8n / generic webhook)
- [ ] ทีมปลายทางเป็นคนรับ payload เอง หรือเราต้อง transform ให้
- [ ] ใครเป็นคนกำหนด field mapping (admin ของเรา / user / ทีมปลายทาง)
- [ ] SLA: real-time (< 5s) / near-real-time (< 1 min) / batch (ทุกชั่วโมง)
- [ ] ต้องการ acknowledge 2-way ไหม (ปลายทางตอบกลับว่ารับเรียบร้อย + ของเราอัปเดต status)
- [ ] Audit / compliance: log retention นานแค่ไหน, ต้อง encryption-at-rest เพิ่มไหม

### Cross-cutting
- [ ] Credit model: LINE upload หัก credit เท่าเว็บ หรือคิดต่างกัน
- [ ] Quota: limit ส่งกี่ไฟล์/วัน per user (ทั้ง LINE และ webhook delivery)
- [ ] Pricing tier: feature นี้อยู่ใน tier ไหน (Free / Pro / Enterprise)
- [ ] SLA failure notification: email / LINE push / dashboard banner
