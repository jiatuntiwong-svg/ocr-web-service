# UX/UI Design Brief — OCR Web Service (DOCRoom)

เอกสารนี้สรุป **โครงสร้าง UX/UI ปัจจุบัน** เพื่อส่งต่อให้ผู้ออกแบบ (หรือ Claude
design) ใช้ออกแบบ design system + ปรับ IA ต่อ ("ชั้น A: Foundation")
ยังไม่ใช่ข้อกำหนดการ implement — เป็นภาพ "ตอนนี้เป็นอย่างไร".

---

## 1. ภาพรวมผลิตภัณฑ์

DOCRoom — เว็บแอป OCR/เอกสารอัจฉริยะ มี 3 ฟังก์ชันผู้ใช้หลัก (OCR สกัดข้อมูล,
Compare เปรียบเทียบเอกสาร, Public API) + โซน admin จัดการระบบ คิดเงินแบบ
credit ต่อการเรียก AI 1 ครั้ง มีระบบ tier/plan (free/starter/pro/enterprise)

## 2. Tech stack ที่เกี่ยวกับ UI

| ด้าน | ปัจจุบัน |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | **Tailwind CSS v4** (`@import "tailwindcss"` + `@theme inline` ใน globals.css) — `tailwind.config.ts` แทบว่าง |
| Deploy | Cloudflare Workers (OpenNext) — กระทบเรื่อง bundle size |
| Icons | **inline `<svg>` เขียน path เองทุกที่** — ไม่มี icon library |
| UI library | **ไม่มี** (ไม่มี Radix/Headless/shadcn/lucide) — ทุก component เขียนเอง |
| ฟอนต์ | โหลด Geist + Geist_Mono เป็น CSS var แต่ `body` ใช้ `Arial`; `page.tsx` อ้าง `font-[Outfit,sans-serif]` ทั้งที่ไม่ได้ import Outfit → **ฟอนต์ไม่นิ่ง 3 ทาง** |
| Dark mode | ใช้ `dark:` variant เยอะมาก ขับด้วย `prefers-color-scheme` ของระบบ — **ไม่มีปุ่มสลับเอง** |
| Background | `body` มีรูป `/background.png` แบบ fixed cover |

## 3. โครงสร้างหน้า (App Shell / IA)

แอปหลักเป็น **single page (`/`)** สลับมุมมองด้วย React state (`activeView`) —
ไม่ได้แยก route ต่อหน้า มี route แยกเฉพาะ auth

```
/login   /register        ← หน้า auth แยก
/                         ← แอปหลัก (client-side view switching)
```

**App shell ของหน้าหลัก:**
- **แถบไอคอนซ้าย** (w-20 / lg:w-24) — โลโก้บน → กลุ่มปุ่มนำทาง (ไอคอนล้วน ไม่มี label) → avatar + logout ล่าง
- **เนื้อหาขวา** — header บน (h1 ตัวอักษร gradient + ชิป Plan/Credits) → พื้นที่ view

## 4. รายการเมนู / Navigation (จุดที่ IA เริ่มมีปัญหา)

แถบไอคอนซ้าย เรียงดังนี้ (ปุ่มเป็น "ไอคอนเปล่า" บอกด้วย `title` tooltip เท่านั้น):

| เมนู | สิทธิ์ | หมายเหตุ |
|---|---|---|
| OCR Workspace | ทุกคน* | *ซ่อนถ้า tier ปิด feature |
| Compare | ทุกคน* | *ซ่อนถ้า tier ปิด feature |
| Dashboard | ทุกคน | |
| API & Settings | admin | |
| Billing | ทุกคน | |
| Admin: Users | admin | |
| Admin: Logs | admin | |
| Admin: AI Usage | admin | |
| Admin: Tier Control | admin | |

⚠️ **ปัญหา IA:** ปุ่ม admin งอกมา 4 ตัวปนกับเมนูผู้ใช้ในแถบเดียว, เป็นไอคอน
เปล่าไม่มี label, ไม่มีการจัดกลุ่ม "ผู้ใช้ vs แอดมิน" — แถบเริ่มแน่นและสับสน

## 5. รายการหน้าจอ (Screen Inventory)

