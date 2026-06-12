-- User-submitted feedback / bug reports.
-- Triggered by the floating "Feedback" button mounted in the main layout.
-- Admins triage via AdminFeedbackView (status: new → in_progress → resolved).

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  -- 'bug' | 'feature' | 'other' — drives the badge tint in admin view
  category TEXT DEFAULT 'other',
  message TEXT NOT NULL,
  -- 'new' | 'in_progress' | 'resolved'
  status TEXT DEFAULT 'new',
  -- Context captured automatically at submit time to help admins reproduce
  page_url TEXT,
  user_agent TEXT,
  -- Triage fields set when admin updates the row
  admin_note TEXT,
  resolved_by TEXT REFERENCES users(id),
  resolved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_status_created
  ON feedback(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_user
  ON feedback(user_id, created_at DESC);
