"use client";
import { useRouter } from "next/navigation";
import AdminAIUsageView from "@/components/AdminAIUsageView";
import AdminTabs from "@/components/AdminTabs";
import { useApp } from "@/lib/contexts/AppContext";
import { viewToPath } from "@/lib/routes";

export default function AdminAIUsagePage() {
    const router = useRouter();
    const { user } = useApp();
    return (
        <AdminTabs activeView="admin_ai_usage" onTabChange={(v) => router.push(viewToPath(v))}>
            <AdminAIUsageView userId={user?.id || ""} />
        </AdminTabs>
    );
}
