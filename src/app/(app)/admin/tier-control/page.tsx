"use client";
import { useRouter } from "next/navigation";
import AdminTierControlView from "@/components/AdminTierControlView";
import AdminTabs from "@/components/AdminTabs";
import { useApp } from "@/lib/contexts/AppContext";
import { viewToPath } from "@/lib/routes";

export default function AdminTierControlPage() {
    const router = useRouter();
    const { user } = useApp();
    return (
        <AdminTabs activeView="admin_tier_control" onTabChange={(v) => router.push(viewToPath(v))}>
            <AdminTierControlView userId={user?.id || ""} />
        </AdminTabs>
    );
}
