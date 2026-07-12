# Work orders — database agent

Sprint: OCR Stabilization. Update pm/BOARD.md status when you start/finish a task.

---

## DB-1 (P2) — Schema review: corrections / bbox_hint / retry persistence

**Context:** Recent OCR features added data the schema may not capture: `corrections[]` (AI self-reported fixes), `bbox_hint` per template field, retry attempts. Check whether these survive a reload or are UI-state only, and whether that's acceptable.

**Do:**
1. Audit `db/schema.sql` + `db/migrations/*` vs what the OCR flow produces (`documents` table, template field JSON).
2. Answer: (a) are bbox_hints persisted with templates so users don't re-draw them every run? (b) are corrections stored with the document result? (c) where would `isRetry` / attempt count live (needed for future variance analytics)?
3. If gaps exist, write migration proposals (do NOT apply without PM approval) as `db/migrations/DRAFT_*.sql` + note in report.

**Done when:** report in `pm/reports/DB-1.md` with findings + draft migrations if needed.

---

**Added scope (from API-2 follow-up, 2026-07-09):** include in the DB-1 review — `documents.status='error'` rows persist raw AI error strings in `raw_json.error`; API-2 proposed a `status_code TEXT` column on `documents` so `/api/status` can return a proper error code. Draft the migration (DRAFT_*, don't apply) as part of your report.

**Standby otherwise.** No schema changes without a migration file and PM sign-off (see your agent rules).
