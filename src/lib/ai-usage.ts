// Records the input/output token cost of every AI call so the admin
// dashboard can compute per-function cost & profit. One row per real AI
// request (cache hits / failed calls are never logged — no tokens spent).

export type AIFunction = "ocr" | "compare" | "api_extract";

export interface AIUsageRecord {
    userId: string | null;
    fn: AIFunction;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    docId?: string | null;     // links OCR rows to a document for inspection
    fileName?: string | null;  // human label — "which doc type costs tokens"
}

async function ensureTable(env: any): Promise<void> {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS ai_usage (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            function TEXT,
            provider TEXT,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            doc_id TEXT,
            file_name TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();
}

/**
 * Persist one AI call's token usage. Best-effort: never throws — a logging
 * failure must not break the OCR/compare response.
 */
export async function logAiUsage(env: any, rec: AIUsageRecord): Promise<void> {
    try {
        if (!env?.DB) return;
        await ensureTable(env);
        const id = (typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : Date.now().toString(36) + Math.random().toString(36).slice(2);
        await env.DB.prepare(`
            INSERT INTO ai_usage
                (id, user_id, function, provider, model, input_tokens, output_tokens, doc_id, file_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            id,
            rec.userId,
            rec.fn,
            rec.provider,
            rec.model,
            Math.max(0, Math.round(rec.inputTokens || 0)),
            Math.max(0, Math.round(rec.outputTokens || 0)),
            rec.docId ?? null,
            rec.fileName ?? null,
        ).run();
    } catch (err) {
        console.error("Failed to write ai_usage:", err);
    }
}

// Lazily expose the table-creator so the admin read API can guarantee the
// table exists before SELECTing (avoids a "no such table" on a fresh DB).
export async function ensureAiUsageTable(env: any): Promise<void> {
    if (env?.DB) await ensureTable(env);
}
