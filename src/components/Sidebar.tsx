"use client";
import React from "react";
import { User } from "@/lib/types";

interface SidebarProps {
    activeView: string;
    setActiveView: (view: any) => void;
    user: User | null;
    onProfileClick: () => void;
}

export default function Sidebar({ activeView, setActiveView, user, onProfileClick }: SidebarProps) {
    return (
        <nav className="w-20 lg:w-24 bg-white/70 dark:bg-slate-900/70 backdrop-blur-md border-r border-slate-200 dark:border-slate-800 flex flex-col items-center py-8 gap-10 sticky top-0 h-screen z-50">
            <div className="flex items-center justify-center p-2">
                <img src="/favicon.svg" alt="DOCRoom Icon" className="h-10 w-10 object-contain hover:scale-110 transition-transform" />
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
            </div>

            <button
                onClick={onProfileClick}
                className="h-12 w-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:scale-110 shadow-sm transition-all border border-slate-200 dark:border-slate-700"
            >
                {user?.name.charAt(0) || "U"}
            </button>
        </nav>
    );
}
