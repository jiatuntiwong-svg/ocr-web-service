-- Template Rulebase — Phase A foundation
-- Three tables that grow with user-driven corrections so AI extraction +
-- comparison can learn business context per template.
-- Plan: docs/RULEBASE_LEARNING_LOOP_PLAN.md

-- 1. Rules attached to a specific template (owner scope per D1).
--    Cascading delete keeps things tidy when a template is removed.
CREATE TABLE IF NOT EXISTS template_rules (
    id            TEXT PRIMARY KEY,
    template_id   TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    type          TEXT NOT NULL,          -- 'extraction' | 'alignment' | 'comparison' | 'validation'
    spec_json     TEXT NOT NULL,          -- structured rule spec (see plan §2.2)
    natural_lang  TEXT,                   -- human-readable explanation, shown in UI
    source        TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'ai_generated' | 'system'
    confidence    REAL NOT NULL DEFAULT 0.7,     -- 0..1
    hit_count     INTEGER NOT NULL DEFAULT 0,
    miss_count    INTEGER NOT NULL DEFAULT 0,
    enabled       INTEGER NOT NULL DEFAULT 1,    -- 1 = active, 0 = disabled
    deleted_at    DATETIME,                     -- soft delete (D7 versioning)
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at  DATETIME,
    derived_from_correction_id TEXT              -- nullable; links back to user_corrections
);

CREATE INDEX IF NOT EXISTS idx_template_rules_template
    ON template_rules(template_id, enabled, deleted_at);
CREATE INDEX IF NOT EXISTS idx_template_rules_user
    ON template_rules(user_id, deleted_at);

-- 2. Raw user corrections — the source-of-truth feedback that AI later turns
--    into rules. Per D10 we DROP corrections that didn't yield a rule, but
--    we keep the table around so Phase E batch curation can re-process
--    pending ones later if we decide to relax D10.
CREATE TABLE IF NOT EXISTS user_corrections (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    template_id     TEXT NOT NULL,
    document_id     TEXT,                    -- which doc was being viewed
    field_key       TEXT,                    -- which field was wrong
    pane_idx        INTEGER,                 -- 0=doc1, 1=doc2, ... (Compare-specific)
    wrong_value     TEXT,                    -- AI's answer
    correct_value   TEXT,                    -- user's correction
    issue_type      TEXT,                    -- 'wrong_value' | 'wrong_field' | 'should_ignore'
    explanation     TEXT,                    -- optional rationale
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'rule_generated' | 'rejected' | 'manual'
    rule_id         TEXT,                    -- nullable; FK-ish to template_rules.id
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_corrections_template
    ON user_corrections(template_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_corrections_user
    ON user_corrections(user_id, created_at);

-- 3. Telemetry — every time a rule was considered during an extraction,
--    record whether it fired. Phase E uses this to compute confidence
--    decay + retirement signals.
CREATE TABLE IF NOT EXISTS rule_applications (
    id           TEXT PRIMARY KEY,
    rule_id      TEXT NOT NULL,
    document_id  TEXT,
    fired        INTEGER NOT NULL,   -- 1 = matched, 0 = considered + skipped
    helpful      INTEGER,            -- NULL = unknown, 1 = good outcome, 0 = bad
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_applications_rule
    ON rule_applications(rule_id, created_at);
