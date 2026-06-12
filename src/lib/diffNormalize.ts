// Semantic normalisation for Compare verdicts.
//
// The AI extracts values verbatim (good for highlight matching), but raw
// string equality flags trivially-different-but-semantically-equal values
// as "diff" — e.g. `15 มกราคม 2565` vs `2022-01-15`, or `USD 51,651.11`
// vs `51651.11 USD`, or `10 + 5 + 3` vs `18`. This module canonicalises
// both sides before the compare route's set-equality check so those
// false positives go away.
//
// Order is intentional: date → arithmetic → numeric-with-unit → fallback
// (case-folded, separator-stripped). Each step short-circuits on success,
// so a plain "18" doesn't get treated as a 18-of-something-else.

const THAI_MONTHS: Record<string, number> = {
    "มกราคม": 1, "ม.ค.": 1, "ม.ค": 1,
    "กุมภาพันธ์": 2, "ก.พ.": 2, "ก.พ": 2,
    "มีนาคม": 3, "มี.ค.": 3, "มี.ค": 3,
    "เมษายน": 4, "เม.ย.": 4, "เม.ย": 4,
    "พฤษภาคม": 5, "พ.ค.": 5, "พ.ค": 5,
    "มิถุนายน": 6, "มิ.ย.": 6, "มิ.ย": 6,
    "กรกฎาคม": 7, "ก.ค.": 7, "ก.ค": 7,
    "สิงหาคม": 8, "ส.ค.": 8, "ส.ค": 8,
    "กันยายน": 9, "ก.ย.": 9, "ก.ย": 9,
    "ตุลาคม": 10, "ต.ค.": 10, "ต.ค": 10,
    "พฤศจิกายน": 11, "พ.ย.": 11, "พ.ย": 11,
    "ธันวาคม": 12, "ธ.ค.": 12, "ธ.ค": 12,
};

const ENG_MONTHS: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// Thai Buddhist Era is 543 years ahead of CE. Years ≥ 2400 are almost
// certainly พ.ศ. — the threshold deliberately allows late-CE years up
// to 2399 to stay as-is. Anything below 100 is treated as 2-digit (20YY).
function normalizeYear(y: number): number {
    if (y < 100) return y + 2000;
    if (y >= 2400) return y - 543;
    return y;
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function isoFromYMD(y: number, m: number, d: number): string | null {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function tryParseDate(raw: string): string | null {
    const s = raw.trim();
    if (s.length < 6 || s.length > 40) return null;

    // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return isoFromYMD(normalizeYear(+m[1]), +m[2], +m[3]);

    // DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY  (locale-default in TH)
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (m) return isoFromYMD(normalizeYear(+m[3]), +m[2], +m[1]);

    // "15 มกราคม 2565" / "15 ม.ค. 2565" / "15 JAN 2022" / "15 September 2022"
    m = s.match(/^(\d{1,2})\s+([A-Za-zก-๛.]+)\s+(\d{2,4})$/);
    if (m) {
        const day = +m[1];
        const monRaw = m[2];
        const month = THAI_MONTHS[monRaw] ?? ENG_MONTHS[monRaw.toLowerCase()];
        if (!month) return null;
        return isoFromYMD(normalizeYear(+m[3]), month, day);
    }

    // "January 15, 2022" / "Jan 15 2022"
    m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{2,4})$/);
    if (m) {
        const month = ENG_MONTHS[m[1].toLowerCase()];
        if (!month) return null;
        return isoFromYMD(normalizeYear(+m[3]), month, +m[2]);
    }

    return null;
}

