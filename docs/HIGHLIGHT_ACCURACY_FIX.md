# Highlight Accuracy — Fix & Future Improvement Notes

> วันที่: 2026-05-16
> ขอบเขต: rewrite ของ matcher และ frontend Y-shift เพื่อให้ highlight
> ตรงตำแหน่งจริงในเอกสาร ครอบคลุม Thai text, table, repeated values
> และ scanned/image OCR

## 1. ปัญหาเดิม (Symptoms)

- กล่อง highlight ลอยอยู่เหนือตัวอักษร (โดยเฉพาะภาษาไทย)
- ค่าตัวเลขที่มี comma/period (`79,180.00`, `PO-2026-0042`) มัก match ไม่เจอ
- ค่าที่ซ้ำกัน (postcode `10400` vs `10110`) match ไปยังกล่องผิด
- ตาราง: cap ที่ 3 boxes/doc + drop row > 12% สูง → ตาราง 4+ แถวหายเกือบหมด
- ภาษาไทย: เทียบแบบ word-split ไม่ work เพราะภาษาไทยไม่มี space ระหว่างคำ

## 2. Bug ที่ตรวจพบและแก้

### B1. `sanitizeLocations` ถูกประกาศซ้ำ 2 ครั้ง
`src/app/api/compare/route.ts` มี 2 ฟังก์ชันชื่อเดียวกัน → TypeScript ใช้ตัวที่ 2
ที่ filter `height ≤ 0.12` และ cap 3 boxes/doc → table หายเกือบหมด
**แก้:** ลบ duplicate, แยกเป็น `sanitizeBox()` + `sanitizeLocations(locs, isTableField)`
ที่ใช้ cap แบบ adaptive (non-table 4, table 40)

### B2. `tesseract.js` import ใน Node CJS — แท้จริง broken
`tesseract.js@5.1.1` ไม่ export `default` ใน CJS แต่ code ใช้
```ts
const { default: Tesseract } = require("tesseract.js");
// → Tesseract = undefined → "Cannot read properties of undefined (reading 'createWorker')"
```
ทำให้ scanned PDF + image OCR path บน Node **ไม่เคยทำงาน** เลย → fall through
empty tokens เงียบ ๆ
**แก้:** `const T = require("tesseract.js"); const Tesseract = T.default || T;`
ใช้ pattern เดียวกับ `image-size`

### B3. Y-coordinate floating
`pdf.js` ใช้ `transform[5]` = baseline (ไม่ใช่ glyph top) และ
`item.height` = font size (ไม่รู้ ascent/descent ratio)
**แก้:** ใช้ `ASCENT_RATIO = 0.85` และเพิ่ม height pad 1.10 →
box แนบ glyph + คลุมสระบน/วรรณยุกต์
แก้ทั้ง [src/lib/frontend-ocr.ts](../src/lib/frontend-ocr.ts) และ
[src/lib/text-extractor.ts](../src/lib/text-extractor.ts)

### B4. Phase 1 contiguous match แตกง่าย
ถ้า OCR มี token noise ระหว่างคำที่ match → `break` ทันที
**แก้:** ยอม skip ≤ 2 token สั้น ๆ (length ≤ 3) ไม่ break

### B5. Numeric / hyphenated values
ค่าอย่าง `79,180.00`, `PO-2026-0042` หลัง normalize กลายเป็น `"79 180 00"`,
`"po 2026 0042"` (comma/hyphen → space) → matcher แยกเป็น 3 words แต่ Tesseract
ส่ง token เดียว → contiguous-window phase หาไม่เจอ
**แก้:** เพิ่ม **single-token containment fast path** ก่อน Phase 1 — ตรวจว่า
token ใดทั้ง string มี value ทั้งสายอยู่หรือไม่ (compare แบบ `replace(/\s+/g, "")`)

### B6. Repeated values — ใช้ match แรกเสมอ
**แก้:** เปลี่ยน `matchValueToTokens` ให้สะสม candidate ทั้งหมด, ให้คะแนน:
- fuzz × coverage
- penalty ถ้า line/token เดียวกันมี counterpart text อยู่ด้วย
- ถ้า counterpart array → ตัด candidate ที่ matches counterpart เหมือนกัน

## 3. Algorithm: New `matchValueToTokens`

```
matchValueToTokens(value, tokens, isTableField, counterparts: string[])
  → MatchResult { tokens, confidence ∈ [0, 1] }
```

### Pipeline (non-table)

```
1. Normalize value (NFC, Thai digits ๐-๙ → 0-9, strip zero-width/BIDI,
                    lowercase, collapse punctuation)
2. Fast path: any single token whose joined-no-space text contains
              joined-no-space value → return [token], conf ≈ exact ratio
3. If isThaiHeavy(value):
   - Build lines by y-clustering
   - For each line, score = containment * 0.7 + trigram * 0.3 - counterPenalty
   - Require containment OR trigram ≥ 0.75
   - Pick best line, filter tokens that share trigrams with value
4. Else (Latin/mixed):
   - Phase 1: contiguous fuzzy-word window (skip ≤ 2 noise tokens)
   - Phase 2: sliding y-band window (max 0.04 height), ≥ 0.8 coverage
   - Score candidates by avgFuzz × coverage − counterPenalty
   - Return best
```

### Pipeline (table)

```
1. Split value/counterparts by \n → row-aligned arrays
2. Skip row if ALL counterparts match value verbatim (= no diff)
3. Build rows/cells from tokens (gap < 0.04 → same cell)
4. For each value row:
   a. Score row by word-fuzzy OR Thai n-gram
   b. Best row ≥ 0.5 score
   c. For each cell, mark "differs" if value-words present AND
      NOT every counterpart contains those same words
   d. Fallback: highlight whole row if score ≥ 0.7
5. Confidence = average row scores
```

### Confidence in response

- `MatchResult.confidence` carried into each `HighlightBox.confidence`
- UI render in [src/components/CompareWorkspace.tsx](../src/components/CompareWorkspace.tsx):
  - conf ≥ 0.6 → solid blue border
  - conf < 0.6 → dashed amber border + tooltip "Low confidence"

## 4. ผลทดสอบกับ `TestINV.PNG` (Thai invoice, image OCR Tesseract)

