# API-4b item 4 — MIME normalization

**Status:** 👀 review (2026-07-13)
**Deploy:** NOT deployed — awaiting PM approval on top of `ce949a8c` (API-4b defects 1-3 already in prod).
**Branch state:** working tree only. `npx tsc --noEmit` clean, `npm run build` clean (43 routes).

## Origin

UAT (2026-07-13): a healthy AI key returned HTTP 400 when the client hit
`/api/v1/extract` via `curl` without an explicit MIME override. Root cause:

- `curl -F 'file=@x.png'` (no `;type=…`) sends the part with
  `Content-Type: application/octet-stream`.
- Every image-payload site in the API used the pattern
  `file.type || "image/png"`. `"application/octet-stream"` is truthy, so the
  fallback never triggered — the octet-stream string was forwarded straight
  to the AI provider, which rejects it as an unrecognised image format.
- Net effect: healthy key + valid PNG/PDF → opaque 400 to the external caller.

This is a blocker for **API-5** (external SaaS API) where octet-stream is the
common case, not the corner case.

## Call sites found

`grep 'file\.type \|\|'` across the codebase surfaced four buggy occurrences
and one internal (crop) site:

| File | Line (pre-fix) | Fallback used | Fixed? |
|------|----------------|---------------|--------|
| `src/app/api/v1/extract/route.ts` | 299 | `"image/png"` | ✅ replaced with `normalizedMime`, guarded up front |
| `src/app/api/upload/route.ts` | 342, 359, 398 | `"image/png"` | ✅ replaced with `normalizedMime` (single guard up front) |
| `src/app/api/upload/route.ts` | 163 (crop blobs) | `"image/png"` | ✅ replaced with `normalizeMimeType(f) ?? "image/png"` — safe because crops are client-generated PNGs |
| `src/app/api/compare/route.ts` | 317 | `"image/jpeg"` | ✅ replaced with `normalizedMimes[i]`, guarded up front |
| `src/lib/excel-parser.ts` | 105 | `""` | ⏭ untouched — pre-existing case-insensitive lowercase compare on Excel MIME family, not a fallback bug |
| `src/lib/frontend-ocr.ts`, `src/lib/highlight-pipeline/*.ts`, `src/components/*.tsx` | various | `=== "application/pdf"` checks | ⏭ untouched — these check for a specific mime, not a fallback |

## Helper design

New module: `src/lib/mime.ts`

```ts
export function normalizeMimeType(file: { name?: string; type?: string } | null | undefined): string | null
```

Logic:

1. If `file.type` is a non-empty string that is NOT
   `application/octet-stream` → return it verbatim (BC — UI callers keep
   byte-identical behavior with the pre-normalization path).
2. Else look at the last `.<ext>` in `file.name` (case-insensitive):
   - `.png` → `image/png`
   - `.jpg` / `.jpeg` → `image/jpeg`
   - `.webp` → `image/webp`
   - `.pdf` → `application/pdf`
   - `.gif` → `image/gif` (nice-to-have)
3. Otherwise return `null` — caller returns `INVALID_FORMAT` with a
   helpful message.

**Design note — no `"image/png"` last-resort default.** The task allowed
one, but silently coercing a random `.txt` upload to PNG hides genuine bad
uploads behind a confusing downstream AI error. Returning `null` and
letting the caller fail fast with `INVALID_FORMAT` is safer and matches
the "helpful message for genuinely unsupported extensions" ask.

Also exported: `SUPPORTED_MIME_EXTENSIONS_LABEL = ".png/.jpg/.jpeg/.webp/.pdf"`
so future UI copy can stay in sync with the helper.

## Error code choice — `INVALID_FORMAT`, not `BAD_REQUEST`

The spec suggested `BAD_REQUEST`. I picked `INVALID_FORMAT` because:

- It's already HTTP 400 with a mapped `STATUS_FOR_CODE` entry.
- Its i18n message is already user-facing and format-specific.
- The alternative — `BAD_REQUEST` + `vars: { reason: "..." }` — would
  require reworking the `interpolate()` regex behavior in
  `src/lib/i18n/LocaleContext.tsx` because it leaves unmatched `{var}`
  literal in the string (see `LocaleContext.tsx:32`), so a caller without
  the var would see raw `{reason}`.

Updated three co-located strings for consistency:

- `src/lib/i18n/locales/en.ts` — `errorCodes.INVALID_FORMAT` → adds
  accepted extension list.
