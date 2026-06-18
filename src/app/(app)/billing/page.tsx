"use client";
import BillingView from "@/components/BillingView";
import { useApp } from "@/lib/contexts/AppContext";

export default function BillingPage() {
    const { user } = useApp();
    return <BillingView userPlan={user?.plan || "Free"} userId={user?.id || ""} />;
}