| Component | บรรทัด | บทบาท |
|---|---|---|
| `OCRWorkspace.tsx` | 946 | อัปโหลดเอกสาร → เลือก field → สกัดด้วย AI → แสดงผล + export |
| `CompareWorkspace.tsx` | 1160 | อัปโหลด 2-3 เอกสาร → เทียบ field → highlight overlay บนรูป → ผลลัพธ์ + export |
| `DashboardView.tsx` | 504 | welcome banner, KPI 4 ใบ, การใช้งานแยก function, กราฟ volume, Recent Activity, Plan Usage |
| `AdminUsersView.tsx` | 484 | ตารางผู้ใช้ + แก้ plan/credit/role/password |
| `AdminAIUsageView.tsx` | 483 | ต้นทุน token, เรตต่อ model, รายงานรายเดือน/CSV, raw log |
| `APISettingsView.tsx` | 285 | admin ตั้งค่า AI provider / API key |
| `BillingView.tsx` | 205 | แพ็กเกจ/แพลน |
| `AdminTierControlView.tsx` | 181 | matrix toggle feature + ช่องเครดิตต่อ tier |
| `AdminLogsView.tsx` | 133 | ตาราง system log |
| `Sidebar.tsx` | 60 | ของเดิม — อาจ legacy/ซ้ำซ้อนกับ nav inline ใน `page.tsx` (ควรตรวจ) |
| `login` / `register` | — | หน้า auth |

## 6. UI Pattern ที่เกิดซ้ำ (ผู้สมัครเป็น component กลาง)

รูปแบบเหล่านี้ถูก **เขียน Tailwind ก้อนเดิมซ้ำ** กระจายหลายไฟล์ — คือรายการ
component ที่ design system ควรสร้าง:

| Pattern | สภาพปัจจุบัน | ใช้ที่ |
|---|---|---|
| **Card / Panel shell** | `bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[...] border border-slate-200 dark:border-slate-800 shadow-sm` | 6+ ไฟล์ |
| **Page/Section header** | h2 + ไอคอนในกล่องสี + คำบรรยาย + ปุ่มขวา | ทุก admin view (ก้อนเดิมซ้ำ) |
| **Data table** | `thead` slate, `text-[10px] uppercase tracking-wider`, `divide-y`, row hover | AdminLogs/Users/AIUsage/TierControl |
| **KPI / stat card** | กล่องไอคอน + ตัวเลขใหญ่ + label + sub | Dashboard, AI Usage |
| **Toggle switch** | ปุ่ม pill `h-6 w-11` + วงกลมเลื่อน | Tier Control (มีที่เดียว ควรกลาง) |
| **Button — primary/secondary/danger** | สีต่างกันทุกที่ ไม่มีมาตรฐาน | ทุกหน้า |
| **Badge / pill (สถานะ)** | `text-[9px] uppercase rounded-full` สี emerald/amber/rose | Dashboard, Logs |
| **Form input** | `px-3 py-2 rounded-lg border ...` เขียนซ้ำ | Tier Control, AI Usage, Settings |
| **Export buttons (Excel/CSV)** | คู่ปุ่ม emerald/blue ไอคอน download | Dashboard, Compare, OCR |
| **Empty state** | ข้อความ "No ... yet" จัดกลาง | หลายตาราง |
| **Loading spinner** | `animate-spin` SVG เขียนเอง 2-3 แบบ | หลายที่ |
| **Refresh button** | ไอคอนหมุน + "Refresh" | admin views |
| **Tab / segmented switch** | กลุ่มปุ่มใน `bg-slate-100 p-1 rounded-xl` | Dashboard (weekly/monthly/yearly) |
| **Modal/Dialog** | ใช้ `confirm()`/`alert()` ของ browser เป็นหลัก — ไม่มี modal component |

## 7. Design Token ปัจจุบัน (de facto — ยังไม่เป็นระบบ)

- **สีฐาน:** Slate palette ทั้งหมด (`slate-50…950`) — เป็นโทนหลัก
- **สี accent (ผูกตามโซน — ไม่สม่ำเสมอ):** OCR=blue, Compare=amber, AI Usage=emerald, Tier Control=indigo, Admin Users=amber, Admin Logs=rose; KPI ใช้ blue/emerald/violet/amber
- **Radius (กระจัดกระจายมาก):** `rounded-md, lg, xl, 2xl, 3xl, full` + ค่า arbitrary `rounded-[1.75rem] / [2rem] / [2.5rem]` — ไม่มี scale ที่นิ่ง
- **Typography:** ใช้ `font-black` หนัก ๆ เยอะมาก; label เล็กเป็น `text-[9px]/[10px] uppercase tracking-widest` (บางที่ `tracking-[0.25em]`); หัวเรื่อง gradient text
- **Shadow:** `shadow-sm` เป็นหลัก, บางที่ `shadow-md/xl/2xl`, glow แบบ `shadow-blue-500/20`
- **Spacing:** `p-6 / p-8`, gap `gap-4/5/6` — ค่อนข้างสม่ำเสมอแต่ไม่ได้นิยามเป็น token
- **Custom CSS:** `custom-scrollbar` (ใช้บ่อย), background image, CSS var `--background/--foreground`