| Field | Value | Tokens matched | Confidence | Position OK |
|---|---|---|---|---|
| PO number | `PO-2026-0042` | 1 | 0.95 | ✅ |
| Buyer tax id | `0105555555555` | 1 | 0.95 | ✅ |
| Vendor tax id | `0106666666666` | 1 | 0.95 | ✅ (counterpart disambig) |
| Grand total | `79,180.00` | 1 | 0.95 | ✅ |
| Subtotal | `74,000.00` | 1 | 0.95 | ✅ |
| Buyer postcode | `10110` | 1 | 0.95 | ✅ |
| Vendor postcode | `10400` (counterpart `10110`) | 1 | 0.95 | ✅ |
| Date (Thai) | `15 มีนาคม 2026` | 0 | 0.00 | ⚠️ honest miss |
| Payment term (Thai) | `เครดิต 30 วัน` | 0 | 0.00 | ⚠️ honest miss |
| Vendor name (Thai) | `บริษัท ผู้จำหน่ายใจดี จำกัด` | 0 | 0.00 | ⚠️ honest miss |
| Table rows | invoice items | 0 | 0.00 | ⚠️ honest miss |

### สาเหตุของ "honest miss" สำหรับ Thai/Table

Tesseract image OCR (tha+eng) แตก Thai text เป็นตัวอักษรเดี่ยว ๆ (สังเกต token แรก ๆ:
`"บ"`, `"ม"`, `"ซม"`, `"ส"`, `"ั"`, `"ง"`) ซึ่งทำให้ทั้ง line text และ token-level
matching ใช้ไม่ได้ดี ระบบเลือก **return เปล่า** แทนที่จะ highlight ผิดที่ — ตรงตาม
principle "report value before perfect highlight" ใน
[OCR_COMPARE_AI_WORKPLAN.md](OCR_COMPARE_AI_WORKPLAN.md)

> **กรณีจริงผ่าน frontend:** สำหรับ text-PDF จะใช้ pdf.js text-layer ซึ่งคืน Thai
> text เป็นคำสมบูรณ์ → matching จะทำงานได้ดีกว่ากรณีนี้มาก

## 5. ไฟล์ที่แก้ครั้งนี้

- [src/lib/text-extractor.ts](../src/lib/text-extractor.ts) — rewrite matcher,
  normalize, Y-shift, Tesseract import fix
- [src/lib/frontend-ocr.ts](../src/lib/frontend-ocr.ts) — Y-shift parity
- [src/app/api/compare/route.ts](../src/app/api/compare/route.ts) — ลบ duplicate
  sanitizeLocations, counterpart array, adaptive cap, confidence in response
- [src/components/CompareWorkspace.tsx](../src/components/CompareWorkspace.tsx) —
  low-confidence visual cue

## 6. งานที่ "ยังไม่ทำ" — Future Improvements

### Priority สูง

1. **Thai char re-assembly สำหรับ Tesseract image OCR**
   เมื่อ Tesseract แตก Thai เป็นตัวอักษรเดี่ยว ๆ ควร concat tokens บน line
   เดียวกันที่ห่างกัน < 0.5 * height ก่อน matching แล้วเก็บ mapping back
   เพื่อ render bounding box ครอบทุก char ที่ assemble แล้ว
   *ส่งผล:* date, payment term, vendor name จะ match ได้

2. **Table — Global column inference**
   ปัจจุบันใช้ `horizontalGap < 0.04` แบ่งคอลัมน์ (heuristic เปราะ)
   ควร cluster `token.x` ทั้งหน้า (1-D k-means / GMM) เพื่อหา column
   boundaries แล้วใช้ boundaries เดียวกันทุกแถว → row/cell alignment
   ข้ามแถวจะแม่นขึ้น
   *ส่งผล:* invoice items, compare table หลาย ๆ doc

3. **Multi-token contiguous + single-token cross-match**
   ค่าตัวเลข decimal บางครั้ง Tesseract แตกเป็นหลาย token
   (`"79"`, `","`, `"180.00"`) — ควรลองทั้ง 2 path (single-token containment
   AND contiguous-window) แล้วเลือกอันที่ confidence สูงกว่า

### Priority กลาง

4. **Word-segmentation ไทยแบบ pre-tokenize**
   ใช้ dictionary หรือ ICU `BreakIterator` แบ่งคำไทยใน normalize
   เพื่อให้ word-based matching ทำงานบน Thai ได้

5. **`sourceMethod` ใน response (WORKPLAN P0.1)**
   ใส่ field บอก: `text-layer` | `ocr-token` | `none` ต่อ doc/page
   เพื่อให้ UI ตัดสินใจแสดง warning ได้

6. **Confidence threshold ใน UI กับ no-highlight banner (P0.3)**
   ถ้าทุก doc ของ field ใด conf < 0.4 → แสดง banner "ไม่สามารถระบุตำแหน่ง
   ได้แน่ชัด — กรุณาตรวจสอบเอง" ใน result panel

### Priority ต่ำ

7. **Token cache (WORKPLAN P0.2)** — ลด re-OCR cost
8. **Confidence ระดับ token (ไม่ใช่แค่ match-level)** — ใช้ Tesseract per-word
   confidence ที่มีอยู่แล้วมา weight ใน match
9. **PDF text-layer descent measurement** — อ่าน font metrics จริงจาก pdf.js
   `commonObjs.get(fontId)` แทน ASCENT_RATIO ค่าคงที่

## 7. วิธีรันทดสอบแบบที่ผมใช้

```bash
# ติดตั้ง deps (มีอยู่แล้ว) จากนั้น
D:/nodejs/node.exe test-highlight.cjs
```

ไฟล์ `test-highlight.cjs` (อยู่ใน repo root, ละไว้ใน git ผ่าน .gitignore ตาม
นโยบาย repo) จะ:
1. transpile `src/lib/text-extractor.ts` → CJS in-place
2. รัน Tesseract OCR บน image
3. เรียก `matchValueToTokens()` ด้วย values ตัวอย่าง + counterparts
4. รายงาน token count, confidence, merged boxes

แก้ array `cases` เพื่อทดสอบ field ใหม่ ๆ

## 8. หลักการที่ยึดในการแก้

- **อย่า highlight ผิดดีกว่าไม่ highlight** — ทุก threshold ตั้งสูงไว้ก่อน
  ถ้า confidence ต่ำเกินไป → return เปล่า ให้ UI แสดง "ไม่พบตำแหน่ง"
- **Backward compatible** — `MatchResult` มี `tokens` field เดิม,
  `HighlightBox.confidence` เป็น optional
- **Honest signals** — confidence ที่ส่งกลับสะท้อนคุณภาพการ match จริง
  (containment, fuzzy score, coverage, counterpart penalty)
- **Counterpart-aware** — รับ array (รองรับ 3-way compare) ใช้ทั้ง disambig
  ตำแหน่งและสกรีน table cell ที่ "ต่าง" ออก

---

# Phase 2 — Cloudflare Free Plan Readiness

