import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { PLAN_LIMITS } from "@/lib/devUsers";

export const runtime = "edge";

const getPlanLimit = (plan?: string) => PLAN_LIMITS[plan?.toLowerCase() ?? ""] ?? 50;

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const userId = searchParams.get("userId");
        const plan = searchParams.get("plan") || "Free";

        if (!userId) {
            return NextResponse.json({ error: "Missing userId" }, { status: 400 });
        }

        const { env } = await getCloudflareContext();
        let totalDocs = 0;
        let customLimit: number | null = null;
        let dbPlan = plan;
        let creditsRemaining = 0;
        let recentDocs: any[] = [];
        let weeklyStats: any[] = [];
        let avgSpeedMs = 0;
        let avgConfidence = 0;
        const confidenceCount = 0;

        if (env?.DB) {
            // Fetch fresh user data (plan and credits)
            const userRow = await env.DB
                .prepare("SELECT plan, credits_remaining, extra_credits FROM users WHERE id = ?")
                .bind(userId)
                .first<{ plan: string; credits_remaining: number; extra_credits: number }>();

            if (userRow) {
                dbPlan = userRow.plan;
                creditsRemaining = userRow.credits_remaining + userRow.extra_credits;
            }

            // Count total documents
            const countRow = await env.DB
                .prepare("SELECT COUNT(*) as count FROM documents WHERE user_id = ?")
                .bind(userId)
                .first();
            totalDocs = (countRow?.count as number) || 0;

            // Fetch custom limit if it exists
            try {
                const limitRow = await env.DB
                    .prepare("SELECT custom_limit FROM user_limits WHERE user_id = ?")
                    .bind(userId)
                    .first();
                if (limitRow && limitRow.custom_limit !== null) {
                    customLimit = Number(limitRow.custom_limit);
                }
            } catch (err) {
                // Table might not exist yet, ignore
            }

            // Fetch recent 5 documents
            try {
                const { results } = await env.DB
                    .prepare("SELECT id, file_name as name, status, created_at, raw_json FROM documents WHERE user_id = ? ORDER BY created_at DESC LIMIT 5")
                    .bind(userId)
                    .all();
                recentDocs = results || [];
            } catch (err) {
                console.error("Error fetching recent docs:", err);
            }

            // Fetch weekly data (last 7 days grouped by date)
            try {
                const { results } = await env.DB
                    .prepare(`
                        SELECT date(created_at) as date, COUNT(*) as count 
                        FROM documents 
                        WHERE user_id = ? AND created_at >= date('now', '-6 days')
                        GROUP BY date(created_at)
                        ORDER BY date ASC
                    `)
                    .bind(userId)
                    .all();
                weeklyStats = results || [];
            } catch (err) {
                console.error("Error fetching weekly data:", err);
            }

            // Fetch average processing time
            try {
                const avgRow = await env.DB
                    .prepare("SELECT AVG(processing_time_ms) as avg_speed FROM documents WHERE user_id = ? AND status = 'completed'")
                    .bind(userId)
                    .first();
                avgSpeedMs = Number(avgRow?.avg_speed) || 0;

                // Dynamic Confidence calculation
                const { results: allDocs } = await env.DB
                    .prepare("SELECT raw_json FROM documents WHERE user_id = ? AND status = 'completed' AND raw_json IS NOT NULL")
                    .bind(userId)
                    .all<{ raw_json: string }>();

                let totalConf = 0;
                let fieldsCount = 0;

                allDocs.forEach(doc => {
                    try {
                        const parsed = JSON.parse(doc.raw_json);
                        Object.values(parsed).forEach((field: any) => {
                            if (field && typeof field === 'object' && 'confidence' in field) {
                                totalConf += Number(field.confidence) || 0;
                                fieldsCount++;
                            }
                        });
                    } catch (e) { }
                });

                if (fieldsCount > 0) {
                    avgConfidence = Math.round(totalConf / fieldsCount);
                } else {
                    avgConfidence = 95; // Default for completed docs if no precise data
                }
            } catch (err) {
                console.error("Error fetching avg stats:", err);
                avgConfidence = 89; // Fallback
            }
        }

        const baseLimit = getPlanLimit(dbPlan);
        const effectiveLimit = customLimit !== null ? customLimit : baseLimit;

        let refinedLimit = effectiveLimit;
        if (effectiveLimit === Infinity || effectiveLimit >= 999999) {
            refinedLimit = 999999;
        }

        // If DB didn't provide credits, calculate based on docs
        const calculatedCredits = Math.max(0, refinedLimit - totalDocs);
        if (!env?.DB) creditsRemaining = calculatedCredits;

        // Format weekly data into a 7-day array
        const weeklyDataArray = [0, 0, 0, 0, 0, 0, 0];
        const weekLabels = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
            weekLabels.push(dayName);

            const found = weeklyStats.find(stat => stat.date === dateStr);
            if (found) {
                weeklyDataArray[6 - i] = Number(found.count) || 0;
            }
        }

        // Fetch monthly data
        let monthlyStats: any[] = [];
        try {
            if (env?.DB) {
                const { results } = await env.DB
                    .prepare(`
                        SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count 
                        FROM documents 
                        WHERE user_id = ? AND created_at >= date('now', '-5 months')
                        GROUP BY strftime('%Y-%m', created_at)
                        ORDER BY month ASC
                    `)
                    .bind(userId)
                    .all();
                monthlyStats = results || [];
            }
        } catch (err) {
            console.error("Error fetching monthly data:", err);
        }

        const monthlyDataArray = [0, 0, 0, 0, 0, 0];
        const monthLabels = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
            const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const monthName = d.toLocaleDateString('en-US', { month: 'short' });
            monthLabels.push(monthName);

            const found = monthlyStats.find(stat => stat.month === monthStr);
            if (found) {
                monthlyDataArray[5 - i] = Number(found.count) || 0;
            }
        }

        // Fetch yearly data
        let yearlyStats: any[] = [];
        try {
            if (env?.DB) {
                const { results } = await env.DB
                    .prepare(`
                        SELECT strftime('%Y', created_at) as year, COUNT(*) as count 
                        FROM documents 
                        WHERE user_id = ? AND created_at >= date('now', '-4 years')
                        GROUP BY strftime('%Y', created_at)
                        ORDER BY year ASC
                    `)
                    .bind(userId)
                    .all();
                yearlyStats = results || [];
            }
        } catch (err) {
            console.error("Error fetching yearly data:", err);
        }

        const yearlyDataArray = [0, 0, 0, 0, 0];
        const yearLabels = [];
        for (let i = 4; i >= 0; i--) {
            const yearStr = String(today.getFullYear() - i);
            yearLabels.push(yearStr);

            const found = yearlyStats.find(stat => stat.year === yearStr);
            if (found) {
                yearlyDataArray[4 - i] = Number(found.count) || 0;
            }
        }

        return NextResponse.json({
            totalDocs,
            limit: refinedLimit,
            creditsRemaining: refinedLimit >= 999999 ? 999999 : creditsRemaining,
            recentActivity: recentDocs.map(doc => {
                let parsedJson = null;
                try {
                    if (doc.raw_json) parsedJson = JSON.parse(doc.raw_json as string);
                } catch (e) {
                    // ignore parse error
                }
                return {
                    id: doc.id as string,
                    name: doc.name as string,
                    status: doc.status as string,
                    time: doc.created_at as string,
                    confidence: doc.status === 'completed' ? 95 : 0,
                    template: "Auto",
                    pages: 1,
                    data_extracted: parsedJson
                };
            }),
            weeklyData: weeklyDataArray,
            weekLabels: weekLabels,
            monthlyData: monthlyDataArray,
            monthLabels: monthLabels,
            yearlyData: yearlyDataArray,
            yearLabels: yearLabels,
            avgSpeedMs: avgSpeedMs,
            avgConfidence: avgConfidence || 89
        });
    } catch (err: any) {
        console.error("[Stats GET] error:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
