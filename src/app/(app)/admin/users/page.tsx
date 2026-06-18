"use client";
import { useRouter } from "next/navigation";
import AdminUsersView from "@/components/AdminUsersView";
import AdminTabs from "@/components/AdminTabs";
import { viewToPath } from "@/lib/routes";

export default function AdminUsersPage() {
    const router = useRouter();
    return (
        <AdminTabs activeView="admin_users" onTabChange={(v) => router.push(viewToPath(v))}>
            <AdminUsersView />
        </AdminTabs>
    );
}