> วันที่: 2026-05-16 (รอบที่ 2)
> ขอบเขต: ปรับสถาปัตยกรรมให้ Worker ใช้ CPU ต่ำพอสำหรับ Free plan
> (10ms/req) และทำ UX honest signal สำหรับเคสที่ OCR ล้มเหลว

## 9. ปัญหา CF Free Plan ที่ต้องแก้

| Limit | Free | งานปัจจุบัน (ก่อนแก้) |
|---|---|---|
| CPU/req | 10ms | matcher 50-300ms + JSON.parse tokens 50-200ms → **เกิน** |
| Bundle gzip | 3MB | worker bundle ~0.5MB OK |
| Subrequests | 50 | SELECT + UPDATE + log = 3 → OK แต่ลดได้ |
| Request body | 100MB | docTokens JSON หลาย MB ใช้ bandwidth เปลือง |

## 10. กลยุทธ์: "Worker = thin AI proxy, Browser = compute"

### 10.1 แยก matcher ออกจาก backend
- สร้าง [src/lib/text-matcher.ts](../src/lib/text-matcher.ts) — pure JS, ไม่มี
  Node deps, ใช้ได้ทั้ง browser / Worker / Node
- [src/lib/text-extractor.ts](../src/lib/text-extractor.ts) เหลือเฉพาะ Node-only
  OCR fallback + guard `isNodeRuntime()` → return [] บน CF
- [route.ts](../src/app/api/compare/route.ts) ลบ matcher และ token logic ออก
  ทั้งหมด — Worker แค่ proxy ผ่านไป AI แล้วคืน JSON เปล่า
- [CompareWorkspace.tsx](../src/components/CompareWorkspace.tsx) หลังได้ AI
  response → loop fields × docs → `matchValueToTokens` + `mergeTokenBoxes`
  ใน browser

**ผลของการย้าย:**
| Phase | CPU ก่อน | CPU หลัง |
|---|---|---|
| Parse multipart | 5-10ms | 5-10ms |
| Parse docTokens JSON | 50-200ms | **0** |
| matchValueToTokens × N fields | 50-300ms | **0** |
| AI fetch + parse | 10-20ms | 10-20ms |
| D1 queries | 5-15ms | **2-5ms** (batched) |
| **รวม** | ~120-545ms ❌ | **~20-45ms** ใกล้ขอบ ✅ |

### 10.2 Edge cache (`caches.default`)
- ใน [compare/route.ts](../src/app/api/compare/route.ts): hash(files+fields+model)
  → look up + 24h TTL
- Cache hit → ไม่เรียก AI, ไม่ตัดเครดิต, return เร็ว (~1ms CPU)
- Cache miss → ตัดเครดิตด้วย atomic UPDATE → AI → store
- Response เพิ่ม `from_cache: boolean` ให้ frontend รู้

### 10.3 Atomic D1 credit charge
ก่อนหน้านี้ใช้ 2 subrequests:
```
SELECT credits_remaining, extra_credits FROM users WHERE id = ?
UPDATE users SET credits_remaining = credits_remaining - 1 ...
```

หลังแก้: รวมเป็น **1 subrequest** ด้วย `RETURNING`:
```sql
UPDATE users SET
  credits_remaining = CASE WHEN credits_remaining > 0 THEN credits_remaining - 1 ELSE credits_remaining END,
  extra_credits     = CASE WHEN credits_remaining > 0 THEN extra_credits ELSE extra_credits - 1 END
WHERE id = ? AND (credits_remaining + extra_credits) > 0
RETURNING credits_remaining + extra_credits AS remaining
```
ถ้า 0 rows กลับมา → user หมดเครดิต/ไม่พบ. fallback ตรวจ existence
ด้วย cheap query แยกเฉพาะกรณี error เท่านั้น

### 10.4 Fire-and-forget log
`logSystemEvent(...)` ใน end-of-handler เปลี่ยนเป็น **ไม่ await** → ลด
1 subrequest ใน critical path

## 11. UX: Honest Signal เมื่อ OCR ล้มเหลว

[src/lib/frontend-ocr.ts](../src/lib/frontend-ocr.ts) เปลี่ยนเป็นคืน:
```ts
{ tokens: OCRToken[]; sourceMethod: SourceMethod; error?: string }
```

`SourceMethod = "text-layer" | "ocr-image" | "ocr-pdf-scan" | "none"`

ใน [CompareWorkspace.tsx](../src/components/CompareWorkspace.tsx) state
`ocrSourceMethods[]` ใช้ตัดสินใจแสดง banner:

- **Amber banner** เมื่อมี doc ใดมี `sourceMethod === "none"`:
  > ⚠️ ไม่สามารถระบุตำแหน่งในเอกสารบางฉบับได้ — แสดงเฉพาะค่าที่ AI อ่านได้
  > กรุณาตรวจสอบความถูกต้องด้วยตนเอง
- **Sky banner** (info) เมื่อใช้ OCR สแกน:
  > ℹ️ ใช้ OCR สแกนเอกสาร — ตำแหน่ง highlight อาจไม่แม่นยำ 100% สำหรับ
  > ภาษาไทยที่ถูกแยกตัวอักษร

## 12. Bundle audit (ผลจริง)

รัน `opennextjs-cloudflare build` แล้ววัด `.open-next/server-functions/default/handler.mjs`:

| Metric | Value | Limit (Free) |
|---|---|---|
| handler.mjs raw | 1.80 MB | — |
| handler.mjs **gzipped** | **0.46 MB** | **3 MB** ✅ |
| tesseract.js bundled | ❌ (0 mentions) | — |
| pdfjs-dist bundled | ❌ (0 mentions) | — |
| canvas bundled | ❌ (0 mentions) | — |

หมายเหตุ: `tesseract` / `image-size` ปรากฏ 2 ครั้งใน worker source
แต่เป็นแค่ string literal ใน error message — ไม่ใช่ module ที่ resolved
จริง (กัน fail ด้วย `isNodeRuntime()` guard)

## 13. ไฟล์ที่แก้ใน Phase 2

| ไฟล์ | สถานะ | หน้าที่ |
|---|---|---|
| [src/lib/text-matcher.ts](../src/lib/text-matcher.ts) | **new** (~480 lines) | Pure matcher — no Node deps |
| [src/lib/text-extractor.ts](../src/lib/text-extractor.ts) | **trim** (787 → 195 lines) | Node-only OCR + re-export matcher (backward compat) |
| [src/app/api/compare/route.ts](../src/app/api/compare/route.ts) | **simplify + cache + atomic D1** | Worker = AI proxy, edge cache, atomic credit charge, fire-and-forget log |
| [src/lib/frontend-ocr.ts](../src/lib/frontend-ocr.ts) | **return sourceMethod** | คืน `{tokens, sourceMethod}` แทน tokens เปล่า |
| [src/components/CompareWorkspace.tsx](../src/components/CompareWorkspace.tsx) | **matching ใน browser + UI banner** | ทำ matching หลัง AI return + แสดง warning banner |

