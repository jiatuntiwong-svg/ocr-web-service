"use client";

import React, { useEffect } from "react";
import Link from "next/link";

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        // Log the error to an error reporting service
        console.error(error);
    }, [error]);

    return (
        <div className="min-h-screen flex items-center justify-center p-6 text-slate-900 dark:text-slate-100">
            <div className="max-w-xl w-full bg-white/70 dark:bg-slate-900/70 backdrop-blur-2xl rounded-[3rem] border border-white/20 dark:border-slate-800 shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-500">
                <div className="p-12 text-center space-y-8">
                    {/* Visual Indicator */}
                    <div className="relative mx-auto w-24 h-24">
                        <div className="absolute inset-0 bg-rose-500/20 blur-3xl rounded-full" />
                        <div className="relative h-full w-full bg-rose-500 rounded-3xl flex items-center justify-center shadow-2xl shadow-rose-500/40 rotate-3">
                            <svg className="w-12 h-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <h1 className="text-4xl font-black tracking-tight bg-gradient-to-br from-slate-900 to-slate-500 dark:from-white dark:to-slate-400 bg-clip-text text-transparent">
                            System Disturbance
                        </h1>
                        <p className="text-slate-500 dark:text-slate-400 font-medium">
                            We encountered an unexpected digital roadblock. DOCRoom components are having trouble communicating.
                        </p>
                    </div>

                    <div className="pt-4 flex flex-col sm:flex-row gap-4 justify-center">
                        <button
                            onClick={() => reset()}
                            className="px-8 py-4 bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-blue-500 transition-all shadow-xl shadow-blue-500/20 active:scale-95"
                        >
                            Initialize Recovery
                        </button>
                        <Link
                            href="/"
                            className="px-8 py-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 dark:hover:bg-slate-700 transition-all active:scale-95"
                        >
                            Go to Headquarters
                        </Link>
                    </div>

                    <div className="pt-6 border-t border-slate-100 dark:border-slate-800">
                        <p className="text-[10px] font-mono text-slate-400 dark:text-slate-500 tracking-tighter uppercase">
                            Error Digest: {error.digest || "Local Fault Instance"}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
