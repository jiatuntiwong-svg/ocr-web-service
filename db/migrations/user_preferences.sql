-- Per-user preferences store. Moved out of `users` because the original
-- ALTER TABLE columns used `REFERENCES templates(id)` and D1 enforces FK
-- constraints (unlike SQLite's default). Global/system template IDs live in
-- a hardcoded list (GLOBAL_TEMPLATES) not in the `templates` table, so any
-- attempt to set them as the default failed the FK check.
--
-- We deliberately do NOT add a FK on the template_id columns here — a stale
-- pointer is harmless (auto-apply silently no-ops) and avoids the same trap.

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  default_ocr_template_id TEXT,
  default_compare_template_id TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Migrate any values that landed in the old columns (likely none, since the
-- FK rejected most writes, but harmless to copy).
INSERT OR IGNORE INTO user_preferences (user_id, default_ocr_template_id, default_compare_template_id)
  SELECT id, default_ocr_template_id, default_compare_template_id
  FROM users
  WHERE default_ocr_template_id IS NOT NULL OR default_compare_template_id IS NOT NULL;
