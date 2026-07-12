# DB-1 — Schema review: corrections / bbox_hint / retry / status_code

**Status:** review — draft migrations produced, **NO schema changes applied**. PM sign-off required before any `wrangler d1 execute`.
**Owner:** database agent
**Sprint:** OCR Stabilization
**Related:** `pm/tasks/database.md` §DB-1, `pm/reports/API-2.md`, `pm/reports/OCR-6.md`/`6b`/`6c`, `pm/reports/BILL-1.md`, `pm/reports/AI-1.md`

---

## Ground state

### Tables declared in `db/schema.sql`
`users`, `transactions`, `user_limits`, `documents`, `extracted_data`, `templates`, `ai_usage`, `system_logs`.

### Migrations already applied (in filename order, all committed = assumed applied per repo convention)
- `user_preferences.sql` — new `user_preferences` table
- `feedback.sql` — new `feedback` table
- `default_templates.sql` — `users.default_ocr_template_id`, `users.default_compare_template_id`
- `confidence_and_notifications.sql` — `user_preferences.confidence_threshold`, `user_preferences.block_export_low_confidence`, `documents.reviewed_at`, `documents.reviewed_by`, new `notifications` table
- `template_rules.sql` — new `template_rules`, `user_corrections`, `rule_applications` (rulebase Phase A)
- `rule_suggestions.sql` — new `rule_suggestions` (AI curation Phase E)

### Schema drift I noticed while grepping
- **`system_settings` is NOT declared in `db/schema.sql` and has no migration file.** It's created inline via `CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)` inside `src/lib/pricing.ts:231` and `src/lib/tier-config.ts:47` (BILL-1 + tier-config code). BILL-1 (`CREDIT_MODEL`) and AI-1 (`AI_POWER_CONFIG`) both rely on this table. Shape is fine for both — key/value TEXT with JSON-serialised value handles Vertex-AI slug + BILL-1 model name without change. **Recommend a follow-up migration `system_settings.sql` to add the table to `db/schema.sql` for parity, but the code's `CREATE TABLE IF NOT EXISTS` guard means this is documentation debt, not runtime risk.** Not drafting today because there's no consumer breakage.
- **`db/schema.sql` file is UTF-16-corrupted from byte ~1400 onward** — the `system_logs` block reads as wide-char nonsense. Runtime is unaffected because the block is inside a `CREATE TABLE IF NOT EXISTS` and the D1 DB was seeded before the encoding got mangled. Flag for docs-manager: a plain-ASCII rewrite would make future greps trustworthy.

---

## Audit table — one row per feature vs schema

| Feature | Persisted? | Where | Survives reload? | Current query pattern | Gap? |
|---|---|---|---|---|---|
| **bbox_hint per template field** (OCR-6c) | ✅ yes | `templates.fields_json` (whole field-array JSON-encoded) | ✅ yes — OCRWorkspace's auto-capture fires `POST /api/templates` with the full field array including `bbox_hint` (`OCRWorkspace.tsx:259, 540, 615`). `hint.space: "page"` marker rides inside the same JSON. | Templates fetched as opaque blob, parsed client-side. No SQL filter needs hint-awareness. | **NO** — hint is a leaf field of an already-persisted JSON column. |
| **corrections[]** (AI self-reported spelling fixes) | ✅ yes | `documents.raw_json` (per-field object) | ✅ yes — `/api/status` returns raw_json parsed, Documents view reads `documents.raw_json` (`documents/route.ts:41–51`). Post-refresh the ✎ badges will re-render from persisted JSON. | Opaque `SELECT raw_json ... WHERE id = ?` in status/documents/stats. Stats route iterates parsed raw_json client-side. No "docs with corrections" filter exists today. | **NO** — nothing queries corrections as a first-class dimension. |
| **crop pass provenance** (OCR-6/6b: `source:"crop"`, `crop_miss:true`, `crop_no_match:true`) | ✅ yes | `documents.raw_json` (per-field object) | ✅ yes — same code path as corrections. | Opaque JSON. Dev-mode server logs `[OCR-6b] crop merge provenance` for live diagnostics. | **NO**. |
| **retry / attempt count** (OCR-3, upcoming) | ❌ no | nowhere | N/A | N/A | **YES** — forward-looking. Draft migration produced (child table). |
| **`status_code` on documents** (API-2 follow-up) | ❌ no | `documents.raw_json.error` holds raw AI error string only; `documents.status` is `'pending'`\|`'completed'`\|`'error'` (no coded machine-readable slot) | 🟡 the raw error string does, but it's not machine-readable — `/api/status` can't return a proper code | `UPDATE documents SET status='error', raw_json=? WHERE id=?` in upload/route.ts:557. Read by /api/status:23 opaquely. | **YES** — draft migration produced. |
| **BILL-1 `CREDIT_MODEL`** | ✅ yes | `system_settings.CREDIT_MODEL` (JSON-serialised `"per_page"` \| `"field_formula"` \| `"per_file"`) | ✅ yes — read every OCR request via `getActiveCreditModel(env)` (`pricing.ts:227`) | `SELECT value FROM system_settings WHERE key = 'CREDIT_MODEL'` | **NO** — shape already fits. See schema-drift note above (documentation follow-up, not blocker). |
| **AI-1 Vertex-AI provider slug + `location`** | ✅ yes | `system_settings.AI_POWER_CONFIG` (JSON array of `AIConfig`) | ✅ yes — `getActiveAIConfigs(env)` reads on every AI call (`ai-handler.ts:5`) | Opaque JSON parse. New provider value `"vertex_ai"` and optional `location` field ride inside the same blob. | **NO** — free-form JSON slot; zero migration needed. |

