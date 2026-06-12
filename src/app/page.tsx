"use client";
import React, { useEffect } from "react";
import DashboardView from "@/components/DashboardView";
import OCRWorkspace from "@/components/OCRWorkspace";
import dynamic from "next/dynamic";

const CompareWorkspace = dynamic(() => import("@/components/CompareWorkspace"), { ssr: false });
import AdminUsersView from "@/components/AdminUsersView";
import AdminLogsView from "@/components/AdminLogsView";
import AdminAIUsageView from "@/components/AdminAIUsageView";
import AdminTierControlView from "@/components/AdminTierControlView";
import AdminFeedbackView from "@/components/AdminFeedbackView";
import NavRail from "@/components/NavRail";
import TopBar from "@/components/TopBar";
import AdminTabs from "@/components/AdminTabs";
import BillingView from "@/components/BillingView";
import FeedbackButton from "@/components/FeedbackButton";
import DocumentsView from "@/components/DocumentsView";
import APISettingsView from "@/components/APISettingsView";
import { useAuth } from "@/lib/hooks/useAuth";
import { useStats } from "@/lib/hooks/useStats";
import { useState } from "react";
import { useTranslation } from "@/lib/i18n/LocaleContext";

// Shown when the current tier has a feature toggled off (admin Tier Control).
function FeatureDisabled({ name, onUpgrade }: { name: string; onUpgrade: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center justify-center text-center py-24 px-6 rounded-3xl"
      style={{
        background: "var(--color-bg-card)",
        border: "1px solid var(--color-border)",
        color: "var(--color-text-1)",
      }}
    >
      <div
        className="h-16 w-16 rounded-2xl flex items-center justify-center mb-5"
        style={{ background: "var(--color-bg-elevated)", color: "var(--color-text-3)" }}
      >
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
      </div>
      <h2 className="text-xl font-black" style={{ color: "var(--color-text-1)" }}>
        {t("feature.disabledTitle", { name })}
      </h2>
      <p className="text-sm mt-2 max-w-md" style={{ color: "var(--color-text-2)" }}>
        {t("feature.disabledDesc")}
      </p>
      <button
        onClick={onUpgrade}
        className="mt-6 px-6 py-3 rounded-xl text-white text-xs font-black uppercase tracking-[0.15em] hover:opacity-90 transition-all shadow-md"
        style={{ background: "var(--color-info)" }}
      >
        {t("feature.viewPlan")}
      </button>
    </div>
  );
}

export default function Home() {
  const { t } = useTranslation();
  // ─── Custom Hooks ─────────────────────────────────────────────
  const { user, authChecked, handleLogout } = useAuth();
  const { usageStats, fetchStats } = useStats(user);

  // ─── Local State ─────────────────────────────────────────────
  const [activeView, setActiveView] = useState<'ocr' | 'compare' | 'documents' | 'dashboard' | 'settings' | 'billing' | 'admin_users' | 'admin_logs' | 'admin_ai_usage' | 'admin_tier_control' | 'admin_feedback'>('ocr');
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [navCollapsed, setNavCollapsed] = useState(false);

  // Auto-collapse the side nav on narrow viewports (tablet portrait + phones).
  // Tracks viewport width so the user can still toggle manually after — we
  // only force-collapse on the FIRST transition into < 1024px, not every
  // resize tick. Re-expands when the window grows back past the breakpoint.
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

  // Fetch stats on user ready
  useEffect(() => { if (user) fetchStats(); }, [user, fetchStats]);

  // Refresh stats whenever the dashboard is opened so Recent Activity picks
  // up runs (OCR / compare) done since the page first loaded.
  useEffect(() => {
    if (user && activeView === 'dashboard') fetchStats();
  }, [activeView, user, fetchStats]);



  // Auth loading screen
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
            <div className="h-4 w-4 border-2 rounded-full animate-spin" style={{ borderColor: "var(--color-border-strong)", borderTopColor: "var(--color-info)" }} />
            <span className="text-sm font-bold">{t("auth.checking")}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen flex" style={{ background: "var(--color-bg-body)", color: "var(--color-text-1)" }}>
      <NavRail
        activeView={activeView}
        onNavigate={(v) => setActiveView(v as typeof activeView)}
        collapsed={navCollapsed}
        onToggleCollapse={() => setNavCollapsed(c => !c)}
        isAdmin={user?.role === 'admin'}
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
            // Notification links use top-level view ids ("/documents", "/billing", ...).
            // Strip the leading slash and switch view if it matches one we know about.
            const view = link.replace(/^\//, "").split("?")[0].split("/")[0];
            const known = ['dashboard','ocr','compare','documents','billing','admin_users','admin_ai_usage','admin_logs','admin_tier_control','admin_feedback','settings'];
            if (known.includes(view)) setActiveView(view as typeof activeView);
          }}
        />
        <div key={activeView} className="flex-1 overflow-y-auto custom-scrollbar view-enter">
          <div className="p-5">
            {activeView === 'ocr' ? (
              usageStats.features?.ocr === false
                ? <FeatureDisabled name={t("feature.ocr")} onUpgrade={() => setActiveView('billing')} />
                : <OCRWorkspace user={user} balance={usageStats.creditsRemaining} onDocumentProcessed={fetchStats} onNavigateToBilling={() => setActiveView('billing')} />
            ) : activeView === 'compare' ? (
              usageStats.features?.compare === false
                ? <FeatureDisabled name={t("feature.compare")} onUpgrade={() => setActiveView('billing')} />
                : <CompareWorkspace user={user} balance={usageStats.creditsRemaining} />
            ) : activeView === 'documents' ? (
              <DocumentsView userId={user?.id || ""} />
            ) : activeView === 'dashboard' ? (
              <DashboardView usageStats={usageStats} userName={user?.name} userPlan={user?.plan} userId={user?.id || ""} />
            ) : activeView === 'settings' ? (
              <AdminTabs activeView={activeView} onTabChange={(v) => setActiveView(v as typeof activeView)}><APISettingsView /></AdminTabs>
            ) : activeView === 'admin_users' ? (
              <AdminTabs activeView={activeView} onTabChange={(v) => setActiveView(v as typeof activeView)}><AdminUsersView /></AdminTabs>
            ) : activeView === 'admin_logs' ? (
              <AdminTabs activeView={activeView} onTabChange={(v) => setActiveView(v as typeof activeView)}><AdminLogsView userId={user?.id || ""} /></AdminTabs>
            ) : activeView === 'admin_ai_usage' ? (
              <AdminTabs activeView={activeView} onTabChange={(v) => setActiveView(v as typeof activeView)}><AdminAIUsageView userId={user?.id || ""} /></AdminTabs>
            ) : activeView === 'admin_tier_control' ? (
              <AdminTabs activeView={activeView} onTabChange={(v) => setActiveView(v as typeof activeView)}><AdminTierControlView userId={user?.id || ""} /></AdminTabs>
            ) : activeView === 'admin_feedback' ? (
              <AdminTabs activeView={activeView} onTabChange={(v) => setActiveView(v as typeof activeView)}><AdminFeedbackView /></AdminTabs>
            ) : (
              <BillingView userPlan={user?.plan || "Free"} userId={user?.id || ""} />
            )}
          </div>
        </div>
      </div>
      <FeedbackButton userId={user?.id} />
    </main>
  );
}

