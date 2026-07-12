# Sub-agents สำหรับ ocr-web-service

โฟลเดอร์ `.claude` ถูกป้องกันใน session นี้ จึงสร้างไฟล์ไว้ที่นี่ก่อน

## วิธีติดตั้ง

ย้ายไฟล์ .md ทั้งหมด (ยกเว้น README นี้) ไปที่ `.claude/agents/`:

```powershell
mkdir .claude\agents -Force
move claude-agents\*.md .claude\agents\
del .claude\agents\README.md
rmdir claude-agents
```

จากนั้นใน Claude Code ใช้ `/agents` เพื่อตรวจสอบว่าโหลดครบ 7 ตัว

## รายชื่อ agent

| Agent | ดูแล |
|---|---|
| backend-api | src/app/api, auth/session/guards, API conventions |
| frontend-ui | src/components, pages, i18n, theme, hooks |
| ocr-pipeline | AI extraction, text-extractor, highlight-pipeline, compare diff |
| billing-payment | Stripe, pricing, credits, tier, AI usage metering |
| database | db/schema.sql, migrations, D1 |
| devops-cloudflare | wrangler, OpenNext, deploy, bindings |
| docs-manager | docs/ ทั้งหมด ให้ตรงกับ code |

## วิธีเรียกใช้

Claude Code จะเลือก agent อัตโนมัติจาก description หรือเรียกตรงๆ เช่น:
"use the ocr-pipeline agent to fix table row alignment in compare"
