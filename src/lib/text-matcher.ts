// Pure text matcher — no Node deps, runs in any JS runtime (browser, Worker, Node).
// Used by the frontend (CompareWorkspace) to map AI-extracted values back to
// OCR token positions for highlight rendering. Keeping this module dep-free
// is what makes the Cloudflare Worker bundle stay small.
import { OCRToken } from "./types";

// ─── Text normalization ────────────────────────────────────────────────────
const THAI_DIGIT_MAP: Record<string, string> = {
    "๐":"0","๑":"1","๒":"2","๓":"3","๔":"4",
    "๕":"5","๖":"6","๗":"7","๘":"8","๙":"9",
};

export function normalizeStr(s: string): string {
    if (!s) return "";
    let out = s.normalize("NFC");
    out = out.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF\u00A0\u3000]/g, "");
    out = out.replace(/[๐-๙]/g, (c) => THAI_DIGIT_MAP[c] || c);
    out = out.toLowerCase().replace(/[^\w\s฀-๿0-9]/g, " ").replace(/\s+/g, " ").trim();
    return out;
}

function isThaiHeavy(s: string): boolean {
    if (!s) return false;
    let thai = 0, alnum = 0;
    for (const ch of s) {
        if (/[฀-๿]/.test(ch)) thai++;
        else if (/[a-z0-9]/i.test(ch)) alnum++;
    }
    const total = thai + alnum;
    return total > 0 && thai / total >= 0.5;
}

// ─── Similarity helpers ────────────────────────────────────────────────────
function fuzzyScore(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;
    if (a.length === 1 && b.length === 1) return a === b ? 1 : 0;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    if (longer.includes(shorter) && shorter.length / longer.length >= 0.7) {
        return shorter.length / longer.length;
    }
    const set = new Set<string>();
    for (let i = 0; i < longer.length - 1; i++) set.add(longer.slice(i, i + 2));
    let overlap = 0;
    for (let i = 0; i < shorter.length - 1; i++) {
        if (set.has(shorter.slice(i, i + 2))) overlap++;
    }
    const denom = longer.length + shorter.length - 2;
    return denom > 0 ? (2 * overlap) / denom : 0;
}

function ngramSet(s: string, n: number): Set<string> {
    const set = new Set<string>();
    if (!s) return set;
    if (s.length < n) { set.add(s); return set; }
    for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
    return set;
}

type NormalizedToken = OCRToken & { cleanText: string };

// ─── Adaptive layout metrics ──────────────────────────────────────────────
// Row/word/cluster thresholds are NOT fixed page-fractions: a constant tuned
// to one document over- or under-merges another with denser or larger text
// (a dense block once merged the date line into "อ้างอิ" below it). Each
// threshold is instead derived from the document's OWN median glyph
// dimensions — scale-free — then clamped to a safe band. Factors are anchored
// to the measured glyph stats of the validation documents, so a typical
// document reproduces the values this matcher was verified with
// (yTol≈0.022, wordGap≈0.018, clusterGap≈0.05).
interface RowMetrics {
    yTol: number;       // same-row Y tolerance (former READ_Y_TOL)
    wordGap: number;    // gap above which same-row tokens are separate words
    clusterGap: number; // gap marking a column / phrase break
}

const DEFAULT_METRICS: RowMetrics = { yTol: 0.022, wordGap: 0.018, clusterGap: 0.05 };

function computeRowMetrics(toks: { width: number; height: number }[]): RowMetrics {
    const med = (arr: number[]): number => {
        const s = arr.filter(v => v > 0).sort((a, b) => a - b);
        return s.length ? s[s.length >> 1] : 0;
    };
    const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
    const medH = med(toks.map(t => t.height));
    const medW = med(toks.map(t => t.width));
    if (medH <= 0 || medW <= 0) return DEFAULT_METRICS;
    // medH×0.75: same line ⇒ token tops within ~¾ of a median glyph height
    // (the median includes tall tokens; the line jitter is smaller).
    // medW×1.7: a space is wider than one OCR-fragmented glyph advance.
    // wordGap×2.8: a real layout gap (table column, label↔value) is several
    // word-gaps. All clamped so a degenerate token set stays in a safe band.
    const yTol = clamp(medH * 0.75, 0.012, 0.032);
    const wordGap = clamp(medW * 1.7, 0.008, 0.032);
    const clusterGap = clamp(wordGap * 2.8, 0.030, 0.085);
    return { yTol, wordGap, clusterGap };
}

