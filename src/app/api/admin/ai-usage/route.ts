import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ensureAiUsageTable } from "@/lib/ai-usage";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireAdmin } from "@/lib/auth/guards";

// Admin AI token-usage dashboard API.
//   GET  → per-function summary + daily breakdown + raw rows + per-model rates
//   POST → save per-model token rates (USD per 1,000,000 tokens)

interface ModelRate { input: number; output: number } // USD per 1M tokens
type RateMap = Record<string, ModelRate>;

const DEFAULT_USD_THB = 35; // fallback FX rate until an admin sets one

async function loadRates(env: any): Promise<RateMap> {
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
    ).run();
    const row: any = await env.DB.prepare(
        "SELECT value FROM system_settings WHERE key = 'AI_TOKEN_RATES'"
    ).first();
    try {
        return row ? (JSON.parse(row.value) as RateMap) : {};
    } catch {
        return {};
    }
}

// USD → THB exchange rate (provider prices are quoted in USD; the dashboard
// displays cost in Baht). Stored as a plain number in system_settings.
async function loadUsdThb(env: any): Promise<number> {
    const row: any = await env.DB.prepare(
        "SELECT value FROM system_settings WHERE key = 'AI_USD_THB'"
    ).first();
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_THB;
}

export async function GET(req: NextRequest) {
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return NextResponse.json({ success: true, empty: true, warning: "DB unavailable" });
        }
        await ensureAiUsageTable(env);
        const rates = await loadRates(env);
        const usdThb = await loadUsdThb(env);

        // Per function + model aggregate (the costing unit).
        const byModelRows = (await env.DB.prepare(`
            SELECT function AS fn, provider, model,
                   COUNT(*) AS calls,
                   COALESCE(SUM(input_tokens), 0)  AS inTok,
                   COALESCE(SUM(output_tokens), 0) AS outTok
            FROM ai_usage
            GROUP BY function, provider, model
        `).all()).results as any[];

        // Daily breakdown per function+model (model needed for cost).
        const dailyRows = (await env.DB.prepare(`
            SELECT date(created_at) AS day, function AS fn, model,
                   COUNT(*) AS calls,
                   COALESCE(SUM(input_tokens), 0)  AS inTok,
                   COALESCE(SUM(output_tokens), 0) AS outTok
            FROM ai_usage
            GROUP BY day, function, model
            ORDER BY day DESC
            LIMIT 400
        `).all()).results as any[];

        // Raw recent rows for per-document inspection.
        const rawRows = (await env.DB.prepare(`
            SELECT a.id, a.created_at, a.function AS fn, a.provider, a.model,
                   a.input_tokens, a.output_tokens, a.doc_id, a.file_name,
                   u.email AS user_email
            FROM ai_usage a
            LEFT JOIN users u ON a.user_id = u.id
            ORDER BY a.created_at DESC
            LIMIT 200
        `).all()).results as any[];

        const rateFor = (model: string): ModelRate => rates[model] || { input: 0, output: 0 };
        const costOf = (model: string, inTok: number, outTok: number): number =>
            (inTok / 1e6) * rateFor(model).input + (outTok / 1e6) * rateFor(model).output;

        // byModel with cost
        const byModel = byModelRows.map(r => ({
            fn: r.fn, provider: r.provider, model: r.model,
            calls: r.calls, inputTokens: r.inTok, outputTokens: r.outTok,
            cost: +costOf(r.model, r.inTok, r.outTok).toFixed(6),
            rated: !!rates[r.model],
        }));

        // Per-function summary (sum across that function's models).
        const fnAgg: Record<string, any> = {};
        for (const r of byModel) {
            const a = fnAgg[r.fn] || (fnAgg[r.fn] = { fn: r.fn, calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 });
            a.calls += r.calls;
            a.inputTokens += r.inputTokens;
            a.outputTokens += r.outputTokens;
            a.cost += r.cost;
        }
        const summary = Object.values(fnAgg).map((a: any) => ({
            ...a,
            cost: +a.cost.toFixed(6),
            avgInput: a.calls ? Math.round(a.inputTokens / a.calls) : 0,
            avgOutput: a.calls ? Math.round(a.outputTokens / a.calls) : 0,
            avgCost: a.calls ? +(a.cost / a.calls).toFixed(6) : 0,
        }));

        // Distinct models seen → rate editor list (include current rate).
        const modelSet = new Map<string, { provider: string; model: string }>();
        for (const r of byModelRows) modelSet.set(r.model, { provider: r.provider, model: r.model });
        const models = [...modelSet.values()].map(m => ({
            ...m,
            input: rates[m.model]?.input ?? 0,
            output: rates[m.model]?.output ?? 0,
        }));

        // Collapse daily rows from (day,fn,model) → (day,fn) with summed cost.
        const dailyAgg: Record<string, any> = {};
        for (const r of dailyRows) {
            const k = `${r.day}|${r.fn}`;
            const d = dailyAgg[k] || (dailyAgg[k] = {
                day: r.day, fn: r.fn, calls: 0, inputTokens: 0, outputTokens: 0, cost: 0,
            });
            d.calls += r.calls;
            d.inputTokens += r.inTok;
            d.outputTokens += r.outTok;
            d.cost += costOf(r.model || "", r.inTok, r.outTok);
        }
        const daily = Object.values(dailyAgg)
            .map((d: any) => ({ ...d, cost: +d.cost.toFixed(6) }))
            .sort((a: any, b: any) => (a.day < b.day ? 1 : -1));

        // ─── Monthly per-user report ───────────────────────────────────────
        const monthParam = new URL(req.url).searchParams.get("month");
        const month = /^\d{4}-\d{2}$/.test(monthParam || "")
            ? (monthParam as string)
            : new Date().toISOString().slice(0, 7);

        const userRows = (await env.DB.prepare(`
            SELECT a.user_id AS uid, a.function AS fn, a.model AS model,
                   COUNT(*) AS calls,
                   COALESCE(SUM(a.input_tokens), 0)  AS inTok,
                   COALESCE(SUM(a.output_tokens), 0) AS outTok,
                   u.email AS email, u.name AS name
            FROM ai_usage a
            LEFT JOIN users u ON a.user_id = u.id
            WHERE strftime('%Y-%m', a.created_at) = ?
            GROUP BY a.user_id, a.function, a.model
        `).bind(month).all()).results as any[];

        const monthsRows = (await env.DB.prepare(
            `SELECT DISTINCT strftime('%Y-%m', created_at) AS m FROM ai_usage ORDER BY m DESC`
        ).all()).results as any[];

        const userAgg: Record<string, any> = {};
        for (const r of userRows) {
            const key = r.uid || "__none__";
            const u = userAgg[key] || (userAgg[key] = {
                userId: r.uid || null, email: r.email || null, name: r.name || null,
                ocrCalls: 0, compareCalls: 0, apiCalls: 0, totalCalls: 0,
                inputTokens: 0, outputTokens: 0, cost: 0,
            });
            u.totalCalls += r.calls;
            u.inputTokens += r.inTok;
            u.outputTokens += r.outTok;
            u.cost += costOf(r.model || "", r.inTok, r.outTok);
            if (r.fn === "ocr") u.ocrCalls += r.calls;
            else if (r.fn === "compare") u.compareCalls += r.calls;
            else if (r.fn === "api_extract") u.apiCalls += r.calls;
        }
        const report = {
            month,
            users: Object.values(userAgg)
                .map((u: any) => ({ ...u, cost: +u.cost.toFixed(6) }))
                .sort((a: any, b: any) => b.cost - a.cost || b.totalCalls - a.totalCalls),
        };
        const availableMonths = monthsRows.map(r => r.m).filter(Boolean);

        return NextResponse.json({
            success: true,
            rates,
            usdThb,
            models,
            summary,
            byModel,
            daily,
            raw: rawRows,
            report,
            availableMonths,
        });
    } catch (error: any) {
        console.error("[Admin AI-Usage GET]", error);
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "admin-aiusage" });
    }
}

