"use client";
import React, { useEffect } from "react";
import DashboardView from "@/components/DashboardView";
import OCRWorkspace from "@/components/OCRWorkspace";
import AdminUsersView from "@/components/AdminUsersView";
import BillingView from "@/components/BillingView";
import APISettingsView from "@/components/APISettingsView";
import { useAuth } from "@/lib/hooks/useAuth";
import { useStats } from "@/lib/hooks/useStats";
import { useState } from "react";

export default function Home() {
  // ─── Custom Hooks ─────────────────────────────────────────────
  const { user, authChecked, handleLogout } = useAuth();
  const { usageStats, fetchStats } = useStats(user);

  // ─── Local State ─────────────────────────────────────────────
  const [activeView, setActiveView] = useState<'ocr' | 'dashboard' | 'settings' | 'billing' | 'admin_users'>('ocr');
  const [result, setResult] = useState<Record<string, any> | null>(null);

  // Fetch stats on user ready
  useEffect(() => { if (user) fetchStats(); }, [user, fetchStats]);



  // Auth loading screen
  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] dark:bg-slate-950 flex items-center justify-center font-[Outfit,sans-serif]">
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center mx-auto">
            <img src="/favicon.svg" alt="DOCRoom Logo" className="h-16 w-16 object-contain" />
          </div>
          <div className="flex items-center gap-2 text-slate-400">
            <div className="h-4 w-4 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
            <span className="text-sm font-bold">Authenticating...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-transparent flex font-[Outfit,sans-serif] text-slate-900 dark:text-slate-100 transition-colors duration-500">
      {/* Global App Sidebar (Saas Menu) */}
      <nav className="w-20 lg:w-24 bg-white/70 dark:bg-slate-900/70 backdrop-blur-md border-r border-slate-200 dark:border-slate-800 flex flex-col items-center py-8 gap-10 sticky top-0 h-screen z-50">
        <div className="flex items-center justify-center px-4 w-full">
          <img src="/favicon.svg" alt="DOCRoom Icon" className="h-10 w-10 object-contain" />
        </div>

        <div className="flex-1 flex flex-col gap-6">
          <button
            onClick={() => setActiveView('ocr')}
            className={`p-4 rounded-2xl transition-all group ${activeView === 'ocr' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/20' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            title="OCR Workspace"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          </button>
          <button
            onClick={() => setActiveView('dashboard')}
            className={`p-4 rounded-2xl transition-all group ${activeView === 'dashboard' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/20' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            title="Usage Dashboard"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" /></svg>
          </button>
          {user?.role === 'admin' && (
            <button
              onClick={() => setActiveView('settings')}
              className={`p-4 rounded-2xl transition-all group ${activeView === 'settings' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/20' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
              title="API & Settings"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
            </button>
          )}
          <button
            onClick={() => setActiveView('billing')}
            className={`p-4 rounded-2xl transition-all group ${activeView === 'billing' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/20' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            title="Billing & Plans"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
          </button>

          {/* Admin-only: User Management */}
          {user?.role === 'admin' && (
            <button
              onClick={() => setActiveView('admin_users')}
              className={`p-4 rounded-2xl transition-all group relative ${activeView === 'admin_users' ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/20' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
              title="Admin: User Management"
            >
              <div className="absolute -top-1 -right-1 h-2.5 w-2.5 bg-amber-500 rounded-full shadow-sm shadow-amber-500/50" />
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
            </button>
          )}
        </div>

        {/* Avatar + Logout */}
        <div className="relative group/avatar flex flex-col items-center gap-2">
          <div className="h-12 w-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white font-black text-sm shadow-lg shadow-blue-500/20 cursor-default">
            {user?.name?.charAt(0)?.toUpperCase() || "U"}
          </div>
          <button
            onClick={handleLogout}
            title="Sign Out"
            className="h-8 w-8 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-900/20 transition-all border border-slate-200 dark:border-slate-700"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
          </button>
        </div>
      </nav>

      <div className="flex-1 p-6 lg:p-12 overflow-y-auto custom-scrollbar">
        {/* Top Header Bar */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-12 gap-6">
          <div className="space-y-1">
            <h1 className="text-4xl font-black tracking-tight bg-gradient-to-br from-slate-900 to-slate-500 dark:from-white dark:to-slate-400 bg-clip-text text-transparent">
              {activeView === 'ocr' ? 'DOCRoom.AI'
                : activeView === 'dashboard' ? 'Insight Hub'
                  : activeView === 'settings' ? 'API Settings'
                    : activeView === 'admin_users' ? 'User Management'
                      : 'Premium Plans'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 font-medium text-sm italic">
              Empowering your workflow with Intelligent OCR
            </p>
          </div>

          <div className="flex items-center gap-4 bg-white/50 dark:bg-slate-900/50 backdrop-blur-md px-6 py-3 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
            <div className="flex flex-col text-right">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Current Plan</span>
              <span className="text-sm font-bold text-blue-600">
                {(user?.plan ? user.plan.charAt(0).toUpperCase() + user.plan.slice(1).toLowerCase() : "Free")} Plan
              </span>
            </div>
            <div className="h-8 w-[1px] bg-slate-100 dark:bg-slate-700 mx-2" />
            <div className="flex flex-col">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Credits</span>
              <span className="text-sm font-bold dark:text-white">
                {usageStats.limit >= 999999 ? "Unlimited" : usageStats.creditsRemaining} {usageStats.limit >= 999999 ? "" : `/ ${usageStats.limit}`}
              </span>
            </div>
          </div>
        </div>

        {activeView === 'ocr' ? (
          <OCRWorkspace user={user} onDocumentProcessed={fetchStats} />
        ) : activeView === 'dashboard' ? (
          <DashboardView usageStats={usageStats} userName={user?.name} userPlan={user?.plan} />
        ) : activeView === 'settings' ? (
          <APISettingsView />
        ) : activeView === 'admin_users' ? (
          <AdminUsersView />
        ) : (
          <BillingView userPlan={user?.plan || "Free"} userId={user?.id || ""} />
        )}
      </div>
    </main>
  );
}