// A "run" is a re-assembled word: a sequence of glyph tokens on the same
// visual row whose horizontal gaps are smaller than a space. Tesseract emits
// Thai as per-glyph tokens (stacked vowels at slightly different y); grouping
// them back into word-runs makes substring search exact AND yields one tight
// bounding box per word instead of many scattered glyph boxes.
interface GlyphRun {
    cleanText: string;          // concatenated, no-space, normalized
    members: NormalizedToken[]; // original glyph tokens (for box mapping)
}

function assembleRuns(pageToks: NormalizedToken[], m: RowMetrics): GlyphRun[] {
    if (pageToks.length === 0) return [];
    const sorted = [...pageToks].sort((a, b) =>
        Math.abs(a.y - b.y) > m.yTol ? a.y - b.y : a.x - b.x);
    const runs: GlyphRun[] = [];
    let cur: NormalizedToken[] = [sorted[0]];

    const flush = () => {
        const cleanText = cur.map(t => t.cleanText).join("");
        if (cleanText) runs.push({ cleanText, members: cur });
    };

    for (let i = 1; i < sorted.length; i++) {
        const prev = cur[cur.length - 1];
        const t = sorted[i];
        const sameRow = Math.abs(t.y - prev.y) <= m.yTol;
        const gap = t.x - (prev.x + prev.width);
        // Same word if on same row and gap is below a space width. Negative
        // gap (overlap, e.g. stacked Thai vowel) also counts as same word.
        if (sameRow && gap < m.wordGap) {
            cur.push(t);
        } else {
            flush();
            cur = [t];
        }
    }
    flush();
    return runs;
}

// Group word-runs into visual rows (consecutive runs whose member-y stays
// within m.yTol). Runs come from assembleRuns already in reading order.
function assembleRows(pageToks: NormalizedToken[], m: RowMetrics): GlyphRun[][] {
    const runs = assembleRuns(pageToks, m);
    if (runs.length === 0) return [];
    const rowY = (r: GlyphRun) => r.members[0].y;
    const rows: GlyphRun[][] = [];
    let cur: GlyphRun[] = [runs[0]];
    let curY = rowY(runs[0]);
    for (let i = 1; i < runs.length; i++) {
        if (Math.abs(rowY(runs[i]) - curY) <= m.yTol) {
            cur.push(runs[i]);
        } else {
            rows.push(cur);
            cur = [runs[i]];
            curY = rowY(runs[i]);
        }
    }
    rows.push(cur);
    return rows;
}

