"use client";
import { useRouter } from "next/navigation";
import APISettingsView from "@/components/APISettingsView";
import AdminTabs from "@/components/AdminTabs";
import { viewToPath } from "@/lib/routes";

export default function SettingsPage() {
    const router = useRouter();
    return (
        <AdminTabs activeView="settings" onTabChange={(v) => router.push(viewToPath(v))}>
            <APISettingsView />
        </AdminTabs>
    );
}
