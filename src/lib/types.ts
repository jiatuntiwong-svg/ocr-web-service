export interface ExtractField {
    id: string;
    name: string;
    type: "text" | "date" | "table";
}

export interface OCRResult {
    [key: string]: any;
}

export interface User {
    id: string;
    name: string;
    email?: string;
    role?: string;
    plan?: "Free" | "Starter" | "Pro" | "Enterprise" | "System";
    avatar?: string;
}

export interface Template {
    id: string;
    name: string;
    fields_json: string;
    user_id?: string;
}

export interface FunctionUsage {
    calls: number;        // all-time AI calls for this function
    monthCalls: number;   // calls in the current calendar month
}

export interface UsageStats {
    totalDocs: number;
    creditsRemaining: number;
    limit: number;
    recentActivity?: any[];
    weeklyData?: number[];
    weekLabels?: string[];
    monthlyData?: number[];
    monthLabels?: string[];
    // Compare counts per bucket — aligned with weeklyData/monthlyData indices.
    weeklyCompareData?: number[];
    monthlyCompareData?: number[];
    yearlyData?: number[];
    yearLabels?: string[];
    avgSpeedMs?: number;
    avgConfidence?: number;
    // Per-function AI usage breakdown (OCR / Compare / Public API).
    functionUsage?: {
        ocr: FunctionUsage;
        compare: FunctionUsage;
        api_extract: FunctionUsage;
    };
    // Resolved feature flags for this user's tier (client-side gating).
    features?: {
        ocr: boolean;
        compare: boolean;
        public_api: boolean;
    };
}

export interface OCRToken {
    text: string;
    page: number; // 1-indexed
    x: number;
    y: number;
    width: number;
    height: number;
}