// Robust matcher scoped to a SINGLE visual row. Tesseract fragments Thai into
// per-glyph tokens; assembleRuns rebuilds words, assembleRows bounds the
// search to one line so a match can never bleed into the line above/below
// (which caused "วันครบกำหนด" leaks and scattered boxes). For each row we try
// an exact substring of the value, else a contiguous run window with enough
// value-trigram coverage; the span is trimmed to value-bearing runs only.
function matchByPageText(
    value: string,
    tokens: OCRToken[],
    counterparts: string[]
): MatchResult {
    const valueNoSpace = normalizeStr(value).replace(/\s+/g, "");
    if (valueNoSpace.length < 3) return { tokens: [], confidence: 0 };

    // Digit-heavy values (totals, amounts, doc numbers) need a position-based
    // digit match: OCR substitutes single digits (7→1, 6→8), which destroys
    // trigrams (one bad digit kills 3 grams) but barely dents positional
    // digit overlap — so "79,180.00" survives even when read "1918000".
    const valDigits = valueNoSpace.replace(/[^0-9]/g, "");
    const digitHeavy = valDigits.length >= 4 &&
        valDigits.length / valueNoSpace.length >= 0.6;

    const counterNoSpace = counterparts
        .map(c => normalizeStr(c).replace(/\s+/g, ""))
        .filter(c => c.length >= 3 && c !== valueNoSpace);

    const byPage = new Map<number, NormalizedToken[]>();
    for (const t of tokens) {
        const cleanText = normalizeStr(t.text).replace(/\s+/g, "");
        if (!cleanText) continue;
        const nt: NormalizedToken = { ...t, cleanText };
        if (!byPage.has(t.page)) byPage.set(t.page, []);
        byPage.get(t.page)!.push(nt);
    }

    const valGrams = ngramSet(valueNoSpace, 3);
    const runCarries = (run: GlyphRun) => {
        const txt = run.cleanText;
        if (!txt) return false;
        if (valueNoSpace.includes(txt) && txt.length >= 2) return true;
        if (txt.length >= 3) {
            for (let k = 0; k + 3 <= txt.length; k++) {
                if (valGrams.has(txt.slice(k, k + 3))) return true;
            }
        } else if (valueNoSpace.includes(txt)) return true;
        return false;
    };

    type Hit = {
        tokens: NormalizedToken[]; score: number; nearCounter: boolean;
        trace: MatchTrace;
    };
    let best: Hit | null = null;

    // Adaptive thresholds derived from THIS document's own glyph statistics.
    const metrics = computeRowMetrics(tokens);

    for (const pageToks of byPage.values()) {
        const rows = assembleRows(pageToks, metrics);

        for (const row of rows) {
            // Per-row concat + char→run map (run index is row-local)
            let rowText = "";
            const charRun: number[] = [];
            for (let r = 0; r < row.length; r++) {
                const txt = row[r].cleanText;
                for (let j = 0; j < txt.length; j++) charRun.push(r);
                rowText += txt;
            }
            if (rowText.length < 3) continue;

            const nearCounter = counterNoSpace.some(c => rowText.includes(c));

            // Collect member tokens for run span [rs..re], trimmed to the
            // first..last run that actually carries the value.
            const collect = (cStart: number, cEnd: number): NormalizedToken[] => {
                let rs = charRun[Math.max(0, cStart)];
                let re = charRun[Math.min(rowText.length - 1, cEnd)];
                while (rs <= re && !runCarries(row[rs])) rs++;
                while (re >= rs && !runCarries(row[re])) re--;
                if (rs > re) { rs = charRun[Math.max(0, cStart)]; re = charRun[Math.min(rowText.length - 1, cEnd)]; }
                const out: NormalizedToken[] = [];
                for (let r = rs; r <= re; r++) out.push(...row[r].members);
                return out;
            };
            // Keep only the densest contiguous x-cluster. collect() can
            // bridge a coincidental run elsewhere on the (y-assembled) row
            // (e.g. another "2026"); splitting by x-gap and keeping the
            // cluster with the most value-trigram coverage drops that
            // outlier so we get ONE tight box, not two. The x-gap threshold
            // (CLUSTER_GAP) is the document-adaptive metrics.clusterGap.
            // value-trigram coverage score for a token group (shared by the
            // Y-band and X-cluster selectors). Higher = more of the value.
            const covScore = (group: NormalizedToken[]): number => {
                const txt = [...group].sort((a, b) => a.x - b.x)
                    .map(t => t.cleanText).join("");
                let cov = 0;
                for (let k = 0; k + 3 <= txt.length; k++) {
                    if (valGrams.has(txt.slice(k, k + 3))) cov++;
                }
                return cov * 100 + group.length; // tie-break: longer real span
            };

            // Y-cohesion: a matched value occupies ONE text line. assembleRows
            // can over-merge tightly-spaced lines (Thai ascenders/tone marks of
            // the next line fall near this baseline), so collect() may bridge a
            // glyph from the line above/below. Split the span into Y-bands and
            // keep the line with the most value coverage. The band tolerance is
            // derived from THIS span's own median glyph height (scale-free, no
            // page-fraction magic constant) so it generalises across documents
            // of any resolution/zoom — not tuned to the test invoice.
            const densestRow = (toks: NormalizedToken[]): NormalizedToken[] => {
                if (toks.length <= 1) return toks;
                const hs = toks.map(t => t.height).filter(h => h > 0).sort((a, b) => a - b);
                const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
                if (medH <= 0) return toks;
                const yTol = medH * 0.6;
                const cy = (t: NormalizedToken) => t.y + t.height / 2;
                const s = [...toks].sort((a, b) => cy(a) - cy(b));
                const bands: NormalizedToken[][] = [[s[0]]];
                for (let k = 1; k < s.length; k++) {
                    const last = bands[bands.length - 1];
                    if (cy(s[k]) - cy(last[last.length - 1]) > yTol) bands.push([s[k]]);
                    else last.push(s[k]);
                }
                if (bands.length === 1) return toks;
                let bestB = bands[0], bestS = -1;
                for (const b of bands) {
                    const sc = covScore(b);
                    if (sc > bestS) { bestS = sc; bestB = b; }
                }
                return bestB;
            };

            const CLUSTER_GAP = metrics.clusterGap;
            const densestCluster = (toks: NormalizedToken[]): NormalizedToken[] => {
                if (toks.length <= 1) return toks;
                const s = [...toks].sort((a, b) => a.x - b.x);
                const clusters: NormalizedToken[][] = [[s[0]]];
                for (let k = 1; k < s.length; k++) {
                    const prev = s[k - 1];
                    const gap = s[k].x - (prev.x + prev.width);
                    if (gap > CLUSTER_GAP) clusters.push([s[k]]);
                    else clusters[clusters.length - 1].push(s[k]);
                }
                if (clusters.length === 1) return toks;
                let bestC = clusters[0], bestCov = -1;
                for (const c of clusters) {
                    const scoreC = covScore(c);
                    if (scoreC > bestCov) { bestCov = scoreC; bestC = c; }
                }
                return bestC;
            };
            const consider = (
                toksRaw: NormalizedToken[], score: number,
                info: Pick<MatchTrace, "path" | "matchedText" | "coverage">,
            ) => {
                // Drop cross-line leaks first (Y), then coincidental X outliers.
                const afterRow = densestRow(toksRaw);
                const toks = densestCluster(afterRow);
                if (toks.length === 0) return;
                const adj = nearCounter ? score * 0.7 : score;
                if (!best || adj > best.score) {
                    best = {
                        tokens: toks, score: adj, nearCounter,
                        trace: {
                            ...info, nearCounter,
                            rowText: rowText.slice(0, 120),
                            rowDropped: toksRaw.length - afterRow.length,
                            clusterDropped: afterRow.length - toks.length,
                        },
                    };
                }
            };

            // 1) Exact substring (incl. run-assembled "79,180"+".00")
            const idx = rowText.indexOf(valueNoSpace);
            if (idx >= 0) {
                consider(collect(idx, idx + valueNoSpace.length - 1), 0.95, {
                    path: "page-exact",
                    matchedText: rowText.slice(idx, idx + valueNoSpace.length),
                });
                continue;
            }

            // 2) Fuzzy: best trigram-density window within THIS row only.
            // Rank by DISTINCT value-trigrams covered, not raw hits — else a
            // common repeated gram (e.g. "000" in a products table) outscores
            // the true location of a number like "79,180.00". Distinct
            // coverage is information-weighted and script-agnostic.
            if (valGrams.size > 0) {
                const win = valueNoSpace.length;
                let bw = { start: -1, distinct: 0 };
                for (let i = 0; i + 3 <= rowText.length; i++) {
                    if (!valGrams.has(rowText.slice(i, i + 3))) continue;
                    const seen = new Set<string>();
                    const limit = Math.min(rowText.length - 2, i + win);
                    for (let j = i; j < limit; j++) {
                        const g = rowText.slice(j, j + 3);
                        if (valGrams.has(g)) seen.add(g);
                    }
                    if (seen.size > bw.distinct) bw = { start: i, distinct: seen.size };
                }
                if (bw.start >= 0) {
                    // Grow the span past OCR-inserted junk: keep extending
                    // while a value-trigram reappears within an adaptive gap
                    // (derived from the value's OWN length, not a fixed
                    // constant). A rigid value-length window drops trailing
                    // parts like "(Net 30)" when OCR padded the middle with
                    // noise, making the two docs cover unequal extents. The
                    // downstream collect()/densestRow/densestCluster/edge-trim
                    // re-tighten, so over-reaching here is safe.
                    const gapLimit = Math.max(6, Math.round(win * 0.5));
                    const hardEnd = Math.min(rowText.length - 1, bw.start + win * 3);
                    let lastHit = bw.start;
                    const seen = new Set<string>();
                    for (let j = bw.start; j + 3 <= rowText.length && j <= hardEnd; j++) {
                        const g = rowText.slice(j, j + 3);
                        if (valGrams.has(g)) { lastHit = j + 2; seen.add(g); }
                        else if (j - lastHit > gapLimit) break;
                    }
                    const coverage = seen.size / valGrams.size;
                    if (coverage >= 0.5) {
                        const end = Math.min(rowText.length - 1, lastHit);
                        consider(collect(bw.start, end), Math.min(0.9, coverage), {
                            path: "page-fuzzy",
                            matchedText: rowText.slice(bw.start, end + 1),
                            coverage: +Math.min(1, coverage).toFixed(3),
                        });
                    }
                }
            }

            // 3) Numeric path: align the value's digit stream against the
            // row's digit stream by position (substitution-tolerant). This
            // rescues numbers that exact+trigram miss because OCR garbled a
            // digit. Selective by nature — a specific N-digit sequence rarely
            // aligns ≥50% against unrelated digits (e.g. a products table),
            // so it does NOT reintroduce the repeated-"000" false match.
            if (digitHeavy) {
                let rowDigits = "";
                const digCol: number[] = []; // rowDigits idx → rowText col
                for (let c = 0; c < rowText.length; c++) {
                    const ch = rowText[c];
                    if (ch >= "0" && ch <= "9") { rowDigits += ch; digCol.push(c); }
                }
                const L = valDigits.length;
                if (rowDigits.length >= L) {
                    // Rank a window by total aligned digits, then by the
                    // LONGEST contiguous aligned run. A real total garbled by
                    // OCR keeps a long correct run (one substitution → one
                    // break); a coincidental digit run (e.g. a VAT amount that
                    // an over-merged row glued next to other digits) aligns
                    // the same count but in scattered pieces → shorter run.
                    // This breaks ratio ties toward the true location.
                    let bestStart = -1, bestMatches = 0, bestRun = 0;
                    for (let s = 0; s + L <= rowDigits.length; s++) {
                        let m = 0, run = 0, maxRun = 0;
                        for (let k = 0; k < L; k++) {
                            if (rowDigits[s + k] === valDigits[k]) {
                                m++; run++; if (run > maxRun) maxRun = run;
                            } else run = 0;
                        }
                        if (m > bestMatches || (m === bestMatches && maxRun > bestRun)) {
                            bestMatches = m; bestRun = maxRun; bestStart = s;
                        }
                    }
                    const ratio = bestStart >= 0 ? bestMatches / L : 0;
                    if (ratio >= 0.5) {
                        const c0 = digCol[bestStart];
                        const c1 = digCol[bestStart + L - 1];
                        // run length feeds the score so the longer-run window
                        // also wins ACROSS rows (consider() keeps the max).
                        const score = 0.55 + ratio * 0.30 + (bestRun / L) * 0.05;
                        consider(collect(c0, c1), Math.min(0.9, score), {
                            path: "page-digits",
                            matchedText: rowText.slice(c0, c1 + 1),
                            coverage: +ratio.toFixed(3),
                        });
                    }
                }
            }
        }
    }

    if (!best) {
        return { tokens: [], confidence: 0, trace: { path: "none", metrics } };
    }
    const chosen: Hit = best;
    chosen.trace.metrics = metrics; // surface adaptive thresholds for debug

    // Edge-trim: collect()/run-assembly works at run granularity, so a glyph
    // from an adjacent label ("(Date)") or a leaked next-line glyph that got
    // merged INTO a value-bearing run survives and widens the box on one side.
    // Drop leading/trailing tokens that contribute NO character of the value
    // (set derived from the value itself — script-agnostic, no constants).
    // Monotonic: only shrinks, never widens, so it can't cause a miss.
    const valCharSet = new Set(valueNoSpace.split(""));
    if (chosen.tokens.length > 1 && valCharSet.size > 0) {
        const carries = (t: NormalizedToken) => {
            for (const ch of t.cleanText) if (valCharSet.has(ch)) return true;
            return false;
        };
        const s = [...chosen.tokens].sort((a, b) => a.x - b.x);
        let lo = 0, hi = s.length - 1;
        while (lo < hi && !carries(s[lo])) lo++;
        while (hi > lo && !carries(s[hi])) hi--;
        const trimmed = s.slice(lo, hi + 1);
        if (trimmed.length > 0) {
            const dropped = chosen.tokens.length - trimmed.length;
            chosen.tokens = trimmed;
            chosen.trace.clusterDropped = (chosen.trace.clusterDropped || 0) + dropped;
        }
    }

    const origTokens: OCRToken[] = [];
    for (const nt of chosen.tokens) {
        const orig = tokens.find(o =>
            o.page === nt.page && o.x === nt.x && o.y === nt.y && o.text === nt.text
        );
        if (orig && !origTokens.includes(orig)) origTokens.push(orig);
    }
    return { tokens: origTokens, confidence: chosen.score, trace: chosen.trace };
}

