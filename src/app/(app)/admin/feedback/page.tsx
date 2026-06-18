"use client";
import { useRouter } from "next/navigation";
import AdminFeedbackView from "@/components/AdminFeedbackView";
import AdminTabs from "@/components/AdminTabs";
import { viewToPath } from "@/lib/routes";

export default function AdminFeedbackPage() {
    const router = useRouter();
    return (
        <AdminTabs activeView="admin_feedback" onTabChange={(v) => router.push(viewToPath(v))}>
            <AdminFeedbackView />
        </AdminTabs>
    );
}
