// AI-1 (SEC-3): utility to strip secrets from any string before it reaches a
// log line, error surface, or `wrangler tail`. Google/Vertex error bodies
// sometimes echo the request URL/config, and internal `console.warn/error`
// calls can accidentally include the key — funnel every such string through
// `redactSecrets()` first.
//
// Patterns recognised (extend here — do NOT duplicate the list elsewhere):
//   1. Google API keys: `AIza` + 35 URL-safe chars.
//   2. `?key=...` and `&key=...` query params (any value, not just AIza).
//   3. `x-goog-api-key: ...` header echoes.
//   4. `Bearer <token>` headers (OpenAI/OpenRouter surfaces).
//
// The replacement preserves the first 4 + last 4 chars where possible so a
// leaked-key incident is still debuggable ("which key leaked?") without the
// full secret ending up in logs.

const AIZA_KEY = /AIza[0-9A-Za-z_-]{35}/g;
const URL_KEY_PARAM = /([?&])key=[^&\s"']+/gi;
const X_GOOG_HEADER = /(x-goog-api-key["'\s:=]+)[^\s"',}]+/gi;
const BEARER_TOKEN = /(Bearer\s+)[A-Za-z0-9._-]{16,}/g;

function maskKey(k: string): string {
    if (k.length <= 12) return "****";
    return k.slice(0, 4) + "..." + k.slice(-4);
}

export function redactSecrets(input: unknown): string {
    if (input == null) return "";
    let s: string;
    try {
        if (typeof input === "string") s = input;
        else if (input instanceof Error) s = input.message + (input.stack ? "\n" + input.stack : "");
        else s = JSON.stringify(input);
    } catch {
        s = String(input);
    }
    return s
        .replace(AIZA_KEY, (m) => maskKey(m))
        .replace(URL_KEY_PARAM, (_m, sep) => `${sep}key=***REDACTED***`)
        .replace(X_GOOG_HEADER, (_m, prefix) => `${prefix}***REDACTED***`)
        .replace(BEARER_TOKEN, (_m, prefix) => `${prefix}***REDACTED***`);
}