// ─── Match result types ───────────────────────────────────────────────────
// Why a highlight landed where it did — surfaced to the console (debug mode)
// so a wrong/extra box can be traced back to the exact decision that caused it.
export interface MatchTrace {
    path:
        | "single-token"   // value found whole inside one OCR token
        | "page-exact"     // exact substring of a re-assembled visual row
        | "page-fuzzy"     // best trigram-density window in a row
        | "page-digits"    // position-aligned digit-stream match (numbers)
        | "word-phase1" | "word-phase2" // Latin word-window paths
        | "table"          // aggregate of per-row table matches
        | "none";
    rowText?: string;       // the visual row the match was found in
    matchedText?: string;   // the slice/window that matched within rowText
    coverage?: number;      // value-trigram coverage (fuzzy path)
    nearCounter?: boolean;  // row also contained a counterpart → score halved
    rowDropped?: number;    // glyphs densestRow removed (cross-line Y leak)
    clusterDropped?: number;// glyphs densestCluster removed (X outlier)
    note?: string;          // freeform extra detail (table lines, fallbacks)
    metrics?: RowMetrics;   // adaptive thresholds derived for this document
}

export interface MatchResult {
    tokens: OCRToken[];
    confidence: number; // 0..1, 0 means no match
    trace?: MatchTrace;
}

