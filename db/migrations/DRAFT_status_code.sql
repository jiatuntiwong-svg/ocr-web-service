-- DRAFT — NOT AUTO-APPLIED (DRAFT_ prefix keeps wrangler auto-apply scripts skipping this file).
-- PM sign-off required before running.
--
-- Source: pm/reports/API-2.md §Follow-ups.
--   > "documents.status='error' rows currently persist raw AI error strings
--    > in raw_json.error. A status_code TEXT column on documents would let
--    > /api/status return a proper code — DB migration deliberately deferred."
--
-- What: adds a nullable status_code column to `documents`, plus a partial-ish
--       index for the status='error' filter that /api/status will use.
-- Why:  /api/status currently returns raw AI error strings pulled from
--       raw_json.error. With this column, the runOCR catch block can persist
--       an ErrorCode (e.g. "AI_UNAVAILABLE", "AI_FAILED") that /api/status
--       returns in the coded API-2 envelope.
--
-- SQLite-compat notes:
--   * ALTER TABLE ... ADD COLUMN is safe; existing rows get NULL, no default
--     needed (NULL = "no coded error / pre-migration row / not applicable").
--   * SQLite does not support `ADD COLUMN IF NOT EXISTS`. Re-running this
--     migration on a DB that already has the column will error. Migrations
--     are one-shot per the repo convention (see docs/MIGRATION.md) so that's
--     the expected behavior; the DRAFT_ prefix + PM gate is the guard.
--   * No FK, no CHECK — the ErrorCode enum lives in src/lib/errorCodes.ts;
--     enforcing at DB level would couple the schema to app-layer strings and
--     make future code refactors a migration event.

ALTER TABLE documents ADD COLUMN status_code TEXT;

-- Index supports the expected query pattern from /api/status:
--   SELECT status, raw_json, status_code, user_id FROM documents WHERE id = ?
-- The id lookup is already the PK, so this index is only useful if admin
-- dashboards later filter by (status, status_code) for error-rate charts.
-- Keeping it because it's cheap on a NULL-heavy column (partial-index effect).
CREATE INDEX IF NOT EXISTS idx_documents_status_code
    ON documents(status, status_code)
    WHERE status_code IS NOT NULL;

-- ─── Consumer changes required AFTER apply (not part of this migration) ───
--
-- 1. src/app/api/upload/route.ts — runOCR catch block (~L554–560):
--       await env.DB.prepare(
--           "UPDATE documents SET status = ?, raw_json = ?, status_code = ? WHERE id = ?"
--       ).bind("error", JSON.stringify({ error: ocrError.message }), coded, docId).run();
--    where `coded` is one of ErrorCode.AI_UNAVAILABLE / AI_FAILED / SERVER_ERROR
--    picked from the error class (mirror the mapping in v1/extract).
--
-- 2. src/app/api/status/route.ts — extend SELECT + return `status_code` in the
--    response envelope so UI-3's apiError(code) can render friendlyError().
--
-- Operator apply commands (do NOT run until PM approves):
--   wrangler d1 execute ocr-db --file=db/migrations/DRAFT_status_code.sql            # local
--   wrangler d1 execute ocr-db --file=db/migrations/DRAFT_status_code.sql --remote   # production
-- After apply, rename the file to `status_code.sql` (drop DRAFT_) and mirror
-- the ALTER + index into db/schema.sql per the repo migration rule.
