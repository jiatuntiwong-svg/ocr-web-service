// Smart-confirm preferences + per-user credit usage cache.
//
// State stored in localStorage so it survives reload but stays per-device.
// (When user-settings DB lands, lift these keys into the users table.)

export interface ConfirmThresholds {
    /** T1 — confirm if estimate > this many credits. */
    absolute: number;
    /** T2 — confirm if estimate > userAvg × this multiplier. */
    relative: number;
    /** T3 — confirm whenever any field has type=table (cost is post-adjust). */
    tableField: boolean;
    /** T4 — confirm if estimate > balance × this fraction (0..1). */
    lowBalance: number;
}

export const DEFAULT_THRESHOLDS: ConfirmThresholds = {
    absolute:   3,
    relative:   1.5,
    tableField: true,
    lowBalance: 0.10,
};

const KEY_THRESHOLDS  = "docroom_confirm_thresholds_v1";
const KEY_AVG         = "docroom_credit_avg_v1";          // { sum, count }
const KEY_SKIP        = "docroom_skip_confirm_v1";        // string[]

function readJson<T>(key: string, fallback: T): T {
    if (typeof localStorage === "undefined") return fallback;
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) as T : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown) {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export function loadThresholds(): ConfirmThresholds {
    return { ...DEFAULT_THRESHOLDS, ...readJson<Partial<ConfirmThresholds>>(KEY_THRESHOLDS, {}) };
}

export function saveThresholds(t: ConfirmThresholds) {
    writeJson(KEY_THRESHOLDS, t);
}

// ─── User avg credits (rolling) ────────────────────────────────────────────
// Heuristic default when the user has no history. Picked low so new users
// rarely see T2 trigger noise on their first runs.
const DEFAULT_AVG = 1.5;

export function recordCreditUse(credits: number) {
    if (credits <= 0) return;
    const cur = readJson<{ sum: number; count: number }>(KEY_AVG, { sum: 0, count: 0 });
    cur.sum += credits;
    cur.count += 1;
    writeJson(KEY_AVG, cur);
}

export function getUserAvgCredits(): number {
    const cur = readJson<{ sum: number; count: number }>(KEY_AVG, { sum: 0, count: 0 });
    return cur.count > 0 ? cur.sum / cur.count : DEFAULT_AVG;
}

// ─── "Don't ask again" per-template fingerprint ─────────────────────────────
// fingerprint = `${op}:${templateId|custom}:${fieldCount}:${docCount}`.
// Same template + same shape → skip dialog next time.

export function makeFingerprint(input: {
    operation: "ocr" | "compare";
    templateId: string | null;
    fieldCount: number;
    docCount: number;
}): string {
    const tpl = input.templateId ?? "custom";
    return `${input.operation}:${tpl}:${input.fieldCount}:${input.docCount}`;
}

export function shouldSkipDialog(fp: string): boolean {
    return readJson<string[]>(KEY_SKIP, []).includes(fp);
}

export function rememberSkip(fp: string) {
    const list = readJson<string[]>(KEY_SKIP, []);
    if (!list.includes(fp)) {
        list.push(fp);
        writeJson(KEY_SKIP, list);
    }
}

export function clearAllSkips() {
    writeJson(KEY_SKIP, []);
}

// ─── Trigger evaluation ────────────────────────────────────────────────────

export type ConfirmReason = "T1_abs_high" | "T2_rel_spike" | "T3_table_field" | "T4_low_balance";

export interface ConfirmEvalInput {
    estimate: number;
    balance: number;
    hasTableField: boolean;
    userAvg?: number;
    thresholds?: ConfirmThresholds;
}

export function evaluateConfirm(input: ConfirmEvalInput): {
    needsConfirm: boolean;
    reasons: ConfirmReason[];
} {
    const th = input.thresholds ?? loadThresholds();
    const avg = input.userAvg ?? getUserAvgCredits();
    const reasons: ConfirmReason[] = [];
    if (input.estimate > th.absolute) reasons.push("T1_abs_high");
    if (input.estimate > avg * th.relative) reasons.push("T2_rel_spike");
    if (th.tableField && input.hasTableField) reasons.push("T3_table_field");
    if (input.balance > 0 && input.estimate > input.balance * th.lowBalance) reasons.push("T4_low_balance");
    return { needsConfirm: reasons.length > 0, reasons };
}