export interface MergedBox {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
}

// ─── Non-table matcher ────────────────────────────────────────────────────
function matchNonTable(value: string, tokens: OCRToken[], counterparts: string[]): MatchResult {
    const normalizedValue = normalizeStr(value);
    if (normalizedValue.length < 3) return { tokens: [], confidence: 0 };

    const normalizedTokens: NormalizedToken[] = tokens.map(t => ({ ...t, cleanText: normalizeStr(t.text) }));
    const validTokens = normalizedTokens.filter(t => t.cleanText.length > 0);
    if (validTokens.length === 0) return { tokens: [], confidence: 0 };

    const counterTexts = counterparts.filter(Boolean).map(normalizeStr).filter(c => c.length > 0);

    // Fast path: single-token containment (handles "79,180.00", "PO-2026-0042")
    const valNoSpace = normalizedValue.replace(/\s+/g, "");
    if (valNoSpace.length >= 4) {
        for (let i = 0; i < normalizedTokens.length; i++) {
            const t = normalizedTokens[i];
            if (t.cleanText.length === 0) continue;
            const tNoSpace = t.cleanText.replace(/\s+/g, "");
            if (tNoSpace.length < 4) continue;
            // For digit-heavy values (amounts/qty) substring containment is
            // WRONG: "500.00" (50000) is a substring of "35,000.00" (3500000),
            // and "2,500.00"/"1,500.00" both contain "500.00" — collapsing
            // distinct cells onto one token. Require full digit-string
            // equality instead; OCR-garbled cases fall through to the
            // row-scoped numeric path below. Generic, no per-doc constants.
            //
            // Alphanumeric IDs like "COSU6429548220" or "PO-2026-0042" used to
            // hit this path too (digit ratio ≥ 0.6) and matched the wrong
            // token — the digit-only suffix appeared elsewhere on the page
            // (e.g. a Booking No.) and won over the actual labelled location.
            // Require ≤1 letter to call something "pure numeric"; values
            // with a real letter prefix fall through to the full-string
            // exact/contains check below where the prefix anchors the match.
            const valDigitsL = valNoSpace.replace(/\D/g, "");
            const valLettersL = valNoSpace.replace(/[^a-z]/gi, "").length;
            const valIsNum = valLettersL < 2
                && valDigitsL.length >= 3
                && valDigitsL.length / valNoSpace.length >= 0.6;
            const exact = valIsNum
                ? tNoSpace.replace(/\D/g, "") === valDigitsL
                : tNoSpace === valNoSpace;
            const contains = !valIsNum &&
                (tNoSpace.includes(valNoSpace) || valNoSpace.includes(tNoSpace));
            if (!exact && !contains) continue;

            let blockedByCounter = false;
            for (const c of counterTexts) {
                const cNoSpace = c.replace(/\s+/g, "");
                if (cNoSpace.length < 3 || cNoSpace === valNoSpace) continue;
                if (tNoSpace.includes(cNoSpace) || cNoSpace.includes(tNoSpace)) {
                    blockedByCounter = true; break;
                }
            }
            if (blockedByCounter) continue;
            const conf = exact ? 0.95 : Math.min(valNoSpace.length, tNoSpace.length) / Math.max(valNoSpace.length, tNoSpace.length);
            if (conf >= 0.7) return {
                tokens: [tokens[i]], confidence: conf,
                trace: { path: "single-token", matchedText: t.cleanText },
            };
        }
    }

    // Thai path: page-text substring search (robust to Tesseract per-glyph splits)
    if (isThaiHeavy(value)) {
        return matchByPageText(value, tokens, counterparts);
    }

    // Non-Thai: try run-assembled page-text exact match FIRST. This recovers
    // numbers that hi-res OCR split into pieces (e.g. "79,180"+".00" →
    // "7918000") which the single-token fast path and word path both miss.
    const pageHit = matchByPageText(value, tokens, counterparts);
    if (pageHit.confidence >= 0.85) return pageHit;

    // Latin/mixed path: word-based candidate scoring
    const targetWords = normalizedValue.split(/\s+/).filter(w => w.length >= 1);
    if (targetWords.length === 0) return { tokens: [], confidence: 0 };

    const sorted = [...validTokens].sort((a, b) =>
        Math.abs(a.y - b.y) > 0.01 ? a.y - b.y : a.x - b.x
    );

    type Cand = { score: number; coverage: number; tokens: NormalizedToken[]; spanY: number; counterDiff: number; phase: 1 | 2 };
    const candidates: Cand[] = [];

    // Phase 1: contiguous with ≤2 noise-token skips
    for (let i = 0; i <= sorted.length - 1; i++) {
        const window: NormalizedToken[] = [];
        const fuzzScores: number[] = [];
        let wordIndex = 0;
        let tokenIndex = i;
        const baseY = sorted[i].y;
        let skips = 0;
        while (wordIndex < targetWords.length && tokenIndex < sorted.length) {
            if (sorted[tokenIndex].y - baseY > 0.06) break;
            const tk = sorted[tokenIndex];
            const score = fuzzyScore(tk.cleanText, targetWords[wordIndex]);
            if (score >= 0.85) {
                window.push(tk); fuzzScores.push(score); wordIndex++;
            } else if (wordIndex > 0 && skips < 2 && tk.cleanText.length <= 3) {
                skips++;
            } else if (wordIndex > 0) break;
            tokenIndex++;
        }
        if (wordIndex > 0 && window.length > 0) {
            const coverage = wordIndex / targetWords.length;
            const avgFuzz = fuzzScores.reduce((a, b) => a + b, 0) / fuzzScores.length;
            const spanY = Math.max(...window.map(t => t.y)) - baseY;
            if (coverage >= 0.7) {
                candidates.push({ score: avgFuzz * coverage, coverage, tokens: window, spanY, counterDiff: 0, phase: 1 });
            }
        }
    }

    // Phase 2: sliding y-band window
    const hasShortNumber = targetWords.some(w => w.length <= 2 && /^\d+$/.test(w));
    if (targetWords.length >= 2 && !hasShortNumber) {
        const MAX_Y_SPAN = 0.04;
        for (let i = 0; i < sorted.length; i++) {
            const windowTokens: NormalizedToken[] = [];
            const baseY = sorted[i].y;
            for (let j = i; j < sorted.length; j++) {
                if (sorted[j].y - baseY > MAX_Y_SPAN) break;
                windowTokens.push(sorted[j]);
            }
            if (windowTokens.length < targetWords.length) continue;
            const matchedTokens: NormalizedToken[] = [];
            const matchedScores: number[] = [];
            let matched = 0;
            for (const w of targetWords) {
                let bestScore = 0;
                let bestTok: NormalizedToken | null = null;
                for (const t of windowTokens) {
                    if (matchedTokens.includes(t)) continue;
                    const s = fuzzyScore(t.cleanText, w);
                    if (s > bestScore) { bestScore = s; bestTok = t; }
                }
                if (bestScore >= 0.85 && bestTok) {
                    matched++; matchedTokens.push(bestTok); matchedScores.push(bestScore);
                }
            }
            const coverage = matched / targetWords.length;
            if (coverage >= 0.8 && matchedTokens.length > 0) {
                const avgFuzz = matchedScores.reduce((a, b) => a + b, 0) / matchedScores.length;
                candidates.push({
                    score: avgFuzz * coverage * 0.95,
                    coverage, tokens: matchedTokens, spanY: MAX_Y_SPAN, counterDiff: 0, phase: 2,
                });
            }
        }
    }

    // No word-path candidate — fall back to whatever page-text found earlier
    if (candidates.length === 0) return pageHit;

    if (counterTexts.length > 0) {
        for (const cand of candidates) {
            const candY = cand.tokens[0].y;
            const lineText = validTokens
                .filter(t => Math.abs(t.y - candY) < Math.max(t.height, cand.tokens[0].height))
                .map(t => t.cleanText).join(" ");
            let penalty = 0;
            for (const c of counterTexts) {
                if (c.length > 3 && lineText.includes(c)) penalty += 0.1;
            }
            cand.counterDiff = -penalty;
        }
    }

    candidates.sort((a, b) => (b.score + b.counterDiff) - (a.score + a.counterDiff));
    const best = candidates[0];
    const origTokens = best.tokens.map(t => tokens[normalizedTokens.indexOf(t)]).filter(Boolean) as OCRToken[];
    return {
        tokens: origTokens,
        confidence: Math.max(0, Math.min(1, best.score + best.counterDiff)),
        trace: {
            path: best.phase === 1 ? "word-phase1" : "word-phase2",
            matchedText: best.tokens.map(t => t.cleanText).join(" "),
            coverage: +best.coverage.toFixed(3),
            note: best.counterDiff < 0 ? `counter penalty ${best.counterDiff.toFixed(2)}` : undefined,
        },
    };
}

