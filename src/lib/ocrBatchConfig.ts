// Tunable limits for the multi-file OCR batch flow. Keep every magic number
// for batching in this one file so the UI, runner, and validation messages
// all read from the same source of truth — bumping limits during testing is
// a single-line change.
//
// The batch runner uploads each file as its own /api/upload request (backend
// is unchanged from single-file OCR), polls /api/status for each, and rolls
// every per-file result up into one summary export. See MULTI_FILE_OCR_PLAN
// for the design rationale.

/** Max files the user can queue in a single batch.
 *  Raise this temporarily to test where real limits start (rate limits,
 *  browser memory on export, etc.) — see MULTI_FILE_OCR_PLAN §5.3.
 *  Override locally with NEXT_PUBLIC_MAX_BATCH_FILES in .env.local. */
export const MAX_BATCH_FILES =
    Number(process.env.NEXT_PUBLIC_MAX_BATCH_FILES) || 10;

/** Files processed in parallel. Higher = faster batches but more risk of
 *  Gemini rate-limiting (429). Keep ≤5 unless you have headroom in the AI
 *  config. */
export const OCR_BATCH_CONCURRENCY =
    Number(process.env.NEXT_PUBLIC_OCR_BATCH_CONCURRENCY) || 3;

/** Hard timeout per file before the runner gives up polling and marks the
 *  file errored. Prevents a single stuck job from blocking the rest of the
 *  batch. 2 minutes covers ~95 % of real invoices. */
export const PER_FILE_TIMEOUT_MS = 120_000;

/** /api/status poll interval. Backend writes the result the moment OCR
 *  finishes, so 1 s gives near-real-time feel without flooding the worker. */
export const POLL_INTERVAL_MS = 1000;

/** Max PDF pages a user can select (or that a PDF may contain when no
 *  selection is provided) before /api/upload rejects with `TOO_MANY_PAGES`.
 *  10+ page PDFs take multi-minute AI runs (issue 1.3) — the UI page-picker
 *  (UI-1) forces users to pick ≤ this many pages, and the server enforces
 *  the same ceiling as the last line of defence. Override with
 *  NEXT_PUBLIC_PAGE_SELECTION_MAX in .env.local. */
export const PAGE_SELECTION_MAX =
    Number(process.env.NEXT_PUBLIC_PAGE_SELECTION_MAX) || 5;

/** Threshold (in number of files) above which the single-file UI switches
 *  to the batch UI. 1 still uses the existing single-doc workspace so we
 *  don't regress that UX. */
export const BATCH_UI_THRESHOLD = 2;

/** Max upload size (MB) enforced by /api/upload and /api/v1/extract before
 *  buffering the file (API-3, PENDING_ISSUES §F4). Matches the
 *  "สูงสุด 20MB" copy shown in the upload UI (see i18n `uploadSubtext`).
 *  Larger files can OOM the canvas / Worker on rasterization, and burn
 *  credits before rejection — so the guard runs BEFORE credit deduction,
 *  R2 upload, and arrayBuffer(). Tune here to change both routes at once.
 *  Override with NEXT_PUBLIC_MAX_UPLOAD_SIZE_MB in .env.local. */
export const MAX_UPLOAD_SIZE_MB =
    Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_SIZE_MB) || 20;

/** Derived byte limit for the size comparison — File.size is bytes. */
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
