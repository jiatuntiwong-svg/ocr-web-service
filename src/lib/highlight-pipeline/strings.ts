// String utilities shared by validators + search.
//
// The pipeline runs entirely client-side and against short field values
// (rarely > 200 chars), so we hand-roll the few primitives we need instead
// of pulling a dep. Levenshtein here is the textbook DP version — O(m*n)
// time, O(min(m,n)) space; plenty fast for our inputs.

/** Normalize a string for fuzzy comparison: lowercase, trim, collapse
 *  whitespace runs to a single space. We deliberately KEEP punctuation —
 *  "1,234.50" vs "1234.50" should still differ — but ignore casing and
 *  whitespace noise that text-layer extraction sometimes injects. */
export function normalize(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Pure equality after normalization. */
export function normalizedEqual(a: string, b: string): boolean {
    return normalize(a) === normalize(b);
}

/** Substring check after normalization (used by search step). */
export function normalizedIncludes(haystack: string, needle: string): boolean {
    const n = normalize(needle);
    if (!n) return false;
    return normalize(haystack).includes(n);
}

/** Levenshtein edit distance — number of single-char insertions, deletions,
 *  substitutions to transform a into b. Operates on already-normalized
 *  strings; callers normalize first to avoid double work. */
export function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    // Swap so the shorter string drives the inner loop — saves memory.
    if (a.length > b.length) { const t = a; a = b; b = t; }
    const prev = new Array(a.length + 1);
    const curr = new Array(a.length + 1);
    for (let i = 0; i <= a.length; i++) prev[i] = i;
    for (let j = 1; j <= b.length; j++) {
        curr[0] = j;
        for (let i = 1; i <= a.length; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[i] = Math.min(
                curr[i - 1] + 1,        // insertion
                prev[i] + 1,            // deletion
                prev[i - 1] + cost,     // substitution
            );
        }
        for (let i = 0; i <= a.length; i++) prev[i] = curr[i];
    }
    return prev[a.length];
}

/** Tunable similarity check. Used as the second-tier fallback when
 *  normalized exact fails. Threshold = min(3, ceil(len * 0.15)):
 *   - allows up to 3 edits absolute (handles "Bangkok" vs "Bankok")
 *   - or 15% of the string length, whichever is smaller
 *  — so a 30-char address still tolerates ~3 typos, but a 4-char number
 *  field doesn't fuzz-match a different number. */
export function fuzzyEqual(a: string, b: string): boolean {
    const na = normalize(a), nb = normalize(b);
    if (na === nb) return true;
    const ref = Math.min(na.length, nb.length);
    if (ref < 3) return false; // too short to fuzz-match safely
    const threshold = Math.min(3, Math.ceil(ref * 0.15));
    return levenshtein(na, nb) <= threshold;
}