// ─── Table matcher ────────────────────────────────────────────────────────
// Each value line is one table row. We highlight only rows that DIFFER from
// every counterpart. Per differing line we run the same page-text fuzzy
// search used for Thai — it is script-agnostic and survives Tesseract's
// per-glyph fragmentation far better than the old row/cell heuristic.
function matchTable(value: string, tokens: OCRToken[], counterparts: string[]): MatchResult {
    const valLines = value.split('\n').map(l => l.trim()).filter(Boolean);
    if (valLines.length === 0) return { tokens: [], confidence: 0 };
    const counterLinesArr = counterparts.map(c => (c || "").split('\n').map(l => l.trim()).filter(Boolean));

    const matchInfo: OCRToken[] = [];
    const scores: number[] = [];
    const lineNotes: string[] = [];
    let skippedSame = 0;

    for (let lineIdx = 0; lineIdx < valLines.length; lineIdx++) {
        const valLine = valLines[lineIdx];

        // Skip rows that are identical across ALL counterparts (no diff)
        const allSame = counterLinesArr.length > 0 &&
            counterLinesArr.every(arr => (arr[lineIdx] || "") === valLine);
        if (allSame) { skippedSame++; continue; }

        const normValLine = normalizeStr(valLine);
        if (normValLine.replace(/\s+/g, "").length < 3) continue;

        // Counterpart for THIS row = the aligned line of each counterpart doc
        const rowCounterparts = counterLinesArr
            .map(arr => arr[lineIdx] || "")
            .filter(Boolean);

        const r = matchByPageText(valLine, tokens, rowCounterparts);
        if (r.tokens.length === 0) {
            lineNotes.push(`L${lineIdx} "${valLine.slice(0, 24)}" → no match`);
            continue;
        }
        for (const t of r.tokens) if (!matchInfo.includes(t)) matchInfo.push(t);
        scores.push(r.confidence);
        lineNotes.push(
            `L${lineIdx} "${valLine.slice(0, 24)}" → ${r.trace?.path}` +
            ` ${r.tokens.length}tok @${r.confidence.toFixed(2)}`,
        );
    }

    if (matchInfo.length === 0) {
        return {
            tokens: [], confidence: 0,
            trace: { path: "table", note: `0 matched; ${skippedSame} rows identical (skipped)` },
        };
    }
    const avgScore = scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);
    return {
        tokens: matchInfo, confidence: avgScore,
        trace: {
            path: "table",
            note: `${scores.length} diff rows matched, ${skippedSame} skipped (identical) | ` +
                lineNotes.join(" ; "),
        },
    };
}

