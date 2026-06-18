"use client";
import DashboardView from "@/components/DashboardView";
import { useApp } from "@/lib/contexts/AppContext";

export default function DashboardPage() {
    const { user, usageStats } = useApp();
    return (
        <DashboardView
            usageStats={usageStats}
            userName={user?.name}
            userPlan={user?.plan}
            userId={user?.id || ""}
        />
    );
}