export async function POST(req: NextRequest) {
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;
    try {
        const { env } = await getCloudflareContext();
        if (!env?.DB) return fail(ErrorCode.SERVER_ERROR, { detail: "no DB binding", context: "admin-aiusage" });

        const body = await req.json() as { rates?: RateMap; usdThb?: number };
        const incoming = body.rates || {};
        // Sanitize: keep only finite, non-negative numbers.
        const clean: RateMap = {};
        for (const [model, r] of Object.entries(incoming)) {
            if (!model) continue;
            const input = Number((r as any)?.input);
            const output = Number((r as any)?.output);
            clean[model] = {
                input: Number.isFinite(input) && input >= 0 ? input : 0,
                output: Number.isFinite(output) && output >= 0 ? output : 0,
            };
        }

        await env.DB.prepare(
            `CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
        ).run();
        await env.DB.prepare(
            `INSERT INTO system_settings (key, value, updated_at)
             VALUES ('AI_TOKEN_RATES', ?, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).bind(JSON.stringify(clean)).run();

        // Persist the USD→THB rate when provided.
        const fx = Number(body.usdThb);
        if (Number.isFinite(fx) && fx > 0) {
            await env.DB.prepare(
                `INSERT INTO system_settings (key, value, updated_at)
                 VALUES ('AI_USD_THB', ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
            ).bind(String(fx)).run();
        }

        return NextResponse.json({ success: true, rates: clean });
    } catch (error: any) {
        console.error("[Admin AI-Usage POST]", error);
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "admin-aiusage" });
    }
}
