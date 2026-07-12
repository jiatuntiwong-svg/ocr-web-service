# Work orders — backend-api agent

Sprint: OCR Stabilization. Update pm/BOARD.md status when you start/finish a task. Write findings to pm/reports/<ID>.md.

---

## API-1 (P0) — Page-selection support in upload/extract

**Context:** Issue 1.3: 10+ page PDFs take minutes because every page is converted and sent to AI. Frontend will add a page-picker (UI-1); the API must accept the selection.

**Do:**
1. In `src/app/api/upload/route.ts` and `src/app/api/v1/extract/route.ts`: accept optional `pages: number[]` (1-based). Validate: non-empty, within page count, cap at a configurable max (default 5, see `src/lib/ocrBatchConfig.ts`).
2. When `pages` present, process only those pages. When absent, keep current behavior BUT enforce a `maxPages` cap with a clear error code (`TOO_MANY_PAGES`) instead of silently grinding.
3. Batch mode (`runBatchItem` path) gets the same param.
4. **⚠️ Added 2026-07-05 (from OCR-1 findings):** `bbox_hint` stores a `page` number per field. When `pages` filters/reorders pages, hints must be remapped to the new page indices (or keyed to original page numbers end-to-end). Coordinate the contract with ocr-pipeline before implementing — getting this wrong silently breaks all saved hints.

**Done when:** API contract documented in `pm/reports/API-1.md` (frontend-ui will build against it), tested via `npm run preview`.

---

## API-2 (P1) — Error codes instead of raw messages (OCR routes only)

**Context:** PENDING_ISSUES §H2: `/api/upload`, `/api/status`, `/api/v1/extract` return `error.message` — leaks internals, not i18n-able. Full catalog refactor is Phase 7.5; this sprint covers OCR routes only.

**Do:**
1. Responses become `{ ok: false, code: "UPLOAD_FAILED" | "AI_FAILED" | "TOO_MANY_PAGES" | "INSUFFICIENT_CREDITS" | "UNAUTHORIZED" | "FILE_TOO_LARGE" | ..., detail?: string }` — use/extend `src/lib/errorCodes.ts` and `src/lib/apiResponse.ts`.
2. `detail` is logged via `src/lib/logger.ts`, never required by the UI.
3. Strip any `raw: text` payloads from `/api/v1/extract` error responses (H4 quick win).
4. Keep backward compatibility: include a generic `error` string so existing UI doesn't break before UI-3 lands.

**Done when:** the three OCR routes return coded errors, codes listed in `pm/reports/API-2.md` for frontend-ui.

---

## API-3 (P2) — Upload size guard (F4)

**Context:** PENDING_ISSUES §F4: no size cap on uploads; huge embedded images can OOM the canvas/Worker.

**Do:**
1. Enforce max upload size in `api/upload` (propose limit based on Workers memory constraints — check with devops-cloudflare agent's OPS-1 findings; suggest 15–20 MB to start).
2. Return `FILE_TOO_LARGE` code (from API-2) with the limit in `vars`.

**Done when:** oversized upload rejected cleanly in preview build. Report in `pm/reports/API-3.md`.

---

**Coordinate:** retry param naming with ocr-pipeline (OCR-3); error codes list with frontend-ui (UI-3).