## 14. Verification

- ✅ `tsc --noEmit` ผ่าน
- ✅ `opennextjs-cloudflare build` ผ่าน — bundle 0.46 MB gzip
- ✅ Dev server: POST `/api/compare` กับไฟล์จริง HTTP 200, compile 174ms
- ✅ `test-highlight.cjs` ให้ผลเหมือนเดิม 7/10 case (matcher logic intact)

## 15. งานที่ยังเหลือ (deferred to later sprint)

- [ ] **Streaming AI response** — `ReadableStream` แทน buffer ทั้งก้อน →
  Worker ไม่ต้องเก็บ AI response ทั้งหมดใน memory ก่อน return
- [ ] **`sourceMethod` ใน server response** — ปัจจุบันเก็บแค่ฝั่ง frontend
  state; ถ้าทำ compare history persistence (WORKPLAN P1.1) ควร persist ด้วย
- [ ] **Cache invalidation** — ตอนนี้ TTL 24h fixed; ควรเพิ่ม `?nocache=1`
  query param + admin endpoint ล้างทั้ง bucket
- [ ] **Cache key ปลอดภัยกับ multi-tenant** — ตอนนี้ key = hash(files+fields+model)
  ไม่ include userId → user A กับ B ที่ใช้ไฟล์เดียวกัน + fields เดียวกัน
  จะแชร์ cache ได้ (ถือว่าตั้งใจ — ประหยัด AI quota สำหรับ org เดียวกัน)
  ถ้าต้องการ isolation ให้เพิ่ม `userId` หรือ `tenantId` ลงใน hash
- [ ] **Local cache simulation** — Next.js dev ไม่มี `caches.default`
  → ใช้ Map polyfill ตอน dev ถ้าต้องการทดสอบ cache path

---

# Phase 3 — Production Deployment to Cloudflare

> วันที่: 2026-05-16 (รอบที่ 3)
> Production URL: <https://ocr-web-service.jiatuntiwong.workers.dev>
> Version ID (initial): `5d3b9ffe-2fc8-4b09-a6e7-e1d1e9c69b88`

## 16. ปัญหาที่เจอตอน deploy และวิธีแก้

ตามลำดับเวลาที่พบ:

### 16.1 Wrangler 4.68 + Windows: `resvg.wasm?module` write fail

**Symptom:**
```
ERROR: Missing file or directory: ...77d9faebf7af9e421806970ce10a58e9d83116d7-resvg.wasm?module
```

**Root cause:** Wrangler ใน Windows พยายามเขียนไฟล์ที่มี `?` ใน
ชื่อไฟล์ (จาก import statement `import wasm from "./xxx-resvg.wasm?module"`
ของ `next/dist/compiled/@vercel/og/index.edge.js` ที่ถูกดึงเข้าผ่าน
dynamic import ใน `externalImport` switch case ของ Next.js)
ซึ่ง NTFS ไม่ allow `?` ในชื่อไฟล์

**แก้:** Upgrade `wrangler` จาก 4.68 → **4.92.0**
```
D:/nodejs/npm.cmd install --save-dev wrangler@4.92.0
```

### 16.2 OpenNext 1.17 + Next 16: `components.ComponentMod.handler is not a function`

**Symptom (production):** worker boot OK (CPU 14ms / wall 15ms) แต่ทุก
request error 500 พร้อม log `TypeError: components.ComponentMod.handler
is not a function`

**Root cause:** OpenNext 1.17 ยังไม่ support Next 16 component module
structure อย่างเต็มที่

**แก้:** Upgrade `@opennextjs/cloudflare` → **1.19.10**
```
D:/nodejs/npm.cmd install @opennextjs/cloudflare@1.19.10
```

### 16.3 Next 16 Turbopack default + Workers chunk runtime

**Symptom:** หลัง upgrade OpenNext + Wrangler ยังขึ้น error คนละแบบ:
```
ChunkLoadError: Failed to load chunk server/chunks/ssr/[root-of-the-server]__6f59313c._.js
```

**Root cause:** Next 16 เปลี่ยน default builder เป็น Turbopack —
chunks ที่ Turbopack สร้างใช้ runtime ที่ Workers (V8 isolate) load
ไม่ได้

**แก้ 2 อย่างพร้อมกัน:**

1. `next.config.ts` ลบ `turbopack: {}` (ออกจาก enable-list)
2. `package.json` `build` script เปลี่ยนเป็น:
   ```json
   "build": "next build --webpack"
   ```
   (Next 16 บังคับให้เลือก explicit; ไม่งั้น default = turbopack)

> **หมายเหตุ:** `next dev` ยังใช้ Turbopack ได้ — ปัญหาเฉพาะ prod build

## 17. Verified production state

