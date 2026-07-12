# Work orders — devops-cloudflare agent

Sprint: OCR Stabilization. Update pm/BOARD.md status when you start/finish a task.

---

## OPS-1 (P1) — Verify OCR path in workerd + limits check

**Context:** OCR fixes this sprint (page selection, retry, size guard) all touch the Workers runtime. Past incidents: batch mode produced different results than single-file because server-side rendering differed (testing log §2.4); admin logs broke due to `process.env.DB`. Local `next dev` does not catch these.

**Do:**
1. Run the full OCR flow (single + batch, PDF + image) in `npm run preview` (workerd) and compare against `next dev` behavior. Document any divergence.
2. Measure/document Workers limits relevant to OCR: request body size (informs API-3 cap), CPU time on 3600px PNG handling, memory headroom, sub-request counts. Note where current usage sits vs limits.
3. Confirm `nodejs_compat` covers everything the OCR path imports (esp. if `word-extractor` lands later).
4. Set up a repeatable smoke-check: short doc (`pm/reports/OPS-1.md`) listing the commands + `wrangler tail` filters to debug production OCR issues.

**Done when:** report in `pm/reports/OPS-1.md` with limit numbers, divergences found, and the recommended upload size cap for API-3.

---

**Gate duty:** before the sprint closes, every OCR change must have been exercised once in `npm run preview`. You are the sign-off on the BOARD's last Definition-of-Done checkbox.
