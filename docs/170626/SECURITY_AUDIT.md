# Security Audit — DOCRoom (ocr-web-service)

วันที่: 2026-06-17 · ขอบเขต: source code review (auth, API authorization, injection, deps)

> ⚠️ พบช่องโหว่ระดับ **CRITICAL 2 จุด** ที่ทำให้ผู้โจมตี **เป็น admin / อ่าน-แก้ข้อมูลผู้ใช้คนอื่นได้ทั้งหมด**
> ควรแก้ก่อน deploy รอบถัดไป

---

## สรุประดับความรุนแรง

| # | ช่องโหว่ | ระดับ |
|---|---|---|
| 1 | Session token ปลอมได้ (ไม่มีลายเซ็น) → ปลอมเป็น admin / ผู้ใช้คนใดก็ได้ | 🔴 CRITICAL |
| 2 | Broken Access Control / IDOR — API รับ `userId` จาก client ไม่เช็ค session | 🔴 CRITICAL |
| 3 | Credit / feature bypass ผ่าน `userId`/`plan` ที่ client ส่งมา | 🟠 HIGH |
| 4 | Dependency vulnerabilities (npm) 20 รายการ (12 high) | 🟡 MEDIUM |
| 5 | Hardcoded dev credentials + seed รหัส plaintext | 🔵 LOW/INFO |

**จุดที่ทำได้ดีอยู่แล้ว (ไม่พบปัญหา):** SQL ใช้ prepared statement + `bind()` ทุกที่ (กัน SQLi),
Stripe webhook ตรวจ signature, รหัสผ่าน hash ด้วย PBKDF2, cookie เป็น httpOnly

---

## 🔴 #1 — Session token ปลอมได้ (Auth bypass + Privilege escalation)

**ไฟล์:** `src/app/api/auth/route.ts:12-26` และ `getSessionUser` ใน `src/app/api/admin/*/route.ts`

token คือ **base64 ของ JSON เปล่า ๆ ไม่มีลายเซ็น/เข้ารหัส**:
```ts
// auth/route.ts:12
function makeToken(user) {
  return btoa(encodeURIComponent(JSON.stringify({ ...user, ts: Date.now() })));
}
// admin/users/route.ts:9 — ตรวจสิทธิ์จาก token นี้ตรง ๆ
const caller = getSessionUser(req);            // base64 decode เฉย ๆ
if (caller?.role !== "admin") return UNAUTHORIZED;
```

**ผลกระทบ:** ใครก็ตามสร้าง cookie `session` เองได้ เช่นใส่ payload `{"id":"x","role":"admin"}`
แล้ว base64 → ผ่านด่าน admin ทุกอัน = **เข้าถึง admin tooling ทั้งหมด** (จัดการ users, ปรับ tier,
ดู AI usage, แก้ระบบ) และ **ปลอมเป็นผู้ใช้คนใดก็ได้** นอกจากนี้ 7-day expiry ก็เลี่ยงได้
(ผู้โจมตีตั้ง `ts` เอง)

**วิธีแก้:**
- เซ็น token ด้วย **HMAC-SHA256** (Web Crypto) ด้วย secret ใน env (`SESSION_SECRET`) แล้ว
  **ตรวจลายเซ็นทุกครั้ง** ใน `parseToken` / `getSessionUser` — หรือใช้ JWT ที่เซ็นจริง / encrypted session
- ปฏิเสธ token ที่ลายเซ็นไม่ตรง
- เก็บ `getSessionUser` เป็น helper กลางตัวเดียว (ตอนนี้ก๊อปกระจายในหลายไฟล์) เพื่อกันหลุด

---

## 🔴 #2 — Broken Access Control / IDOR (อ่าน-แก้ข้อมูลคนอื่นได้)

**ไม่มี `middleware.ts`** (ไม่มีด่านกลาง) และ **route ฝั่งผู้ใช้ทุกตัวรับ `userId` จาก query/body
โดยไม่เทียบกับ session เลย**

ตัวอย่างชัดสุด — `src/app/api/documents/route.ts:7-18`:
```ts
const userId = searchParams.get("userId");     // มาจาก client ตรง ๆ
// ...ไม่มีการเช็ค session/สิทธิ์...
SELECT ... FROM documents WHERE user_id = ?    // คืนเอกสารของ userId นั้น
```