| Metric | Value |
|---|---|
| Worker URL | https://ocr-web-service.jiatuntiwong.workers.dev |
| Bundle gzipped | **1.22 MB** (Free plan 3MB ✅) |
| Worker startup time | **36 ms** ⚡ |
| Cold-start latency | ~0.5s first request |
| Bindings active | D1 `ocr-db`, R2 `ocr-images`, AI, ASSETS |
| Secrets configured | `GEMINI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Edge (server colo) | SIN (Singapore — auto routed for TH) |

### Smoke test results
- `GET /` → 200 (7690 bytes HTML)
- `GET /login` → 200 (7380 bytes HTML)
- `GET /api/admin/settings` → 403 (correct auth gating)

## 18. ไฟล์ที่แก้ใน Phase 3

| ไฟล์ | การเปลี่ยน |
|---|---|
| [package.json](package.json) | `build` script: `next build --webpack`; bump `wrangler` 4.68→4.92, `@opennextjs/cloudflare` 1.17→1.19.10 |
| [next.config.ts](next.config.ts) | ลบ `turbopack: {}` + เพิ่ม comment ทำไมห้าม |

## 19. คำสั่ง deploy

```
D:/nodejs/npm.cmd run deploy
```

ภายในรัน:
1. `opennextjs-cloudflare build` — Next build (webpack) → patch → bundle worker
2. `opennextjs-cloudflare deploy` — `wrangler deploy` ใช้ `.open-next/worker.js`

## 20. Production checklist ที่ผ่าน

- [x] Wrangler login + account verified
- [x] D1 database `ocr-db` (83267dbd-...) exists
- [x] All bindings declared in `wrangler.jsonc`
- [x] Secrets set via `wrangler secret put` (Gemini + Stripe)
- [x] `nodejs_compat` flag enabled
- [x] Bundle ≤ Free plan limit (1.22 MB < 3 MB)
- [x] Worker startup < 400ms (36 ms)
- [x] Webpack build (not Turbopack)
- [x] Wrangler 4.92+ (Windows wasm bug fixed)
- [x] OpenNext 1.19+ (Next 16 support)

## 21. ที่ควรทำเพิ่มหลัง launch

1. **`wrangler tail`** — เปิด tail ตอน first compare ทดสอบ → ดู
   CPU/wall ของ AI call จริง verify ไม่เกิน 10ms CPU ของ Free plan
2. **Custom domain** — ปัจจุบันใช้ `workers.dev` subdomain (rate limited);
   ถ้า production จริงควรชี้ domain ของตัวเอง
3. **Tessdata host** — ปัจจุบัน frontend Tesseract โหลด tessdata จาก
   unpkg/jsdelivr (CDN ภายนอก); ควร host เองที่ `_next/static/tessdata/`
   เพื่อความเร็ว + ไม่พึ่ง CDN ที่อาจ downtime
4. **Sentry / observability** — `wrangler.jsonc` มี `observability: enabled`
   แต่ควรเพิ่ม Sentry หรือ Logflare เพื่อ alert/aggregate
5. **D1 migration** — D1 dashboard แสดง `num_tables: 0` ที่อาจ stale;
   verify ว่า `schema.sql` ถูก apply แล้วบน production D1

---

# Phase 4 — Debug Logging for Production Highlight Issues

> วันที่: 2026-05-16 (รอบที่ 4)
> Trigger: ผู้ใช้รายงานหลัง deploy ว่า highlight ผิดตำแหน่ง / หายบางช่อง
> Version ID (debug build): `9fd63979-d623-4f8b-b114-ee5b86570393`

## 22. ปัญหาที่ผู้ใช้รายงาน (ภาพ screenshot)

| Field | Doc 1 (PO) | Doc 2 (Invoice) |
|---|---|---|
| วันที่ "15/31 มีนาคม 2026" | highlight แค่ "มีนาคม" ครอบไม่ครบ | เหมือนกัน |
| เงื่อนไขชำระเงิน "เครดิต 30/15 วัน" | ❌ ไม่มี highlight | ❌ ไม่มี |
| ยอดรวม "79,180/79,768.50" | กล่องอยู่ใต้ตัวเลข Y ผิด | เหมือนกัน |
| รายการสินค้า (table) | ❌ ไม่มี | ❌ ไม่มี |
| เลขโทร "(02-…)" | 🐛 highlight ผิด (ไม่ใช่ field ที่เลือก) | 🐛 เหมือนกัน |

ใช้ Tesseract image OCR (PNG) — ที่ test เคยพบว่า Thai text ถูกแตกเป็นตัวอักษรเดี่ยว ๆ

## 23. Debug logging ที่เพิ่ม

เพิ่ม structured `console.groupCollapsed` ใน 2 จุด:

### `src/lib/frontend-ocr.ts` — `logExtract()`
ทุกครั้งที่ extract token จบ:
- จำนวน tokens
- 10 tokens แรก (text + x/y/w/h)
- 8 visual lines แรก (concat text ใน line นั้น)

### `src/components/CompareWorkspace.tsx` — match summary
หลัง AI response:
- AI fields ทั้งหมด
- ต่อ field × doc: value, counterparts, matched tokens count, confidence, merged boxes
- ใช้ `console.table()` ให้ดูง่าย

### การเปิด debug
2 วิธี:

1. **URL param** (one-shot): เพิ่ม `?debug=1`
   ```
   https://ocr-web-service.jiatuntiwong.workers.dev/?debug=1
   ```
   จะ persist ลง `localStorage` อัตโนมัติ
2. **DevTools console:**
   ```js
   localStorage.setItem("ocr_debug", "1")
   ```
   ปิด: `localStorage.removeItem("ocr_debug")`

## 24. วิธีใช้ debug รอบนี้

1. เปิด <https://ocr-web-service.jiatuntiwong.workers.dev/?debug=1>
2. F12 เปิด DevTools → Console tab
3. Upload เอกสาร + กด Compare
4. ดู console:
   - `[ocr] TestINV.PNG — ocr-image — N tokens` — ตรวจว่า OCR จับ token "เครดิต", "30", "2026" ถูกไหม
   - `[compare] AI returned N fields` — ตรวจว่า AI ส่งค่าอะไร
   - `[match] "field name"` table — ดู confidence + matched tokens + box coordinates
5. ส่ง screenshot ของ console กลับมา → จะวิเคราะห์ root cause ตรง ๆ

## 25. สมมติฐาน root cause ที่ต้องยืนยันด้วย debug

| Hypothesis | จุดที่ดู | คาด confirm |
|---|---|---|
| **Tesseract แตก Thai เป็น char** | `[ocr]` log → "First 8 lines" — ดูว่า "เครดิต" มาเป็น 1 token หรือ 5 chars | ถ้า split → ต้องทำ Thai char re-assembly |
| **Date "15" filtered out** | `[match] "วันที่"` table → matched tokens ขาด "15"? | ถ้าใช่ → ปรับ Thai matcher ไม่ filter short tokens |
| **ยอดรวม Y ผิด** | `[match]` box `y` field — เทียบกับ tokens y | ถ้า box.y ตรง token แต่ render ลง → bug ใน `getImageRenderedRect` |
| **เลขโทร highlight = field อะไร** | `[match]` ทุก field → ดูว่า "เครดิต 30 วัน" หรือ field อื่น match ที่ x>0.05 และ text "(02-…)" | ถ้าใช่ → ต้องเพิ่ม sanity check ใน matcher |

## 26. ไฟล์ที่แก้ใน Phase 4

| ไฟล์ | การเปลี่ยน |
|---|---|
| [src/lib/frontend-ocr.ts](../src/lib/frontend-ocr.ts) | เพิ่ม `dbg()`, `logExtract()` — log token count + sample lines |
| [src/components/CompareWorkspace.tsx](../src/components/CompareWorkspace.tsx) | เพิ่ม per-field match summary log + AI fields log |

---

# Phase 5 — Thai Matcher Rewrite (page-text substring search)

> วันที่: 2026-05-16 (รอบที่ 5)
> Version ID: `49038286-9a1b-4e60-8dd7-7dc57b4b2cbb`

## 27. Root cause ที่ confirm จาก production debug log

จาก `[ocr]` debug log บน production (TestINV.PNG, Tesseract image OCR):

```
First 10 tokens: 'บ','ม','ซม','ใบ','ส','ั','ง','ซื','่','อ'
First 8 lines (concat):
  '1:7'  → 'บ ซม ใบ ซื ่'          (ควรเป็น "ใบสั่งซื้อ")
  '1:8'  → 'ส ั ง อ'
  '1:9'  → 'เล ข ท ี ก ส ร'        (ควรเป็น "เลขที่เอกสาร")
  '1:12' → 'PURCHASE ORDER uf 15 ม า ม 2026'
  '1:14' → 'เงื ่ น ไข ซํา ะ เง น ร ด ิ ต ว น'  ("เงื่อนไขชำระเงิน เครดิต..วัน")