---

## Drafts produced

| Filename | One-line purpose |
|---|---|
| `db/migrations/DRAFT_status_code.sql` | `ALTER TABLE documents ADD COLUMN status_code TEXT` + `idx_documents_status_code(status, status_code) WHERE status_code IS NOT NULL` — unblocks API-2's coded error envelope on `/api/status`. |
| `db/migrations/DRAFT_document_attempts.sql` | New `document_attempts` child table (doc_id, attempt_no, is_retry, provider, model, temperature, status, status_code, tokens, duration_ms, created_at) + two indexes. Preps OCR-3 retry telemetry + variance analytics. |

Both files carry a `DRAFT_` filename prefix, an explicit "PM sign-off required" header, the SQLite-dialect notes, and the exact operator apply commands as comments.

---

## Drafts intentionally NOT produced — with audit reason

| Proposed draft | Skipped because |
|---|---|
| `DRAFT_corrections_index.sql` (JSON-path index for `raw_json` filtered on "has corrections") | Audit finds no consumer today. `raw_json` is queried opaquely by id (status) or as a bulk scan (stats aggregations). No `WHERE` filter on "corrections present" exists in any route. Migration debt with no near-term consumer → skip per DB-1 "if in doubt, lean NO" rule. |
| `DRAFT_bbox_hint_persistence.sql` | bbox_hint already persists inside `templates.fields_json`. OCRWorkspace's three auto-save call sites (commit-draw, landscape-invalidation cleanup, high-confidence auto-capture) all POST the entire fields array back to `/api/templates`. Verified via grep — no separate persistence layer needed. |
| `DRAFT_credit_model.sql` / `DRAFT_ai_power_config_vertex.sql` | Both live in `system_settings` (key/value TEXT). New value strings need zero schema change. |
| `DRAFT_system_settings.sql` (add the table to schema.sql properly) | Nice-to-have doc-parity migration. Code creates it defensively via `CREATE TABLE IF NOT EXISTS`; no runtime risk today. Flagged as docs debt, not a DB-1 deliverable. |

---

## PM approval required before apply

**No `wrangler d1 execute` runs happened during this task.** The drafts land as files only. Operator commands (do NOT run until PM approves):

```bash
# Local D1
wrangler d1 execute ocr-db --file=db/migrations/DRAFT_status_code.sql
wrangler d1 execute ocr-db --file=db/migrations/DRAFT_document_attempts.sql

# Production D1
wrangler d1 execute ocr-db --file=db/migrations/DRAFT_status_code.sql --remote
wrangler d1 execute ocr-db --file=db/migrations/DRAFT_document_attempts.sql --remote
```