เรียก `GET /api/documents?userId=<ใครก็ได้>` → ได้เอกสาร + ข้อมูลที่สกัด (`raw_json`:
ชื่อบริษัท เลขภาษี ยอดเงิน ฯลฯ) ของผู้ใช้คนนั้น **โดยไม่ต้อง login ด้วยซ้ำ**

route ที่มีรูปแบบเดียวกัน (รับ userId/id จาก client, ไม่เช็ค session):
| Endpoint | ผลกระทบ |
|---|---|
| `GET /api/documents?userId=` | อ่านเอกสาร+ข้อมูลสกัดของคนอื่น |
| `GET /api/status?id=` (`status/route.ts`) | อ่าน `raw_json` ของเอกสารใด ๆ ด้วย doc id |
| `GET /api/stats?userId=&plan=` | ดูสถิติ/เครดิตคนอื่น + ปลอม plan |
| `GET/POST/DELETE /api/templates?userId=` | อ่าน/ลบ template คนอื่น |
| `GET/PATCH /api/user-prefs?userId=` | อ่าน/แก้ค่าตั้งคนอื่น |
| `GET /api/notifications?userId=` | อ่านการแจ้งเตือนคนอื่น |
| `POST /api/feedback` (userId) | ปลอม feedback ในนามคนอื่น |
| `POST /api/upload` (userId ใน formData) | ผูกเอกสาร/หักเครดิตในนามคนอื่น |
| `POST /api/compare` (userId) | เช่นเดียวกัน |

**วิธีแก้:**
- **ดึง userId จาก session ที่ตรวจลายเซ็นแล้วเท่านั้น** — เลิกเชื่อ `userId` ที่ client ส่ง
- ทุก route: ถ้าทรัพยากรไม่ใช่ของ session user (และไม่ใช่ admin) → 403
- เพิ่ม `middleware.ts` หรือ auth helper กลางที่ทุก route เรียกก่อนทำงาน
- `GET /api/status` ต้องผูก doc กับเจ้าของแล้วเช็คสิทธิ์

---

## 🟠 #3 — Credit / Feature bypass

- `src/app/api/upload/route.ts:18` — `userId = data.get("userId") || "guest"` มาจาก client →
  ต่อเนื่องจาก #2 ผู้โจมตีเลือกได้ว่าจะหักเครดิตใคร / ทำในนามใคร
- `src/app/api/stats/route.ts` — รับ `plan` จาก query → ใช้คำนวณ feature/credit ฝั่งแสดงผลได้เพี้ยน
- การตัดสิน feature/credit ควรอ้างอิง **plan จาก DB ของ session user** ไม่ใช่ค่าจาก client

---

## 🟡 #4 — Dependency vulnerabilities

`npm audit`: **20 รายการ (2 low, 6 moderate, 12 high)** เช่น Picomatch ReDoS
- รัน `npm audit` ดูรายการเต็ม + `npm audit fix` เท่าที่ไม่ breaking
- ตัวที่ต้อง major bump ให้ประเมินทีละตัว (อย่าใช้ `--force` มั่ว)

---

## 🔵 #5 — Hardcoded creds / dev seed

- `src/lib/devUsers.ts` — บัญชี dev (รวม `admin@ocrpro.com/admin1234`) hardcoded; ใช้เป็น fallback
  **เฉพาะตอน DB ใช้ไม่ได้** (`auth/route.ts:83-87`) — ความเสี่ยง: ถ้า DB ล่ม ใครรู้ creds นี้ล็อกอินได้
  → พิจารณาปิด fallback นี้ใน production หรือทำให้ปลอดภัยขึ้น
- `db/seed.local.sql` (ผมเพิ่มเพื่อทดสอบ local) — รหัส **plaintext** → **local เท่านั้น ห้ามรันกับ prod**

---

## ลำดับการแก้ที่แนะนำ
1. **#1 เซ็น session token** (ฐานของทุกอย่าง — แก้แล้ว #2/#3 ค่อยอ้าง session ได้)
2. **#2 บังคับ authz ทุก route** จาก session + เพิ่ม middleware/helper กลาง
3. **#3** ใช้ plan/userId จาก DB ของ session user
4. **#4** จัดการ deps
5. **#5** review fallback + ไม่เอา seed plaintext ขึ้น prod

> หมายเหตุ: #1 และ #2 เกี่ยวพันกัน — แก้ #1 ก่อนแล้ว #2 จะมี session ที่เชื่อถือได้ให้ยึด
