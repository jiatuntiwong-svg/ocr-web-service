import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logSystemEvent } from "@/lib/logger";
import { generateWithAI, getActiveAIConfigs } from "@/lib/ai-handler";
import { extractDocumentTokens, matchValueToTokens, mergeTokenBoxes } from "@/lib/text-extractor";
import { OCRToken } from "@/lib/types";

type HighlightBox = {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
};

type CompareField = {
    key: string;
    is_diff: boolean;
    doc1?: string | null;
    doc2?: string | null;
    doc3?: string | null;
    locations?: {
        doc1?: HighlightBox[];
        doc2?: HighlightBox[];
        doc3?: HighlightBox[];
    };
};

const DOC_KEYS = ["doc1", "doc2", "doc3"] as const;

function parseSelectedFields(raw: string | null): string[] {
    return (raw || "")
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean);
}

function normalizeFieldKey(value: unknown): string {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function parseNumber(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function sanitizeLocation(loc: any): HighlightBox {
    let page = Math.max(1, Math.round(parseNumber(loc?.page, 1)));
    let x = parseNumber(loc?.x, 0);
    let y = parseNumber(loc?.y, 0);
    let width = parseNumber(loc?.width, 0);
    let height = parseNumber(loc?.height, 0);

    const maxVal = Math.max(x, y, width, height);
    if (maxVal > 1) {
        const scaleFactor = maxVal > 100 ? 1000 : 100;
        x /= scaleFactor;
        y /= scaleFactor;
        width /= scaleFactor;
        height /= scaleFactor;
    }

    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    width = Math.max(0, Math.min(1, width));
    height = Math.max(0, Math.min(1, height));

    if (x + width > 1) width = 1 - x;
    if (y + height > 1) height = 1 - y;

    return {
        page,
        x,
        y,
        width,
        height,
        text: typeof loc?.text === "string" ? loc.text : "",
    };
}

function sanitizeLocations(locations: any) {
    const sanitized: CompareField["locations"] = {};

    for (const docKey of DOC_KEYS) {
        if (Array.isArray(locations?.[docKey])) {
            sanitized[docKey] = locations[docKey].map(sanitizeLocation);
        }
    }

    return sanitized;
}

function createEmptyField(key: string, fileCount: number): CompareField {
    return {
        key,
        is_diff: false,
        doc1: null,
        doc2: null,
        ...(fileCount > 2 ? { doc3: null } : {}),
        locations: {
            doc1: [],
            doc2: [],
            ...(fileCount > 2 ? { doc3: [] } : {}),
        },
    };
}

function buildPrompt(selectedFields: string[], fileCount: number): string {
    const doc3Json = fileCount > 2 ? `,\n      "doc3": "value from document 3 or null"` : "";

    return `Compare these ${fileCount} documents only by the selected fields below.

Selected fields (strict list, preserve order exactly):
${selectedFields.map((field, index) => `${index + 1}. ${field}`).join("\n")}

Rules:
1. Return JSON only.
2. "fields" must contain exactly the selected fields above, in the same order.
3. Do not add new fields. Do not rename fields.
4. If a field is not found in a document, return null for that document.
5. Set is_diff to true only when values differ across documents.
6. VERY IMPORTANT: For fields that contain long text or terms (like 'เงื่อนไขชำระเงิน' or 'Payment Terms'), extract the EXACT text verbatim from the document. Include the label/prefix in the value. For example, output "เงื่อนไขชำระเงิน: เครดิต 30 วัน" instead of just "เครดิต 30 วัน". This allows exact block coordinates matching!
7. For Table fields, extract the list of items exact as they appear, separating row items by newlines.

Response schema:
{
  "summary": [
    "short difference summary 1",
    "short difference summary 2"
  ],
  "fields": [
    {
      "key": "${selectedFields[0] || "Field Name"}",
      "is_diff": false,
      "doc1": "value from document 1 or null",
      "doc2": "value from document 2 or null"${doc3Json}
    }
  ]
}`;
}

export async function POST(req: NextRequest) {
    let userId = "guest";

    try {
        const formData = await req.formData();
        userId = (formData.get("userId") as string) || "guest";
        const selectedModelId = (formData.get("selectedModelId") as string) || "";

        const files: File[] = [];
        if (formData.has("file1")) files.push(formData.get("file1") as unknown as File);
        if (formData.has("file2")) files.push(formData.get("file2") as unknown as File);
        if (formData.has("file3")) files.push(formData.get("file3") as unknown as File);

        if (files.length < 2) {
            return NextResponse.json({ error: "At least 2 documents are required" }, { status: 400 });
        }

        const selectedFieldsRaw = (formData.get("fields") as string | null) || "";
        const selectedFields = parseSelectedFields(selectedFieldsRaw);
        if (selectedFields.length === 0) {
            return NextResponse.json({ error: "At least one comparison field is required" }, { status: 400 });
        }

        const fieldTypes: Record<string, string> = {};
        const cleanSelectedFields = selectedFields.map(f => {
            const match = f.match(/^(.*?)\s*\((.*?)\)$/);
            if (match) {
                const name = match[1].trim();
                fieldTypes[normalizeFieldKey(name)] = match[2].trim().toLowerCase();
                return name;
            }
            return f;
        });

        const { env } = await getCloudflareContext();
        if (!env?.DB) {
            return NextResponse.json({ error: "Database not configured" }, { status: 500 });
        }

        if (userId !== "guest") {
            const userRes = await env.DB
                .prepare("SELECT credits_remaining, extra_credits, plan FROM users WHERE id = ?")
                .bind(userId)
                .first<{ credits_remaining: number; extra_credits: number; plan: string }>();

            if (!userRes) {
                return NextResponse.json({ error: "User not found" }, { status: 404 });
            }

            const totalAvailable = userRes.credits_remaining + userRes.extra_credits;
            if (totalAvailable <= 0) {
                return NextResponse.json({ error: "No credits remaining" }, { status: 403 });
            }

            if (userRes.credits_remaining > 0) {
                await env.DB.prepare("UPDATE users SET credits_remaining = credits_remaining - 1 WHERE id = ?").bind(userId).run();
            } else {
                await env.DB.prepare("UPDATE users SET extra_credits = extra_credits - 1 WHERE id = ?").bind(userId).run();
            }
        }

        const finalConfigs = await getActiveAIConfigs(env);
        let target = finalConfigs.find((config) => config.id === selectedModelId);
        if (!target) target = finalConfigs.find((config) => config.model.includes("pro")) || finalConfigs[0];

        if (!target) {
            return NextResponse.json({ error: "No AI configuration available" }, { status: 500 });
        }

        const matchingKeys = finalConfigs
            .filter((config) => config.provider === target.provider && config.model === target.model)
            .map((config) => config.apiKey);

        const prompt = buildPrompt(cleanSelectedFields, files.length);

        const fileBuffers = await Promise.all(files.map(f => f.arrayBuffer()));
        const imagesData = await Promise.all(
            files.map(async (file, i) => {
                const arrayBuffer = fileBuffers[i];
                return {
                    data: Buffer.from(arrayBuffer).toString("base64"),
                    mimeType: file.type || "image/jpeg",
                };
            })
        );
        
        // Read OCR tokens provided by frontend to avoid OOM or API mismatch on Edge
        const documentTokens: OCRToken[][] = [];
        for (let i = 0; i < files.length; i++) {
            const rawTokens = formData.get(`docTokens${i + 1}`);
            let tokens = [];
            if (typeof rawTokens === "string") {
                try {
                    tokens = JSON.parse(rawTokens);
                } catch { } // fallback to empty
            }
            documentTokens.push(tokens);
        }

        const startTime = Date.now();
        const text = await generateWithAI({
            provider: target.provider,
            model: target.model,
            prompt,
            images: imagesData,
            apiKeys: matchingKeys,
        });
        const processingTimeMs = Date.now() - startTime;

        const extracted: { summary: string[]; fields: CompareField[] } = { summary: [], fields: [] };
        const fieldMap = new Map<string, CompareField>();

        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                throw new Error("AI returned invalid format");
            }

            const parsed = JSON.parse(match[0]);
            const aiFields = Array.isArray(parsed?.fields)
                ? parsed.fields
                : Array.isArray(parsed?.differences)
                    ? parsed.differences
                    : [];

            if (Array.isArray(parsed?.summary)) {
                extracted.summary = parsed.summary.filter((item: unknown) => typeof item === "string");
            }

            for (const field of aiFields) {
                const normalizedKey = normalizeFieldKey(field?.key);
                // Also search in original selected fields if they didn't match cleanly
                const selectedKey = cleanSelectedFields.find((item) => normalizeFieldKey(item) === normalizedKey) 
                                 || selectedFields.find((item) => normalizeFieldKey(item) === normalizedKey);
                if (!selectedKey) continue;
                
                const isTableField = fieldTypes[normalizedKey] === "table";
                
                // Match text to OCR tokens
                const locs: any = { doc1: [], doc2: [], doc3: [] };
                
                if (field?.doc1 && documentTokens[0]) {
                    const counterpart = field.doc2 || field.doc3 || undefined;
                    const matchedTokens = matchValueToTokens(String(field.doc1), documentTokens[0], isTableField, String(counterpart || ""));
                    locs.doc1 = mergeTokenBoxes(matchedTokens);
                }
                if (field?.doc2 && documentTokens[1]) {
                    const counterpart = field.doc1 || field.doc3 || undefined;
                    const matchedTokens = matchValueToTokens(String(field.doc2), documentTokens[1], isTableField, String(counterpart || ""));
                    locs.doc2 = mergeTokenBoxes(matchedTokens);
                }
                if (field?.doc3 && documentTokens[2]) {
                    const counterpart = field.doc1 || field.doc2 || undefined;
                    const matchedTokens = matchValueToTokens(String(field.doc3), documentTokens[2], isTableField, String(counterpart || ""));
                    locs.doc3 = mergeTokenBoxes(matchedTokens);
                }

                fieldMap.set(selectedKey, {
                    key: selectedKey,
                    is_diff: Boolean(field?.is_diff),
                    doc1: field?.doc1 ?? null,
                    doc2: field?.doc2 ?? null,
                    ...(files.length > 2 ? { doc3: field?.doc3 ?? null } : {}),
                    locations: sanitizeLocations(locs),
                });
            }
        } catch (error: any) {
            return NextResponse.json({ error: error.message || "AI returned invalid format", raw: text }, { status: 502 });
        }

        extracted.fields = cleanSelectedFields.map((fieldKey) => {
            const existing = fieldMap.get(fieldKey) || fieldMap.get(selectedFields[cleanSelectedFields.indexOf(fieldKey)]) || createEmptyField(fieldKey, files.length);
            const values = [existing.doc1, existing.doc2, files.length > 2 ? existing.doc3 : undefined]
                .filter((value) => value !== undefined);
            const nonNullValues = values.filter((value) => value !== null);
            const isDiff = nonNullValues.length > 1 && new Set(nonNullValues).size > 1;

            return {
                ...createEmptyField(fieldKey, files.length),
                ...existing,
                key: fieldKey,
                is_diff: existing.is_diff || isDiff,
            };
        });

        await logSystemEvent(env, "DOCUMENT_COMPARE", `Compared ${files.length} documents with ${selectedFields.length} selected fields.`, "info", userId);

        return NextResponse.json({
            success: true,
            processing_time_ms: processingTimeMs,
            extracted_data: extracted,
        });
    } catch (error: any) {
        console.error("[Compare POST] error:", error);
        try {
            const { env } = await getCloudflareContext();
            if (env) {
                await logSystemEvent(env, "COMPARE_ERROR", error.message, "error", userId);
            }
        } catch (_) {
            // logging failure must not prevent the JSON error response
        }
        return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
    }
}
