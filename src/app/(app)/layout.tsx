"use client";
import React, { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import NavRail from "@/components/NavRail";
import TopBar from "@/components/TopBar";
import FeedbackButton from "@/components/FeedbackButton";
import { useAuth } from "@/lib/hooks/useAuth";
import { useStats } from "@/lib/hooks/useStats";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { AppProvider } from "@/lib/contexts/AppContext";
import type { BatchItem } from "@/lib/types/batch";
import { pathToView, viewToPath } from "@/lib/routes";

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
    const { t } = useTranslation();
    const router = useRouter();
    const pathname = usePathname() || "/";
    const activeView = pathToView(pathname);

    const { user, authChecked, handleLogout } = useAuth();
    const { usageStats, fetchStats } = useStats(user);
    const [navCollapsed, setNavCollapsed] = useState(false);

    // Batch state hoisted here so /ocr → /documents → /ocr keeps the list.
    const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
    const [batchRunning, setBatchRunning] = useState(false);

    // Auto-collapse the side nav on narrow viewports.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const apply = () => {
            const narrow = window.innerWidth < 1024;
            setNavCollapsed(prev => (narrow !== prev ? narrow : prev));
        };
        apply();
        window.addEventListener("resize", apply);
        return () => window.removeEventListener("resize", apply);
    }, []);

    useEffect(() => { if (user) fetchStats(); }, [user, fetchStats]);

    // Re-fetch stats when entering the dashboard so Recent Activity stays fresh.
    useEffect(() => {
        if (user && activeView === "dashboard") fetchStats();
    }, [activeView, user, fetchStats]);

    if (!authChecked) {
        return (
            <div
                className="min-h-screen flex items-center justify-center"
                style={{ background: "var(--color-bg-body)", color: "var(--color-text-1)" }}
            >
                <div className="text-center space-y-4">
                    <div className="flex items-center justify-center mx-auto">
                        <img src="/favicon.svg" alt="DOCRoom Logo" className="h-16 w-16 object-contain" />
                    </div>
                    <div className="flex items-center gap-2" style={{ color: "var(--color-text-3)" }}>
                        <div
                            className="h-4 w-4 border-2 rounded-full animate-spin"
                            style={{ borderColor: "var(--color-border-strong)", borderTopColor: "var(--color-info)" }}
                        />
                        <span className="text-sm font-bold">{t("auth.checking")}</span>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <AppProvider value={{ user, usageStats, fetchStats, handleLogout, batchItems, setBatchItems, batchRunning, setBatchRunning }}>
            <main className="min-h-screen flex" style={{ background: "var(--color-bg-body)", color: "var(--color-text-1)" }}>
                <NavRail
                    activeView={activeView}
                    onNavigate={(v) => router.push(viewToPath(v))}
                    collapsed={navCollapsed}
                    onToggleCollapse={() => setNavCollapsed(c => !c)}
                    isAdmin={user?.role === "admin"}
                    user={{ name: user?.name, plan: user?.plan }}
                    onLogout={handleLogout}
                    features={usageStats.features}
                />
                <div className="flex-1 flex flex-col min-w-0">
                    <TopBar
                        activeView={activeView}
                        creditsLabel={usageStats.limit >= 999999 ? "Unlimited" : String(usageStats.creditsRemaining)}
                        planLabel={user?.plan ? user.plan.charAt(0).toUpperCase() + user.plan.slice(1).toLowerCase() : "Free"}
                        userId={user?.id}
                        onNotificationNavigate={(link) => {
                            // Notification links may be plain view ids ("/documents") or include
                            // deep-link query strings. Pass through to the router as-is.
                            const href = link.startsWith("/") ? link : "/" + link;
                            router.push(href);
                        }}
                    />
                    <div key={activeView} className="flex-1 overflow-y-auto custom-scrollbar view-enter">
                        <div className="p-5">{children}</div>
                    </div>
                </div>
                <FeedbackButton userId={user?.id} />
            </main>
        </AppProvider>
    );
}
