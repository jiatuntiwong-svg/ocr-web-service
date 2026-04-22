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

export interface UsageStats {
    totalDocs: number;
    creditsRemaining: number;
    limit: number;
    recentActivity?: any[];
    weeklyData?: number[];
    weekLabels?: string[];
    monthlyData?: number[];
    monthLabels?: string[];
    yearlyData?: number[];
    yearLabels?: string[];
    avgSpeedMs?: number;
    avgConfidence?: number;
}

export interface OCRToken {
    text: string;
    page: number; // 1-indexed
    x: number;
    y: number;
    width: number;
    height: number;
}