## 8. ปัญหา/ความไม่สม่ำเสมอที่พบ (โจทย์ของ design system)

1. **ฟอนต์ 3 ทางไม่ตรงกัน** — Geist (โหลด) vs Arial (body) vs Outfit (อ้างใน class แต่ไม่ได้ import)
2. **Radius zoo** — ไม่มี scale มาตรฐาน (6+ ค่า)
3. **Component ซ้ำ** — card/header/table/input ถูก copy Tailwind ก้อนเดิมข้าม 4 admin view
4. **ไม่มี component layer** — ทุกอย่าง inline, แก้ที่เดียวไม่กระทบทั้งระบบ
5. **Dynamic class เสี่ยง** — โค้ดบางจุดเคยสร้าง `bg-${color}-50` ซึ่ง Tailwind ไม่ compile (ต้อง map เป็น class เต็ม)
6. **IA แถบ admin แน่น** — ไอคอนเปล่า ไม่มี label/grouping
7. **ภาษาปนกัน** — Thai/English ปนทั้งใน UI label ("Refresh Logs" + "บันทึกการตั้งค่า") ไม่มีแนวทางชัด
8. **ไม่มี modal/notification system** — ใช้ `alert()`/`confirm()` ของ browser
9. **Dark mode** — ขับด้วย system อย่างเดียว ไม่มีปุ่มให้ผู้ใช้เลือก
10. **Responsive ไม่มีแนวทางชัด** — มี `md:`/`lg:` กระจาย แต่ไม่มี breakpoint strategy ที่ระบุ
11. **ไอคอน** — path SVG เขียนเอง ซ้ำ คุมสไตล์ไม่ได้

## 9. ข้อจำกัด/สิ่งที่ต้องคงไว้

- ต้องอยู่บน **Tailwind v4** + รันบน **Cloudflare Workers** (เลี่ยง dependency หนัก/bundle ใหญ่)
- ทุก component เป็น **client component** (React 19)
- ฟังก์ชันหลัก/พฤติกรรมปัจจุบัน (OCR, Compare + highlight overlay, credit, tier gating) ต้องไม่เสีย — งานนี้คือ **visual/structure layer** ไม่ใช่เปลี่ยน logic
- รองรับ **ไทย + อังกฤษ** (เนื้อหาส่วนใหญ่เป็นไทย)

## 10. ชุด Component ที่เสนอให้สร้าง (Foundation shopping list)

เรียงตามความถี่การใช้/ผลตอบแทน:

1. **Tokens** — สี (base + accent ที่ map ชัด), radius scale (เช่น sm/md/lg/xl เดียว), typography scale, spacing, shadow, ฟอนต์เดียว
2. `<AppShell>` + `<NavRail>` — แก้ IA: จัดกลุ่มเมนูผู้ใช้/แอดมิน, มี label, รองรับการขยาย
3. `<Card>` / `<Panel>` — card shell มาตรฐาน
4. `<PageHeader>` / `<SectionHeader>` — หัวเรื่อง + ไอคอน + action
5. `<Button>` — variant: primary / secondary / ghost / danger + size
6. `<DataTable>` — table + thead/แถว/empty/loading state
7. `<StatCard>` — KPI การ์ด
8. `<Toggle>` / `<Switch>`
9. `<Badge>` — สถานะ/pill
10. `<Input>` / `<Select>` / `<FormField>`
11. `<Modal>` / `<Toast>` — แทน `alert()`/`confirm()`
12. `<Spinner>` / `<EmptyState>`
13. `<Tabs>` / `<SegmentedControl>`
14. `<IconButton>` + ชุดไอคอนกลาง (รวม path ที่ใช้ซ้ำ)

## 11. หน้าที่ควรใช้เป็น "ตัวตั้งต้น" ตอน redesign

- **Dashboard** — รวม pattern เยอะสุด (KPI, chart, table, activity, badge) → ออกแบบที่นี่ก่อนได้ token/component ครบ
- **Admin views (4 หน้า)** — โครงเดียวกันหมด (header + table) → ได้ `DataTable`/`PageHeader` แล้วแปลงได้เร็วและเห็นผลชัด
- **Compare/OCR Workspace** — ซับซ้อนสุด (1000+ บรรทัด, มี overlay/canvas) → ทำท้าย หลัง component นิ่ง

---

_อัปเดตเมื่อเริ่มงานชั้น A — ใช้คู่กับการดูโค้ดจริงใน `src/components/` และ `src/app/`_
