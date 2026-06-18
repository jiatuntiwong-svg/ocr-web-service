"use client";
import { useRouter } from "next/navigation";
import AdminLogsView from "@/components/AdminLogsView";
import AdminTabs from "@/components/AdminTabs";
import { useApp } from "@/lib/contexts/AppContext";
import { viewToPath } from "@/lib/routes";

export default function AdminLogsPage() {
    const router = useRouter();
    const { user } = useApp();
    return (
        <AdminTabs activeView="admin_logs" onTabChange={(v) => router.push(viewToPath(v))}>
            <AdminLogsView userId={user?.id || ""} />
        </AdminTabs>
    );
}
