// MIME type normalization for uploaded files.
//
// Critical for API-5 (external callers use `application/octet-stream` by
// default when they don't set `-F 'file=@x;type=image/png'`; the UI uses
// proper mime). Existing `file.type || "image/png"` returns "octet-stream"
// (truthy!) so downstream providers reject the payload with 400 even when
// the file is a valid PNG/PDF.
//
// Contract: return a browser-standard mimeType we know how to pass to the
// AI provider, or `null` when we can't tell — caller decides what to do
// (typically return INVALID_FORMAT).
//
// Backward-compat: if `file.type` is a real (non-octet) mimeType we
// pass it through unchanged, so existing UI callers keep byte-identical
// behavior with the pre-normalization path.

export const SUPPORTED_MIME_EXTENSIONS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".pdf",
    ".gif",
] as const;

/** Human-readable list for user-facing error messages. */
export const SUPPORTED_MIME_EXTENSIONS_LABEL = ".png/.jpg/.jpeg/.webp/.pdf";

const EXTENSION_MIME_MAP: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    pdf: "application/pdf",
    gif: "image/gif",
};

/**
 * Normalize the MIME type of a File-like object.
 *
 * - If `file.type` is present AND not `application/octet-stream` → return as-is.
 * - Else derive from the filename extension (case-insensitive).
 * - If neither works → return `null` (caller decides — usually INVALID_FORMAT).
 *
 * We deliberately do NOT default to `"image/png"` when both signals are
 * absent: that hides genuine bad uploads (e.g. a random `.txt`) behind a
 * confusing downstream AI error. The old `file.type || "image/png"`
 * pattern is what this helper replaces everywhere it appears.
 */
export function normalizeMimeType(file: { name?: string; type?: string } | null | undefined): string | null {
    if (!file) return null;
    const rawType = (file.type || "").trim().toLowerCase();
    if (rawType && rawType !== "application/octet-stream") {
        // Trust the browser/client-provided value verbatim (may include
        // charset params — that's fine, providers ignore them).
        return file.type as string;
    }
    const name = (file.name || "").toLowerCase();
    const dotIdx = name.lastIndexOf(".");
    if (dotIdx < 0 || dotIdx === name.length - 1) return null;
    const ext = name.slice(dotIdx + 1);
    return EXTENSION_MIME_MAP[ext] ?? null;
}
