// AI-1: "ทดสอบการเชื่อมต่อ" endpoint. The client sends only the config `id`;
// the server looks up the actual stored key and issues a minimal 1-token
// generateContent request. This keeps the key server-only (SEC-4): the
// browser never sees, sends, or receives the plaintext key on this path.
//
// Response is a code (`ok` / `AI_FAILED` / `AI_UNAVAILABLE`) — never the
// upstream error body (SEC-6). Upstream error messages are still logged
// server-side via `fail()`, which routes them through `redactSecrets()`.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { fail, ok, ErrorCode } from "@/lib/apiResponse";
import { generateWithAI, getActiveAIConfigs } from "@/lib/ai-handler";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function POST(req: NextRequest) {
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;

    try {
        const { id } = (await req.json()) as { id?: string };
        if (!id) return fail(ErrorCode.BAD_REQUEST, { context: "settings-test" });

        const { env } = await getCloudflareContext();
        const configs = await getActiveAIConfigs(env);
        const target = configs.find((c: any) => c.id === id);
        if (!target) return fail(ErrorCode.NOT_FOUND, { context: "settings-test" });

        // Cheapest useful call: ask for a single token.
        const result = await generateWithAI({
            provider: target.provider,
            model: target.model,
            prompt: "Reply with the single word: ok",
            apiKeys: [target.apiKey],
            location: target.location,
        });

        return ok({ provider: target.provider, model: target.model, sample: (result.text || "").slice(0, 40) });
    } catch (err: any) {
        return fail(ErrorCode.AI_FAILED, { detail: err, context: "settings-test" });
    }
}
