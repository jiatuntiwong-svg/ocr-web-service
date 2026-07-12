# API-3 — Upload size guard (F4)

**Status:** review · **Sprint:** OCR Stabilization

## Summary
Both `/api/upload` and `/api/v1/extract` reject files > 20 MB before any credit deduction, R2 write, or `arrayBuffer()` allocation. Uses `File.size` from the multipart part so oversized payloads never touch the Worker's memory. Frontend copy already advertises "สูงสุด 20MB" — server now honors it.

## Files changed

### `src/lib/errorCodes.ts`
Added `FILE_TOO_LARGE` code (HTTP 413).

### `src/lib/ocrBatchConfig.ts`
Added `MAX_UPLOAD_SIZE_MB = 20` + derived `MAX_UPLOAD_SIZE_BYTES`. Env-tunable via `NEXT_PUBLIC_MAX_UPLOAD_SIZE_MB` alongside `PAGE_SELECTION_MAX`.

### `src/app/api/upload/route.ts`
Guard block (lines 114–132) sits immediately after `file` presence check and BEFORE:
- Credit pre-authorization
- Feature gate
- R2 upload
- DB insert
- AI call

Logs `UPLOAD_TOO_LARGE` at info level with `auth.id`, `file.name`, actual MB, and byte count so admins can spot repeat offenders.

### `src/app/api/v1/extract/route.ts`
Same guard block (lines 25–44), same placement discipline. Public API gets identical protection — this is a memory-safety constraint, not a hint-support one, so it's universal (unlike bbox_hint which stays frontend-only per OCR-4).

## Error payload shape
```json
{
  "ok": false,
  "code": "FILE_TOO_LARGE",
  "vars": { "limit": 20, "actual": 42 }
}
```
`limit` and `actual` are integers in MB. Frontend renders via `apiError()` → `errorCodes.FILE_TOO_LARGE` in the i18n catalog (UI-3 added the key).

## Where the check sits in the request lifecycle
1. Parse formData
2. Extract `file` and validate presence
3. **← size guard (this task)**
4. Credit pre-authorization
5. R2 upload
6. AI call

Placement rationale: rejects before any billable/allocating work. Order matters — if we buffered first we'd defeat the whole point.

## Backward compatibility
Files ≤ 20 MB behave exactly as before. Files > 20 MB now get a clean `413 FILE_TOO_LARGE` instead of a Worker OOM or a mid-flight failure.

## Verification
- `npx tsc --noEmit` — clean.
- `npm run build` — clean.
- Empirical test of an oversized upload deferred to operator (not exercised in-agent — no way to safely allocate a >20 MB test payload here).

## Follow-up (done in parallel task UI-3)
- `errors.fileTooLarge` copy + `errorCodes.FILE_TOO_LARGE` mapping landed via UI-3. No frontend work remaining.
