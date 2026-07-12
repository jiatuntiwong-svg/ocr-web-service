# Work orders — docs-manager agent

Sprint: OCR Stabilization. Ongoing duty — no single completion point.

---

## DOC-1 (P1, ongoing) — Keep OCR docs in sync with sprint work

**Do, every time a BOARD task reaches ✅:**
1. Update `docs/OCR_TESTING_LOG.md` — especially §4 (unsolved table): move solved items to §3 style entries with the fix summary.
2. Update `docs/BEHAVIOR_REFERENCE.md` if user-visible behavior changed (page selection, retry, error messages).
3. Update `docs/PENDING_ISSUES.md` — mark H4 quick wins / F4 as done when API-2/API-3/UI-3 land.
4. Cross-check `pm/BOARD.md` status table matches reality; flag stale statuses to the PM.

**Sprint-end deliverable:** `pm/reports/SPRINT-SUMMARY.md` — what shipped, what's still open, pass rates from OCR-2 regression suite, and a recommendation for the next sprint (Compare quality §A vs OCR Rulebase).

---

**Rule reminder:** never mark anything done in docs without verifying against actual code/reports in `pm/reports/`.
