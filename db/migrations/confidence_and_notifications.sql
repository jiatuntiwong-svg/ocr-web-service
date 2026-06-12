-- G3 Confidence threshold + manual review + notifications
--
-- Three concerns, one migration because they ship together as a feature.

-- 1. Per-user confidence settings live on the existing user_preferences row
--    (see user_preferences.sql for why this table exists separately from users).
--    threshold is a 0..1 fraction; block_export_low_confidence is the user's
--    opt-in to hard-block (default soft warning only).
ALTER TABLE user_preferences ADD COLUMN confidence_threshold REAL DEFAULT 0.7;
ALTER TABLE user_preferences ADD COLUMN block_export_low_confidence INTEGER DEFAULT 0;

-- 2. Per-document review state. NULL = not reviewed. reviewed_by stores user_id
--    of whoever clicked "Mark as Reviewed" (usually the document owner, but
--    admins can review on behalf of users too).
ALTER TABLE documents ADD COLUMN reviewed_at DATETIME;
ALTER TABLE documents ADD COLUMN reviewed_by TEXT;

-- 3. Notifications. One row per recipient — admin broadcasts are fanned out at
--    write time (insert one row per admin) so reads stay a simple WHERE user_id.
--    audience just tags the source category for the UI; it's not used for routing.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                    -- recipient
  audience TEXT NOT NULL DEFAULT 'user',    -- 'user' | 'admin' (tag, not routing)
  kind TEXT NOT NULL,                       -- 'low_confidence' | 'credit_low' | 'job_done'
                                            -- 'new_user' | 'payment' | 'login_fail_spike'
                                            -- 'error_spike' | 'feedback' | 'integration_fail'
  severity TEXT NOT NULL DEFAULT 'info',    -- 'info' | 'warning' | 'error'
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                                -- deep-link path (e.g. /documents/abc)
  metadata_json TEXT,                       -- arbitrary payload for renderer
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, read_at, created_at DESC);