// Strict expression evaluator (no eval/new Function — Cloudflare Workers
// don't allow either). Supports + - * / and parens over decimal numbers.
// Returns null on any unknown character or malformed input. Units/currency
// are stripped first so "10 + 5 + 3 boxes" still resolves to 18.
export function tryEvalArithmetic(raw: string): number | null {
    const noUnits = stripUnitNoise(raw.toLowerCase());
    const s = noUnits.replace(/[,\s_]/g, "");
    if (!s) return null;
    if (!/[+\-*/]/.test(s)) return null;            // bare number — let numeric path handle it
    if (!/^[\d+\-*/().]+$/.test(s)) return null;    // any letter/symbol left → bail
    if (/[+*/]{2,}|--+/.test(s)) return null;       // malformed

    // Tokenize
    type Tok = number | "+" | "-" | "*" | "/" | "(" | ")";
    const toks: Tok[] = [];
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch >= "0" && ch <= "9" || ch === ".") {
            let j = i;
            while (j < s.length && (s[j] === "." || (s[j] >= "0" && s[j] <= "9"))) j++;
            const n = parseFloat(s.slice(i, j));
            if (!Number.isFinite(n)) return null;
            toks.push(n);
            i = j;
        } else if ("+-*/()".includes(ch)) {
            toks.push(ch as Tok);
            i++;
        } else return null;
    }

    // Shunting yard → RPN
    const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
    const out: Tok[] = [];
    const ops: Tok[] = [];
    for (const t of toks) {
        if (typeof t === "number") out.push(t);
        else if (t === "(") ops.push(t);
        else if (t === ")") {
            while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop()!);
            if (!ops.length) return null;
            ops.pop();
        } else {
            while (ops.length) {
                const top = ops[ops.length - 1];
                if (top === "(" || prec[top as string] < prec[t]) break;
                out.push(ops.pop()!);
            }
            ops.push(t);
        }
    }
    while (ops.length) {
        const op = ops.pop()!;
        if (op === "(" || op === ")") return null;
        out.push(op);
    }

    // Evaluate
    const stack: number[] = [];
    for (const t of out) {
        if (typeof t === "number") stack.push(t);
        else {
            const b = stack.pop();
            const a = stack.pop();
            if (a === undefined || b === undefined) return null;
            switch (t) {
                case "+": stack.push(a + b); break;
                case "-": stack.push(a - b); break;
                case "*": stack.push(a * b); break;
                case "/":
                    if (b === 0) return null;
                    stack.push(a / b);
                    break;
            }
        }
    }
    return stack.length === 1 && Number.isFinite(stack[0]) ? stack[0] : null;
}

// Currency codes / units we recognise as decoration around a number. The
// two-list split exists because JS `\b` only treats ASCII letters as word
// chars — Thai units would never be bounded by `\b`, so we run them on a
// separate regex without boundaries.
//
// Ordering inside each list is irrelevant because we don't substring-strip
// the input — we extract the number first, then check whatever surrounds
// it is ONLY in these lists. That removes the old "kg eats the s in kgs"
// alternation bug and stops bare `g` from matching the `g` in "package".
const ASCII_CURRENCY = ["usd", "eur", "gbp", "jpy", "cny", "thb", "baht"];
const ASCII_UNITS = [
    // mass
    "kilograms", "kilogram", "kgs", "kg", "tonnes", "tonne", "tons", "ton",
    "lbs", "lb", "pounds", "pound", "grams", "gram", "g",
    // volume
    "milliliters", "milliliter", "liters", "liter", "litres", "litre",
    "ml", "cc", "l",
    // quantity
    "pieces", "piece", "pcs", "pc", "units", "unit", "ea",
    "boxes", "box",
    "cartons", "carton", "ctns", "ctn",
    "cartoms", "cartom",         // common OCR confusion of N→M in "CARTON(S)"
    "pallets", "pallet", "plt",
    "packs", "pack", "pkg",
    // percent (word form — the symbol is handled separately)
    "percent",
];
const THAI_NOISE = [
    "บาท",
    "กก\\.?", "กิโลกรัม", "กรัม", "ตัน", "ปอนด์",
    "มล\\.?", "ลิตร",
    "ชิ้น", "หน่วย", "อัน", "ใบ", "กล่อง", "พาเลท",
    "เปอร์เซ็นต์",
];

