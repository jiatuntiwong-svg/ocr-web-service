// Shared password strength rules — used by /register UI (live meter + block
// submit) and by /api/auth/register (server-side enforcement so the rule
// can't be bypassed by hitting the API directly).
//
// Rule set is intentionally modest: long enough to resist common brute-force,
// mixed-case + a non-letter so dictionary words alone don't pass. We do NOT
// require punctuation — accessibility for non-English keyboards trumps a
// marginal entropy gain.

export interface PasswordCheck {
    length: boolean;          // >= 8 chars
    hasLower: boolean;        // a-z
    hasUpper: boolean;        // A-Z
    hasNumberOrSymbol: boolean; // any non-letter
}

export interface PasswordStrength {
    checks: PasswordCheck;
    passed: number;           // 0–4
    /** 0 = empty, 1 = weak, 2 = fair, 3 = strong */
    score: 0 | 1 | 2 | 3;
    valid: boolean;           // all 4 checks pass
}

export function evaluatePassword(pw: string): PasswordStrength {
    const checks: PasswordCheck = {
        length: pw.length >= 8,
        hasLower: /[a-z]/.test(pw),
        hasUpper: /[A-Z]/.test(pw),
        hasNumberOrSymbol: /[^a-zA-Z]/.test(pw),
    };
    const passed = Object.values(checks).filter(Boolean).length as 0 | 1 | 2 | 3 | 4;
    const score: 0 | 1 | 2 | 3 = pw.length === 0 ? 0 : passed <= 2 ? 1 : passed === 3 ? 2 : 3;
    return { checks, passed, score, valid: passed === 4 };
}

/** Short server-side validator — returns null when OK, else an error message. */
export function validatePassword(pw: string): string | null {
    const { valid } = evaluatePassword(pw);
    if (!valid) {
        return "Password must be at least 8 characters and include uppercase, lowercase, and a number or symbol.";
    }
    return null;
}