// ─── Public API ───────────────────────────────────────────────────────────
export function matchValueToTokens(
    value: string,
    tokens: OCRToken[],
    isTableField: boolean = false,
    counterparts: string[] = []
): MatchResult {
    if (!value || tokens.length === 0) return { tokens: [], confidence: 0 };
    return isTableField ? matchTable(value, tokens, counterparts) : matchNonTable(value, tokens, counterparts);
}

export function mergeTokenBoxes(tokens: OCRToken[]): MergedBox[] {
    if (tokens.length === 0) return [];
    const byPage = tokens.reduce((acc, t) => {
        if (!acc[t.page]) acc[t.page] = [];
        acc[t.page].push(t);
        return acc;
    }, {} as Record<number, OCRToken[]>);

    const result: MergedBox[] = [];
    for (const pageTokens of Object.values(byPage)) {
        const sorted = [...pageTokens].sort((a, b) => {
            if (Math.abs(a.y - b.y) > Math.max(a.height, b.height) * 0.5) return a.y - b.y;
            return a.x - b.x;
        });
        let current: MergedBox = {
            page: sorted[0].page, x: sorted[0].x, y: sorted[0].y,
            width: sorted[0].width, height: sorted[0].height, text: sorted[0].text,
        };
        for (let i = 1; i < sorted.length; i++) {
            const next = sorted[i];
            const same = Math.abs(current.y - next.y) < Math.max(current.height, next.height) * 0.5;
            const gap = next.x - (current.x + current.width);
            const close = same && (gap > -0.05 && gap < 0.05);
            if (same && close) {
                const minX = Math.min(current.x, next.x);
                const minY = Math.min(current.y, next.y);
                const maxX = Math.max(current.x + current.width, next.x + next.width);
                const maxY = Math.max(current.y + current.height, next.y + next.height);
                current.x = minX; current.y = minY;
                current.width = maxX - minX; current.height = maxY - minY;
                current.text += " " + next.text;
            } else {
                result.push(current);
                current = { page: next.page, x: next.x, y: next.y, width: next.width, height: next.height, text: next.text };
            }
        }
        result.push(current);
    }
    return result;
}
