-- DRAFT — NOT AUTO-APPLIED (DRAFT_ prefix keeps wrangler auto-apply scripts skipping this file).
-- PM sign-off required before running.
--
-- Source: pm/tasks/database.md §DB-1 forward-looking item.
--   OCR-3 (upcoming) adds a temperature-0.6 retry pass. The retry needs a
--   persistence slot for `isRetry: true` + attempt number + per-attempt
--   provider/model/temperature/tokens, so we can later analyze variance
--   (does retry help? which provider retries succeed? etc.).
--
-- Decision — Option (b): child table, NOT an inline `documents.attempt_count`.
--
--   Option (a) — `ALTER TABLE documents ADD COLUMN attempt_count INTEGER DEFAULT 1`
--     Pros:  one column, cheap.
--     Cons:  no per-attempt breakdown (which provider / temperature / tokens
--            was the winning attempt? which failed?). Variance analytics
--            impossible without a second write path anyway.
--
--   Option (b) — `document_attempts` child table (chosen)
--     Pros:  one row per attempt captures the full context of that AI call —
--            provider, model, temperature, isRetry flag, status_code (mirror
--            of the outcome), tokens. Enables `SELECT AVG(input_tokens),
--            AVG(output_tokens) GROUP BY is_retry` variance queries directly.
--            ai_usage already writes similar data per AI call, but ai_usage
--            is not scoped by doc-attempt lifecycle (it aggregates ALL
--            functions across compare/curate/…). Keeping OCR attempts
--            separate makes the retry-analytics query trivial.
--     Cons:  extra table + one INSERT per attempt. Cost negligible.
--
-- SQLite dialect:
--   * INTEGER for booleans (0/1). SQLite has no native BOOLEAN.
--   * `is_retry INTEGER NOT NULL DEFAULT 0` — first attempt = 0; retry = 1.
--   * `attempt_no INTEGER NOT NULL DEFAULT 1` — 1-based counter within a doc.
--   * Compound index `(doc_id, attempt_no)` supports the "show all attempts
--     for this doc" UI + guarantees insertion order for chronological reads.

CREATE TABLE IF NOT EXISTS document_attempts (
    id           TEXT PRIMARY KEY,
    doc_id       TEXT NOT NULL,                 -- FK-shape to documents(id); no hard FK
                                                -- (matches the ai_usage / user_preferences
                                                -- convention in this repo; keeps deletes cheap).
    attempt_no   INTEGER NOT NULL DEFAULT 1,    -- 1-based within the doc
    is_retry     INTEGER NOT NULL DEFAULT 0,    -- 0 = first pass, 1 = OCR-3 retry
    provider     TEXT,                          -- 'gemini' | 'openai' | 'openrouter' | 'vertex_ai'
    model        TEXT,                          -- provider-specific model id
    temperature  REAL,                          -- 0.0 (first pass) / 0.6 (retry) — free-form
    status       TEXT,                          -- 'completed' | 'error' — mirrors documents.status
    status_code  TEXT,                          -- ErrorCode string if status='error'; NULL if success
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    duration_ms  INTEGER,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_document_attempts_doc
    ON document_attempts(doc_id, attempt_no);

CREATE INDEX IF NOT EXISTS idx_document_attempts_retry
    ON document_attempts(is_retry, created_at DESC);

-- ─── Consumer changes required AFTER apply (not part of this migration) ───
--
-- 1. src/app/api/upload/route.ts — runOCR: after each AI call (whole-image,
--    crop pass, and any OCR-3 retry), INSERT one row per call into
--    document_attempts with the outcome. Keep ai_usage writes unchanged
--    (they're the billing ground-truth).
--
-- 2. OCR-3 ticket (not yet in pm/tasks/*) will consume the is_retry flag.
--    Flag OCR-pipeline agent that the schema slot is here when they pick
--    OCR-3 up.
--
-- Operator apply commands (do NOT run until PM approves):
--   wrangler d1 execute ocr-db --file=db/migrations/DRAFT_document_attempts.sql
--   wrangler d1 execute ocr-db --file=db/migrations/DRAFT_document_attempts.sql --remote
-- After apply, rename to `document_attempts.sql` and mirror into db/schema.sql.
