import React from "react";
import Link from "next/link";

export default function NotFound() {
    return (
        <div className="min-h-screen flex items-center justify-center p-6 text-slate-900 dark:text-slate-100">
            <div className="max-w-xl w-full bg-white/70 dark:bg-slate-900/70 backdrop-blur-2xl rounded-[3rem] border border-white/20 dark:border-slate-800 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700">
                <div className="p-12 text-center space-y-8">
                    {/* Visual Indicator */}
                    <div className="relative mx-auto w-24 h-24">
                        <div className="absolute inset-0 bg-blue-500/20 blur-3xl rounded-full animate-pulse" />
                        <div className="relative h-full w-full bg-slate-900 dark:bg-blue-600 rounded-3xl flex items-center justify-center shadow-2xl shadow-blue-500/20">
                            <span className="text-white font-black text-3xl">404</span>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <h1 className="text-4xl font-black tracking-tight bg-gradient-to-br from-slate-900 to-slate-500 dark:from-white dark:to-slate-400 bg-clip-text text-transparent">
                            Room Not Found
                        </h1>
                        <p className="text-slate-500 dark:text-slate-400 font-medium">
                            It seems you've wandered into an unarchived section of the office. This document space doesn't exist yet.
                        </p>
                    </div>

                    <div className="pt-4 flex justify-center">
                        <Link
                            href="/"
                            className="px-10 py-4 bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-blue-500 transition-all shadow-xl shadow-blue-500/20 active:scale-95 group flex items-center gap-3"
                        >
                            <svg className="w-4 h-4 transition-transform group-hover:-translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                            </svg>
                            Return Home
                        </Link>
                    </div>

                    <div className="pt-6 border-t border-slate-100 dark:border-slate-800">
                        <div className="flex justify-center gap-6">
                            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">DOCRoom AI</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Intelligent Archiving</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