- `src/lib/i18n/locales/th.ts` — same, Thai.
- `src/lib/apiResponse.ts` — `FALLBACK_MESSAGE.INVALID_FORMAT` — kept in
  sync (server BC fallback string on `.error`).

Byte-identical for callers who send a proper MIME type — the only
behavior change is on octet-stream / unknown extensions (which used to
either 400 opaquely or coerce to PNG downstream).

## API-5 prep

Code comment at each guard site references API-5:

- `src/app/api/upload/route.ts` — "Critical for API-5 (external callers
  use `application/octet-stream` by default; UI uses proper mime)."
- `src/app/api/v1/extract/route.ts` — same.
- `src/app/api/compare/route.ts` — "external callers (API-5 prep) will
  hit this endpoint too."
- `src/lib/mime.ts` — module-level header describing the octet-stream
  bug + API-5 context.

## Files touched

- `src/lib/mime.ts` — **new** helper module.
- `src/lib/i18n/locales/en.ts` — `INVALID_FORMAT` string (extensions list).
- `src/lib/i18n/locales/th.ts` — `INVALID_FORMAT` string (extensions list).
- `src/lib/apiResponse.ts` — `FALLBACK_MESSAGE.INVALID_FORMAT` string.
- `src/app/api/upload/route.ts` — import + up-front guard + 3 payload sites + 1 crop site.
- `src/app/api/v1/extract/route.ts` — import + up-front guard + 1 payload site.
- `src/app/api/compare/route.ts` — import + up-front guard + payload map.
- `pm/BOARD.md` — API-4b row extended with "item 4 landed" note.

## Guard placement rationale

Each route runs `normalizeMimeType` BEFORE any credit charge, R2 write, or
DB row insert. An unsupported extension therefore costs zero credits and
leaves no side effects — same discipline as the size guard next to it.

## Verify

- `npx tsc --noEmit` → exit 0.
- `npm run build` → clean, 43 routes.
- `grep -rn 'file\.type \|\| \"image'` → only comments/docs (no code call
  sites remain).

## Curl test plan (not executed — needs prod)

### Test 1 — Reproduce the UAT bug is gone

```bash
# Before fix: fails 400 with opaque code even though the PNG is valid.
# After  fix: returns ok:true (or code=INVALID_FORMAT if the file really is
#             unsupported — but a valid .png reaches the AI provider).
curl -sS -X POST https://<host>/api/v1/extract \
  -F email=admin@example.com -F password=... \
  -F file=@fixture.png \                   # no ;type= — sends octet-stream
  -F total_pages=1 -F pages='[1]' \
  -F fields='ชื่อบริษัท, ยอดรวม'
```

**Expected (after fix):** `{ "ok": true, "data": { ... } }`. `wrangler tail`
should NOT show `INVALID_FORMAT` for this request.

### Test 2 — Genuinely unsupported extension returns helpful message

```bash
curl -sS -X POST https://<host>/api/v1/extract \
  -F email=admin@example.com -F password=... \
  -F file=@fixture.txt \
  -F total_pages=1 -F pages='[1]' \
  -F fields='x'
```

**Expected:** HTTP 400 body
`{ "ok": false, "code": "INVALID_FORMAT", "error": "Unsupported file format — accepts .png/.jpg/.jpeg/.webp/.pdf." }`.

### Test 3 — Explicit MIME override still works (BC gate)

```bash
curl -sS -X POST https://<host>/api/v1/extract \
  -F email=admin@example.com -F password=... \
  -F 'file=@fixture.pdf;type=application/pdf' \
  -F mode=fulldoc -F total_pages=1 -F pages='[1]'
```

**Expected:** identical to pre-fix success response — the helper returns
`"application/pdf"` verbatim when it's already valid.

### Test 4 — /api/upload (UI happy path unchanged)

Any existing UI upload — which sends proper `image/png` / `application/pdf`
`file.type` values — must return byte-identical success responses. Any
regression = STOP.

## Known non-goals / follow-ups

- The `INVALID_FORMAT` message is static (no interpolation). If we ever
  want per-endpoint variation ("Compare accepts X", "Upload accepts Y"),
  add per-code vars — out of scope here.
- `src/lib/excel-parser.ts` still uses `(file.type || "").toLowerCase()`
  — that's a case-insensitive check across a known Excel MIME family,
  not the buggy fallback pattern. Left alone.
- No new dependencies, no schema changes.