const ASCII_NOISE_RE = new RegExp(
    "\\b(" + [...ASCII_CURRENCY, ...ASCII_UNITS].join("|") + ")\\b",
    "gi",
);
const THAI_NOISE_RE = new RegExp("(" + THAI_NOISE.join("|") + ")", "g");
const CURRENCY_SYMBOL = /[฿$€£¥]/g;
const PERCENT_SYMBOL = /%/g;

function stripUnitNoise(s: string): string {
    return s
        .replace(ASCII_NOISE_RE, " ")
        .replace(THAI_NOISE_RE, " ")
        .replace(CURRENCY_SYMBOL, " ")
        .replace(PERCENT_SYMBOL, " ");
}

// Locate the first numeric run (with optional thousands separators / decimal).
// We use [,_] for thousands so "1,300" and "22,089.740" both parse cleanly.
const NUMERIC_RUN_RE = /[-+]?\d{1,3}(?:[,_]\d{3})+(?:\.\d+)?|[-+]?\d+(?:\.\d+)?/;

// Returns a canonical decimal string or null if the remainder after stripping
// units isn't clean. Strategy: extract the number, then verify everything
// around it is only known unit/currency decoration.
export function tryParseNumeric(raw: string): string | null {
    const m = raw.match(NUMERIC_RUN_RE);
    if (!m) return null;
    const numStr = m[0];
    const idx = m.index ?? 0;
    const before = raw.slice(0, idx);
    const after = raw.slice(idx + numStr.length);

    // Strip known units/currency/symbols from the context. Anything left
    // (after also dropping pure separator/punctuation chars) means this
    // isn't a pure numeric — bail.
    const context = stripUnitNoise((before + " " + after).toLowerCase());
    const residue = context.replace(/[\s.,()_/]+/g, "");
    if (residue !== "") return null;

    const n = parseFloat(numStr.replace(/[,_]/g, ""));
    if (!Number.isFinite(n)) return null;
    return String(n);
}

// Verdict modes — user-selectable in the Compare UI.
//   strict — pure string equality (case-fold + whitespace collapse only).
//            Use for legal/compliance docs where format matters as much as
//            content (e.g. "USD 100.00" should NOT equal "100 USD").
//   smart  — semantic equivalence (date / arithmetic / currency / units).
//            Default; what business users want for invoices / receipts.
export type VerdictMode = "strict" | "smart";

const STRICT_MODES = new Set<VerdictMode>(["strict"]);

export function isVerdictMode(v: unknown): v is VerdictMode {
    return v === "strict" || v === "smart";
}

// The single entry-point the compare route uses. Returns the canonical
// form that should compare equal across formatting variations under the
// chosen mode.
export function normalizeForDiff(v: unknown, mode: VerdictMode = "smart"): string {
    if (v == null) return "";
    const raw = String(v).trim();
    if (!raw) return "";

    if (STRICT_MODES.has(mode)) {
        // Strict — preserve everything except case + redundant whitespace.
        // No symbol stripping (so "100" ≠ "$100"), no date normalisation
        // (so "2022-01-15" ≠ "15/1/2022"), no arithmetic.
        return raw.toLowerCase().replace(/\s+/g, " ");
    }

    // smart
    // 1) Dates — pin to ISO so YYYY-MM-DD ≡ DD/MM/YYYY ≡ DD MONTH YYYY,
    //    with พ.ศ. ↔ ค.ศ. handled by year-normalisation.
    const iso = tryParseDate(raw);
    if (iso) return iso;

    // 2) Simple arithmetic — "10 + 5 + 3" ≡ "18".
    const evald = tryEvalArithmetic(raw);
    if (evald !== null) return String(evald);

    // 3) Number with currency / unit — "USD 51,651.11" ≡ "51651.11 USD".
    const num = tryParseNumeric(raw);
    if (num !== null) return num;

    // 4) Fallback: case-fold + strip separators + currency symbols. Same
    //    behaviour as the previous normalizeForDiff so unrecognised values
    //    keep their old equality semantics.
    return raw
        .toLowerCase()
        .replace(/[,\s_฿$€£¥]/g, "")
        .trim();
}
