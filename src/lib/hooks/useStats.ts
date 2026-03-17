/**
 * useStats.ts
 * Fetches and manages OCR usage statistics for the current user.
 */
"use client";
import { useState, useCallback } from "react";
import { User, UsageStats } from "@/lib/types";

const DEFAULT_STATS: UsageStats = {
    totalDocs: 0,
    creditsRemaining: 0,
    limit: 0,
    recentActivity: [],
    weeklyData: [],
    weekLabels: [],
    monthlyData: [],
    monthLabels: [],
    yearlyData: [],
    yearLabels: [],
    avgSpeedMs: 0,
    avgConfidence: 0,
};

export function useStats(user: User | null) {
    const [usageStats, setUsageStats] = useState<UsageStats>(DEFAULT_STATS);

    const fetchStats = useCallback(async () => {
        if (!user) return;
        try {
            const res = await fetch(
                `/api/stats?userId=${user.id}&plan=${user.plan || "Free"}`
            );
            const data = (await res.json()) as any;
            if (data && typeof data.totalDocs === "number") {
                setUsageStats({
                    totalDocs: data.totalDocs,
                    limit: data.limit || 0,
                    creditsRemaining: data.creditsRemaining || 0,
                    recentActivity: data.recentActivity || [],
                    weeklyData: data.weeklyData || [],
                    weekLabels: data.weekLabels || [],
                    monthlyData: data.monthlyData || [],
                    monthLabels: data.monthLabels || [],
                    yearlyData: data.yearlyData || [],
                    yearLabels: data.yearLabels || [],
                    avgSpeedMs: data.avgSpeedMs || 0,
                    avgConfidence: data.avgConfidence || 0,
                });
            }
        } catch (err) {
            console.error("fetchStats error:", err);
        }
    }, [user]);

    return { usageStats, fetchStats };
}
