# Compare Page — Local Dev Crash Report

> สรุป: เมนู **Compare** เปิดไม่ได้ใน local dev เพราะ **react-pdf / pdfjs ชน Next 16 dev bundler**
> ไม่ใช่บั๊กจาก business logic ของ Compare และ **ไม่เกี่ยวกับงาน OCR multi-file / Word ที่เพิ่งทำ**
>
> ✅ **ยืนยันแล้ว (2026-06-17): Compare บน production (Cloudflare) ใช้งานได้ปกติ** →
> ตอกย้ำว่าเป็นปัญหา **dev-only** ล้วน ๆ (prod build จัดการ pre-bundled pdfjs ได้ถูกต้อง,
> webpack dev จัดการไม่ได้)

วันที่ตรวจสอบ: 2026-06-17

---

## 1. อาการ (Symptom)

เปิดเมนู Compare แล้วหน้าไม่ขึ้น + Console error:

```
TypeError: Object.defineProperty called on non-object
    at Object.defineProperty (<anonymous>)
    at (app-pages-browser)/./node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.mjs
    at eval (CompareWorkspace.tsx:8:68)
    at (app-pages-browser)/./src/components/CompareWorkspace.tsx
```

(มี hydration warning `className="dark"` บน `<html>` ด้วย แต่อันนั้น**ไม่เกี่ยวข้อง** — เป็นแค่ theme
ที่ apply ฝั่ง client ไม่ใช่ต้นเหตุ crash)

---

## 2. ต้นเหตุที่แท้จริง (Root Cause)

1. `CompareWorkspace.tsx` import react-pdf ที่ **ระดับ module (top-level)**:
   ```ts
   // src/components/CompareWorkspace.tsx:4
   import { Document, Page, pdfjs } from "react-pdf";
   ```
   → พอ chunk ของ CompareWorkspace ถูกโหลด pdfjs จะถูก evaluate ทันที

2. ไฟล์ `pdfjs-dist/build/pdf.mjs` ที่ react-pdf ใช้ เป็นไฟล์ที่ **ถูก webpack bundle มาแล้ว**
   (มี webpack runtime ของตัวเองอยู่ในไฟล์ — สังเกตจาก prefix `/******/`):
   ```js
   // node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.mjs : ~line 37
   /******/ Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
   ```

3. **Next.js 16 webpack dev เอาไฟล์ที่ bundle มาแล้วนี้ไป bundle ซ้อนอีกชั้น** →
   ตัวแปร `exports` ใน nested webpack runtime กลายเป็น non-object →
   `Object.defineProperty(exports, …)` throw ทันทีตอน module eval → ทั้ง chunk พัง

### ทำไม OCR ไม่พัง แต่ Compare พัง
- **OCR** ใช้ `pdf-lib` + `<iframe>` ในการแสดง PDF (ไม่แตะ react-pdf/pdfjs ที่ crash)
- **Compare** ใช้ `react-pdf` (`<Document>`/`<Page>`) ในการ render + ทำ highlight overlay
  ([CompareWorkspace.tsx:322-337](../src/components/CompareWorkspace.tsx)) → ไปโดน pdfjs ที่พัง

---

## 3. จุดที่ตรวจสอบ (Where to Look)

| สิ่งที่ต้องดู | ตำแหน่ง |
|---|---|
| จุด import ที่ทำให้ crash | `src/components/CompareWorkspace.tsx:4` |
| ตั้งค่า pdfjs worker | `src/components/CompareWorkspace.tsx:27` (`workerSrc = "/pdf.worker.min.mjs"`) |
| ไฟล์ pdfjs ที่ crash (react-pdf nested) | `node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.mjs` |
| ไฟล์ pdfjs top-level | `node_modules/pdfjs-dist/build/pdf.mjs` |
| สคริปต์ copy worker → public | `package.json` → `copy-pdf-worker` |
| config bundler / webpack | `next.config.ts` |
| วิธีรัน dev | `package.json` → `dev` = `next dev` (Next 16 default = Turbopack) |

### คำสั่งที่ใช้ตรวจสอบ
```bash
# ดูว่า react-pdf import pdfjs ยังไง
grep -rn "from 'pdfjs-dist'" node_modules/react-pdf/dist/

# เช็คว่าไฟล์ pdfjs เป็นแบบ bundle ซ้อน (/******/ = webpack runtime)
grep -c '/\*\*\*\*\*\*/' node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.mjs   # → 20
grep -c '/\*\*\*\*\*\*/' node_modules/pdfjs-dist/build/pdf.mjs                          # → 20

# เช็คเวอร์ชัน
cat node_modules/react-pdf/node_modules/pdfjs-dist/package.json | grep version  # 5.4.296
cat node_modules/pdfjs-dist/package.json | grep version                          # 5.6.205
```

---

## 4. เวอร์ชันที่เกี่ยวข้อง

| Package | เวอร์ชัน |
|---|---|
| next | 16.1.7 |
| react-pdf | 10.4.1 |
| pdfjs-dist (react-pdf nested) | 5.4.296 |
| pdfjs-dist (top-level) | 5.6.205 |
| worker ที่ copy ไป `public/pdf.worker.min.mjs` | 5.6.205 |
| Node | 22.20.0 |

