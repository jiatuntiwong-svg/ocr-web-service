-- AI Rule Curation — Phase E
-- Suggestions that the AI rule-manager produces from analyzing the rule set.
-- User reviews via the rule browser → applies or dismisses.

CREATE TABLE IF NOT EXISTS rule_suggestions (
    id              TEXT PRIMARY KEY,
    template_id     TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    kind            TEXT NOT NULL,        -- 'duplicate' | 'conflict' | 'refine' | 'retire' | 'merge'
    target_rule_ids TEXT NOT NULL,        -- JSON array of rule IDs this touches
    action_json     TEXT NOT NULL,        -- structured: { op: 'disable' | 'delete' | 'replace' | 'merge', ...params }
    natural_lang    TEXT,                 -- human description
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'applied' | 'dismissed'
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at     DATETIME
);

CREATE INDEX IF NOT EXISTS idx_suggestions_template
    ON rule_suggestions(template_id, status, created_at);