```

**Tesseract แตก Thai เป็น glyph เดี่ยว ๆ + กระจายหลาย y-band** เพราะสระบน
(y≈0.066) กับพยัญชนะ/สระล่าง (y≈0.082) มี bounding box แยกกัน

`[match]` log ยืนยัน: ทุก Thai field (5/8) `matched=0, confidence=0`
ส่วน number/code fields (PO, tax id, total) `conf=0.95` ปกติ

**สาเหตุเชิงเทคนิค:** `buildLines()` ใช้ Y tolerance = `max(height)*0.5`
(≈0.005 สำหรับ Thai glyph เล็ก) ทำให้ glyph ของคำเดียวกันถูกแยกเป็นคนละ
"line" → line มีแค่ 4-5 สระ/วรรณยุกต์ → ngram match ระดับ line ใช้ไม่ได้
ซ้ำ `ngramSimilarity` หาร `max(A,B)` ทำให้ value สั้นเทียบ line ยาวได้คะแนนต่ำ

## 28. วิธีแก้: page-text substring search

แทน line-grouping + n-gram ทั้งหมดด้วย `matchByPageText()`:

1. รวม **ทุก token ในหน้า** เรียงตาม reading order (`READ_Y_TOL = 0.022`
   เพื่อ tolerate Thai vowel y-band) เป็น string เดียว
2. เก็บ map `char index → token index`
3. ค้นหา value (no-space, normalized):
   - **Exact substring** → confidence 0.95
   - ถ้าไม่เจอ → **fuzzy sliding trigram-density window** → confidence
     = trigram coverage (≤0.9)
4. Counterpart disambiguation: ถ้า region รอบ ๆ match มี counterpart text
   อยู่ด้วย → ลด priority + ลด confidence ×0.7
5. Map token กลับเป็น `OCRToken` เดิม (page/x/y/text identity)

ใช้ทั้ง:
- **Thai non-table** → เรียกตรง ๆ
- **Table** (`matchTable`) → ต่อ value line ที่ต่างจาก counterpart ทุกอัน
  เรียก `matchByPageText` (script-agnostic)

ลบ dead code: `buildLines`, `buildTableStructure`, `TableRow`, `TableCell`,
`ngramSimilarity`

## 29. ผลทดสอบ (TestINV.PNG, local)

| Field | ก่อน Phase 5 | หลัง Phase 5 |
|---|---|---|
| วันที่ "15 มีนาคม 2026" | 0 / conf 0 | 8 tokens / conf 0.80 |
| เงื่อนไขชำระเงิน "เครดิต 30 วัน" | 0 / conf 0 | 9 tokens / conf 0.56 |
| ชื่อผู้ออก (vendor name) | 0 / conf 0 | 22 tokens / conf 0.61 |
| PO-2026-0042 | 1 / conf 0.95 | 1 / conf 0.95 (ไม่ regress) |
| ยอดรวม 79,180.00 | 1 / conf 0.95 | 1 / conf 0.95 (ไม่ regress) |

Thai fields ที่เคยไม่มี highlight เลย → ตอนนี้ match ได้ confidence ต่ำ
จะ render เป็น **amber dashed + tooltip** (honest signal) ตามหลักการ
"report value before perfect highlight"

## 30. ข้อจำกัดที่ยังเหลือ (acceptable tradeoffs)

- กล่อง Thai กว้าง/หลายกล่อง เพราะ token กระจายหลาย y-band → merge แล้ว
  box ครอบ label ด้วยบางครั้ง — ยอมรับได้ (confidence ต่ำเตือนผู้ใช้)
- วันที่ซ้ำ (15 vs 31 มีนาคม) อาจ highlight ผิด instance — fuzzy window
  เลือก trigram-dense region; counterpart disambiguation ช่วยได้บางส่วน
- ถ้าจะแม่นกว่านี้ต้องทำ **Thai glyph re-assembly** (รวม vowel/tone token
  กลับเข้า base consonant ก่อน OCR คืนค่า) — เป็นงาน Phase ถัดไป

## 31. ไฟล์ที่แก้ Phase 5

| ไฟล์ | การเปลี่ยน |
|---|---|
| [src/lib/text-matcher.ts](../src/lib/text-matcher.ts) | เพิ่ม `matchByPageText()` + `READ_Y_TOL`; Thai/table ใช้แทน line-ngram; ลบ dead code (buildLines/buildTableStructure/ngramSimilarity) |
| [src/lib/frontend-ocr.ts](../src/lib/frontend-ocr.ts) | revert `dbg()` → localStorage gate (cache ค่าตอน module load) |
| [src/components/CompareWorkspace.tsx](../src/components/CompareWorkspace.tsx) | revert debug flag → localStorage gate |

---

# Phase 6 — Thai Glyph Re-assembly + OCR Tuning

> วันที่: 2026-05-16 (รอบที่ 6)
> Version ID: `f56204c8-3b17-4e6e-b4a7-bd81f0b9007f`

## 32. ปัญหาที่เห็นจาก UI จริง (หลัง Phase 5)

- ตัวเลข/รหัส (ยอดรวม, เลขที่เอกสาร, เลขผู้เสียภาษี) = กรอบน้ำเงิน **ตรงเป๊ะ** ✅
- Thai (วันที่, เงื่อนไขชำระเงิน, ชื่อผู้ออก) = highlight ขึ้นแล้วแต่:
  1. **เลือกผิด instance** — "15 มีนาคม" vs "31 มีนาคม" (มี "มีนาคม 2026"
     เหมือนกัน, OCR ทำ "15"/"31" เละ → fuzzy เลือกตัว trigram หนาแน่น)
  2. **กล่องกระจาย** — Tesseract แตก Thai เป็น glyph เดี่ยว ๆ → หลายกล่องเล็ก

## 33. แก้ 2 ส่วนควบคู่

### 33.1 Thai Glyph Re-assembly (`text-matcher.ts`)

เพิ่ม `assembleRuns()` — ก่อน substring search รวม glyph tokens เป็น
**word-run**:
- จัด token เข้า visual row (Δy ≤ `READ_Y_TOL` 0.022)
- เรียงตาม x, รวมเป็น run เดียวถ้า gap < `WORD_GAP` (0.018 ของความกว้างหน้า)
  — Thai stacked vowel มี gap ≈ 0 หรือติดลบ → รวมเข้า run เดียวกัน
- แต่ละ run เก็บ `members` (glyph tokens เดิม) ไว้ map กล่องกลับ

`matchByPageText` เปลี่ยนจาก concat ระดับ token → concat ระดับ **run**
+ `char→run` map → เมื่อ match ได้ดึง `members` ของ run ที่ครอบ →
`mergeTokenBoxes` ได้กล่อง **1 กล่องต่อคำ ตรง ไม่กระจาย**

ผล: substring exact match ทำงาน (เพราะ run = คำเต็ม) → เลือก instance ถูก

### 33.2 OCR Tuning (`frontend-ocr.ts`)

- `createTunedWorker()` — worker + `preserve_interword_spaces=1`,
  `tessedit_pageseg_mode=3` (auto layout)
- **Image OCR**: upscale canvas ให้ long edge ≥ 2400px (cap 3x) +
  `imageSmoothingQuality=high` → Thai glyph ใหญ่พอ Tesseract ไม่แตกเป็น
  per-glyph; bbox หารด้วย `canvas.width/height` ที่ scale แล้ว
- **Scanned PDF**: render scale 2 → **3**

แนวคิด: ป้อนภาพความละเอียดสูงขึ้น → Tesseract เลิกแตก Thai เป็น glyph
→ run re-assembly ได้คำเต็ม → exact substring → instance ถูก + กล่องตรง

## 34. ข้อสังเกตการทดสอบ

- `test-highlight.cjs` ใช้ **backend** `extractDocumentTokens` (ไม่ได้
  upscale — upscale อยู่ frontend เท่านั้น) จึง validate ได้แค่ re-assembly
  logic; OCR tuning ต้องทดสอบบน browser จริง
- Local test ยืนยัน: number fields ไม่ regress (0.95), Thai กล่องรวมเป็น
  คำ (กว้างขึ้น ครอบ word ไม่กระจาย)

## 35. ไฟล์ที่แก้ Phase 6

| ไฟล์ | การเปลี่ยน |
|---|---|
| [src/lib/text-matcher.ts](../src/lib/text-matcher.ts) | เพิ่ม `assembleRuns()` + `GlyphRun` + `WORD_GAP`; `matchByPageText` ทำงานระดับ run แทน token |
| [src/lib/frontend-ocr.ts](../src/lib/frontend-ocr.ts) | `createTunedWorker()`; image upscale ≥2400px; PDF scan scale 3; bbox normalize ด้วย canvas size |

## 36. ที่ยังเหลือ / รอผลทดสอบ browser

- ต้องทดสอบ production จริง (upscaled OCR) ว่า:
  - วันที่เลือก instance ถูก ("15" ไม่ใช่ "31")
  - กล่อง Thai ครอบคำ ไม่กระจาย
  - confidence สูงขึ้น (จาก fuzzy → exact substring)
- ถ้า OCR ยังแตก Thai อยู่แม้ upscale → ทางเลือกถัดไป: ICU word-break /
  dictionary segmentation หรือเปลี่ยน OCR engine (Google Vision / Typhoon OCR)

---

# Phase 7 — AI-diff Highlighting, Layered Matcher Hardening, PDF, Adaptive Thresholds

ทดสอบกับ `TestINV.PNG` / `TestPO.PNG` (image) และ `TestPO.pdf` / `TestINV.pdf`
(แยกจาก `Mockup Documents for SAAS Testing.pdf`) verify ทุก field โดยผู้ใช้.

## 37. Containing-block offset fix (จุด leverage สูงสุด)

อาการ: ทุกกล่องบนรูป PNG เลื่อน ~16px ลง+ขวาเป็นระบบ.

Root cause: overlay `<div>` เป็น absolute child ของ wrapper ชั้นใน แต่ระยะ
offset ถูกวัดเทียบ container ชั้นนอกที่มี `p-4` (padding ถูกนับซ้ำ).

แก้: เพิ่ม `imgWrapRef` ผูกกับ wrapper ชั้นใน (`relative inline-block ...`),
`recalculateImageHighlights` วัดเทียบ wrapper นั้น. บั๊กนี้บังคลุณภาพ matcher
มาหลาย phase — แก้แล้วงานที่เหลือถึงประเมินได้ตรง.

## 38. AI-diff: ไฮไลต์เฉพาะส่วนที่ต่าง (`docN_diff`)

แทนที่จะ match ทั้งค่า (ติด label/เซลล์ที่เหมือนกัน) — ให้ AI ส่ง
`doc1_diff` / `doc2_diff` / `doc3_diff` = substring สั้นที่สุดที่ต่างกันจริง
(verbatim, ไม่มี label). Frontend match ทีละ fragment → กล่องชิดเฉพาะ token
ที่เปลี่ยน. มี fallback: ถ้า AI ไม่ส่ง diff → match ทั้งค่า + `stripLabel`
(ลอก prefix label จาก field key, Unicode-aware `\p{L}\p{N}` รองรับไทย).

- `route.ts` rule 9: ส่ง diff **ครบทุก doc แบบสมมาตร**, currency = ตัวเลขล้วน
  ห้าม label; rule 8 ยกเว้น cell qty สั้นในตาราง; `PROMPT_VERSION` bump ทุกครั้ง
  ที่ schema เปลี่ยน (ล้าง edge cache).

## 39. Layered matcher hardening (`text-matcher.ts`)

ออกแบบเป็น "ด่านกรองซ้อนชั้น" — recall กว้างก่อน แล้วหดให้พอดี:

| ด่าน | ทำอะไร | แก้อาการ |
|---|---|---|
| `densestRow` | แยก span เป็น Y-band ตาม median glyph height ของ span เอง เก็บแถวที่ coverage สูงสุด | กล่องรั่วข้ามบรรทัด (`ง` ของ `อ้างอิง`) |
| `densestCluster` | แยก X-cluster ตาม `clusterGap` เก็บ cluster ที่ coverage สูงสุด | กล่องเกินจากเลขซ้ำคนละที่ |
| edge-trim | ตัด token หัว/ท้ายที่ไม่มีอักขระของค่าเลย (monotonic หดเท่านั้น) | กล่องคลุม `(Date)` / label |
| fuzzy-window growth | ขยายหน้าต่างตาม trigram จริง ข้าม OCR noise (gap ปรับตามความยาวค่า) | `(Net xx)` หลุดขอบหน้าต่าง |
| distinct-trigram coverage | จัดอันดับด้วย trigram **ที่ต่างกัน** ไม่ใช่นับซ้ำ | `000` ซ้ำในตารางชนะตำแหน่งจริง |
| numeric digit-align | จับเลขเทียบตำแหน่ง digit (ทนการแทนเลขผิด) + tiebreak ด้วย run ต่อเนื่องยาวสุด | `79,768.50` ที่ OCR เพี้ยน, แยกแถวที่ถูก |
| numeric single-token | ค่าที่เป็นเลข → ต้อง digit-string เท่ากันเป๊ะ ห้าม substring | `500.00` ไปจับ `35,000.00` |

## 40. Short table cells (qty `10`/`12`)

cell สั้น 1-2 ตัวจับทั่วหน้าไม่ได้ (ชนรหัสสินค้า `IT-C12`). แก้ที่
`CompareWorkspace`: หลังวางกรอบ amount เสร็จ → ใช้ y-band ของแถวที่แมตช์แล้ว
เป็น scope, หา token **ตัวเลขล้วน + ข้อความตรงเป๊ะ** ในแถวนั้น (`why=short-cell`).

## 41. `[highlight why]` debug trace

`MatchTrace` ติดมากับ `MatchResult` ทุกครั้ง — บอก path, row, matched text,
coverage, จำนวน glyph ที่ `densestRow`/`densestCluster` ตัด, และ adaptive
metrics. `CompareWorkspace` พิมพ์ตาราง `[highlight why]` หนึ่งแถวต่อกล่อง
(เปิดด้วย `?debug=1`) → ไล่ย้อนได้ว่ากล่องผิดมาจาก decision ไหน.

## 42. Highlight on/off toggle

ปุ่มในหัว Results Panel (`highlightsEnabled` state) ซ่อน/แสดงกรอบทุกเอกสาร
ทุกฟิลด์พร้อมกัน — gate ที่ `activeHighlights`.

## 43. PDF → image (เลิกใช้ react-pdf preview)

react-pdf `<Document>` ขึ้น "Failed to load PDF file" บน Cloudflare/OpenNext
(`new URL(...,import.meta.url)` resolve worker ไม่ได้). แก้แนวคิด: แปลง PDF
เป็น PNG ตั้งแต่ตอน upload แล้วใช้ image pipeline เดิมทั้งหมด.

- `src/lib/pdf-to-image.ts` — `pdfFileToImage()`: pdfjs render ทุกหน้า →
  ต่อแนวตั้งเป็น PNG เดียว (long edge 2400px, cap 10 หน้า).
- `handleFileInput` แปลงก่อนเก็บ state, แสดง spinner ระหว่างแปลง.
- worker pdfjs copy เข้า `/public/pdf.worker.min.mjs` ผ่าน script
  `copy-pdf-worker` (prepend ใน `build`/`deploy`/`dev`) — version ตรง
  pdfjs-dist เสมอ ไม่พึ่ง CDN.

## 44. Adaptive layout thresholds

`READ_Y_TOL` / `WORD_GAP` / `CLUSTER_GAP` คงที่เดิม over-fit กับสเกล glyph
ของเอกสาร test. เปลี่ยนเป็น `computeRowMetrics(tokens)` derive จาก median
glyph dimension ของเอกสารเอง (scale-free) แล้ว clamp:

- `yTol = clamp(medH × 0.75, 0.012, 0.032)`
- `wordGap = clamp(medW × 1.7, 0.008, 0.032)`
- `clusterGap = clamp(wordGap × 2.8, 0.030, 0.085)`

factor ผูกกับสถิติ glyph ที่วัดจากเอกสาร validation (medH≈0.026–0.032,
medW≈0.0105) → เอกสารทั่วไปได้ค่าใกล้ของเดิม (0.022/0.018/0.05), เอกสาร
text เล็ก/หนาแน่นจะได้ค่าแคบลงเอง(บรรทัดไม่หลอมรวม). `densestRow` ใช้ median
height ของ span เอง (adaptive อยู่แล้ว). metrics โผล่ใน `[highlight why]`.

## 45. ไฟล์ที่แก้ Phase 7

| ไฟล์ | การเปลี่ยน |
|---|---|
| [src/lib/text-matcher.ts](../src/lib/text-matcher.ts) | `densestRow`, edge-trim, fuzzy-window growth, distinct-trigram, numeric digit-align + run tiebreak, numeric single-token, `MatchTrace`, `computeRowMetrics` + adaptive thresholds |
| [src/components/CompareWorkspace.tsx](../src/components/CompareWorkspace.tsx) | AI-diff per-fragment + `stripLabel`, short-cell matcher, `[highlight why]`, containing-block offset fix, highlight toggle, PDF→image ใน `handleFileInput` |
| [src/app/api/compare/route.ts](../src/app/api/compare/route.ts) | `docN_diff` schema, rule 8/9 (symmetry + table short-cell), `PROMPT_VERSION` |
| [src/lib/pdf-to-image.ts](../src/lib/pdf-to-image.ts) | ใหม่ — rasterize PDF → PNG |
| [package.json](package.json) | script `copy-pdf-worker` |
| [public/pdf.worker.min.mjs](public/pdf.worker.min.mjs) | pdfjs worker เป็น static asset |

## 46. หลักการที่ยึด (Phase 7)

- **ทุกวิธีต้อง general** — derive จากสถิติ/อักขระของค่าเอง ไม่มีค่าคงที่
  ผูกเอกสาร test (ตาม mandate ผู้ใช้).
- recall กว้าง → ปล่อยด่านกรองท้ายน้ำหด — over-reach ปลอดภัยกว่า miss.
- numeric: ตำแหน่ง digit ทนกว่า trigram เมื่อ OCR แทนเลขผิด.
- รายงานค่าก่อน, ไฮไลต์เป๊ะทีหลัง — confidence ต่ำ <0.6 = กรอบส้มเส้นประ.

## 47. ที่ยังเหลือ

- ลบโค้ด react-pdf ที่เป็น dead code (Document/Page branch ใน
  `DocumentPreviewWithHighlights`, import, worker line) — preview ใช้
  image path ล้วนแล้ว.
- PDF text-layer (อ่านพิกัดคำตรงจาก text layer) ถูกแทนด้วย rasterize+OCR
  เพื่อความเสถียร — ความแม่นเท่างาน image. ถ้าต้องการความแม่นระดับ text PDF
  คืน path text-layer ได้แต่ต้องแก้ react-pdf rendering ก่อน.