After apply, the operator (or database agent, next task) must:
1. Rename each file `DRAFT_<name>.sql` → `<name>.sql` (drop prefix so it's part of the canonical migration history).
2. Mirror the end state into `db/schema.sql` (per persona rule #1 — schema.sql tracks the applied canonical shape).
3. Commit both changes in one PR titled "db: apply status_code + document_attempts".

---

## Consumer changes needed after apply (flagged for other agents)

### For `DRAFT_status_code.sql`
- **backend-api / ocr-pipeline** — `src/app/api/upload/route.ts` runOCR catch block (~L554–560) needs to persist a coded error alongside `status='error'`:
    ```ts
    // classify ocrError into ErrorCode (AI_UNAVAILABLE / AI_FAILED / SERVER_ERROR)
    await env.DB.prepare(
      "UPDATE documents SET status = ?, raw_json = ?, status_code = ? WHERE id = ?"
    ).bind("error", JSON.stringify({ error: ocrError.message }), coded, docId).run();
    ```
- **backend-api** — `src/app/api/status/route.ts:23` `SELECT` list extends to include `status_code`, and the response envelope surfaces it so UI-3's `apiError(code)` can render `friendlyError()` for polling-derived errors (parity with the initial POST response).

### For `DRAFT_document_attempts.sql`
- **ocr-pipeline** — `src/app/api/upload/route.ts` runOCR needs one `INSERT INTO document_attempts` per AI call (whole-image + crop pass + any future OCR-3 retry). `ai_usage` writes stay unchanged (billing ground-truth); attempts table is for retry-variance analytics.
- **backend-api / admin dashboards** — new admin view "OCR variance" can query `document_attempts` GROUP BY (provider, is_retry) to answer "does the retry pass help?".

### Non-schema follow-ups
- **docs-manager** — `db/schema.sql` has UTF-16 corruption from the `system_logs` block onward. A plain-ASCII rewrite makes future grep/audit trustworthy. No runtime impact today.
- **database (next task)** — draft a `system_settings.sql` migration that adds the table to `schema.sql` for parity. Non-blocking; code already creates the table defensively.

---

## Cross-agent flags

- **backend-api** — API-2 has a natural delta ticket once `status_code` lands: extend `/api/status` response to carry `code` for the error branch.
- **ocr-pipeline** — OCR-3 (temperature-0.6 retry) has its persistence slot ready (`document_attempts.is_retry`, `.temperature`, `.attempt_no`) once this migration applies.
- **billing-payment** — no DB action from BILL-1; `system_settings.CREDIT_MODEL` fits the existing key/value shape. (But: `system_settings` isn't in `schema.sql` — see schema-drift note above.)
- **AI (AI-1)** — no DB action; `AI_POWER_CONFIG` JSON blob absorbs `provider:"vertex_ai"` + `location` field transparently.
- **docs-manager** — schema.sql UTF-16 corruption flagged above.

---

## Red flags / audit surprises

1. **`system_settings` isn't in `db/schema.sql`.** Two features (BILL-1 CREDIT_MODEL, AI-1 AI_POWER_CONFIG, plus tier-config) all depend on a table that's created only by inline `CREATE TABLE IF NOT EXISTS` in application code. Everything works because of the `IF NOT EXISTS` guard, but the canonical schema is out of sync with runtime. Not a DB-1 fix — flagged as debt.
2. **`db/schema.sql` end-of-file is UTF-16-corrupted** (the `system_logs` CREATE reads as wide characters). Runtime unaffected because the table was seeded before corruption. Blocks future audits with plain `grep` / `Read`.
3. **The observability provenance markers OCR-6b added (`source:"crop"`, `crop_miss`, `crop_no_match`) all live inside `raw_json`** — no schema slot. If we ever want a "% of hints that produced `crop_no_match`" admin chart, we'd either need a JSON-path index (SQLite `->` operator) or a small denormalisation. Not proposed today — no consumer asked, no dashboard designed.
4. **`documents.status` is untyped free-form TEXT** with three known values (`pending`/`completed`/`error`). Adding a fourth state ("retry_pending" for OCR-3) would just be a new string — no schema change needed, but worth flagging for OCR-3 spec discussion.

---

_Author: database agent, 2026-07-09_