> มี pdfjs **2 เวอร์ชันซ้อนกัน** (5.4.296 vs 5.6.205) และ worker (5.6.205) ไม่ตรงกับ
> API ที่ react-pdf ใช้ (5.4.296) — เป็นปัญหารองที่ควรจัดการด้วยเมื่อแก้หลัก

---

## 5. สิ่งที่ลองแก้แล้ว (Attempts)

| วิธีที่ลอง | ผล | สรุป |
|---|---|---|
| Alias pdfjs → **legacy build** ใน `next.config.ts` | ❌ crash เหมือนเดิม | legacy build ก็เป็นแบบ bundle ซ้อน — โดน double-bundle เหมือนกัน |
| Dedupe pdfjs ให้เหลือเวอร์ชันเดียว | ❌ | ทั้ง 2 เวอร์ชันเป็น pre-bundled เหมือนกัน เปลี่ยนเวอร์ชันไม่แก้ที่ต้นเหตุ |
| สลับไป **Turbopack** (`next dev --turbopack`) | ⚠️ แอป 500 | ติดปัญหาคนละเรื่อง: Tailwind v4 + Google Fonts `@import` ลำดับผิด (`@import rules must precede all rules`) |
| `next dev --webpack` (ปัจจุบัน) | ✅ ทุกอย่างใช้ได้ ยกเว้น Compare | เป็น baseline ที่ใช้งานอยู่ |

สรุป: **dev ทั้งสอง bundler ของ Next 16 ติดคนละจุด** — webpack ติด pdfjs, turbopack ติด CSS

---

## 6. ทางแก้ที่แนะนำ (ยังไม่ได้ทำ — รอตัดสินใจ)

เรียงจากความเสี่ยงต่ำ → สูง:

### ทางเลือก A — แก้ Turbopack path (แนะนำให้ลองก่อน)
- ย้าย Google Fonts จาก `@import` ใน `src/app/globals.css` (บรรทัด 2) ไปเป็น `<link>` ใน
  `src/app/layout.tsx` หรือใช้ `next/font/google`
- แล้วรัน dev ด้วย `next dev --turbopack`
- เหตุผล: Turbopack จัดการ ESM ต่างจาก webpack — **มีโอกาสสูงที่จะไม่ double-bundle pdfjs**
  และเป็น default ที่ Next 16 แนะนำ
- ⚠️ ต้องทดสอบใน browser เพราะ crash เกิดฝั่ง client (curl เช็คไม่ได้)

### ทางเลือก B — เปลี่ยนเวอร์ชัน library
- หาคู่ react-pdf / pdfjs / Next ที่เข้ากันได้ (เช่น downgrade Next, หรือเปลี่ยน react-pdf
  ไปตัวที่ไม่ได้ ship pdfjs แบบ pre-bundled)
- ⚠️ เสี่ยงกระทบ behavior ของ Compare เดิม (highlight math ผูกกับ react-pdf เวอร์ชันนี้)

### ทางเลือก C — แก้วิธีโหลด react-pdf ใน webpack
- lazy `dynamic(() => import(...), { ssr:false })` เฉพาะส่วน PDF preview + บอก webpack
  ไม่ให้ประมวลผล pdf.mjs ซ้ำ
- ซับซ้อนสุด

---

## 7. ข้อสรุปสำคัญ

- ❗ **ไม่ใช่บั๊กจากงานที่เพิ่งทำ** — `git diff` ยืนยันว่าไฟล์ที่แก้ (OCRWorkspace, exportUtils,
  i18n, schema, wrangler, ocrBatchConfig) **ไม่มีอันไหนแตะ** CompareWorkspace / react-pdf / next.config
- ❗ ปัญหา**มีอยู่ก่อน** เพิ่งเห็นเพราะเพิ่งเข้าเมนู Compare ครั้งแรกใน local dev
- ✅ **ยืนยันแล้ว: production (Cloudflare) ใช้ Compare ได้ปกติ** (ทดสอบ 2026-06-17) →
  ปัญหานี้ **ไม่กระทบผู้ใช้จริง** กระทบแค่ตอน develop ใน local dev
- 🔜 ยังไม่ได้ยืนยันว่าอีกเครื่องรัน Compare บน **local dev** ได้หรือไม่ — ถ้าได้ ให้เทียบ
  `package-lock.json` ระหว่างเครื่อง (เวอร์ชันที่ต่างกันอาจเป็นกุญแจ)

---

## 8. งานที่ค้างไว้ (Next Steps)
1. [x] ~~ยืนยัน Compare บน production ว่าใช้งานได้จริง~~ → **ใช้ได้ปกติ (2026-06-17)**
2. [ ] (ถ้าต้องการ develop Compare ใน local) ลองทางเลือก A — ย้าย Google Fonts ออกจาก
   `globals.css` → รัน `next dev --turbopack` → ทดสอบ Compare ใน browser
3. [ ] (ทางเลือก) ยืนยันว่าอีกเครื่องเปิด Compare ใน local dev ได้ไหม แล้วเทียบ `package-lock.json`

> ⚠️ ไม่เร่งด่วน: เนื่องจาก prod ใช้งานได้แล้ว การแก้ dev เป็นเรื่อง developer experience
> ไม่ใช่ bug ที่กระทบผู้ใช้
