"use client";
import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        // Check if already logged in
        fetch("/api/auth")
            .then(r => r.json())
            .then((d: any) => {
                if (d.user) router.replace("/");
            })
            .catch(() => { });
    }, [router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const res = await fetch("/api/auth", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json() as { success?: boolean; error?: string; user?: any };
            if (data.success) {
                // Store user info in localStorage for instant UI access
                localStorage.setItem("ocr_user", JSON.stringify(data.user));
                router.replace("/");
            } else {
                setError(data.error || "Login failed");
            }
        } catch {
            setError("Connection error. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    const fillDemo = (e: string, p: string) => {
        setEmail(e);
        setPassword(p);
        setError("");
    };

    if (!mounted) return null;

    return (
        <main className="min-h-screen bg-[#F8FAFC] dark:bg-slate-950 flex items-center justify-center p-6 font-[Outfit,sans-serif]">
            {/* Background Blobs */}
            <div className="fixed inset-0 pointer-events-none overflow-hidden">
                <div className="absolute -top-40 -left-40 w-[600px] h-[600px] bg-blue-500/10 rounded-full blur-3xl" />
                <div className="absolute -bottom-40 -right-40 w-[600px] h-[600px] bg-violet-500/10 rounded-full blur-3xl" />
            </div>

            <div className="relative w-full max-w-md space-y-6 animate-in fade-in slide-in-from-bottom-6 duration-700">

                {/* Logo */}
                <div className="text-center space-y-4">
                    <div className="flex items-center justify-center mx-auto">
                        <img src="/favicon.svg" alt="DOCRoom Logo" className="h-20 w-20 object-contain drop-shadow-2xl animate-in zoom-in-50 duration-1000" />
                    </div>
                    <div>
                        <h1 className="text-4xl font-black tracking-tighter text-slate-900 dark:text-white">
                            DOCRoom.<span className="text-blue-600">AI</span>
                        </h1>
                        <p className="text-slate-500 dark:text-slate-400 text-sm font-medium italic mt-1">Intelligence at the heart of your documents</p>
                    </div>
                </div>

                {/* Login Card */}
                <div className="bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-200 dark:border-slate-800 shadow-2xl shadow-slate-900/5 p-8">
                    <form onSubmit={handleLogin} className="space-y-5">
                        {/* Error */}
                        {error && (
                            <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-2xl px-4 py-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                                <div className="h-8 w-8 rounded-xl bg-rose-500 flex items-center justify-center flex-shrink-0">
                                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                </div>
                                <p className="text-sm font-bold text-rose-700 dark:text-rose-400">{error}</p>
                            </div>
                        )}

                        {/* Email */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 px-1">Email Address</label>
                            <div className="relative">
                                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207" /></svg>
                                </div>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={e => setEmail(e.target.value)}
                                    placeholder="you@company.com"
                                    required
                                    className="w-full pl-11 pr-4 py-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-900 dark:text-white placeholder:text-slate-400 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                                />
                            </div>
                        </div>

                        {/* Password */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 px-1">Password</label>
                            <div className="relative">
                                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                                </div>
                                <input
                                    type={showPassword ? "text" : "password"}
                                    value={password}
                                    onChange={e => setPassword(e.target.value)}
                                    placeholder="••••••••"
                                    required
                                    className="w-full pl-11 pr-12 py-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-900 dark:text-white placeholder:text-slate-400 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                                >
                                    {showPassword
                                        ? <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                                        : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                    }
                                </button>
                            </div>
                        </div>

                        {/* Submit */}
                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-4 mt-2 rounded-xl bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white font-black text-[11px] uppercase tracking-[0.2em] transition-all duration-300 shadow-xl shadow-blue-500/20 flex items-center justify-center gap-3 disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {loading ? (
                                <>
                                    <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    <span>Authenticating...</span>
                                </>
                            ) : (
                                <>
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" /></svg>
                                    Sign In
                                </>
                            )}
                        </button>
                    </form>
                </div>

                {/* Test Accounts */}
                <div className="bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-200 dark:border-slate-800 shadow-sm p-6">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">🧪 Test Accounts</p>
                    <div className="space-y-2">
                        {[
                            { label: "Free", email: "free@ocrpro.com", pass: "free1234", badge: "Free Plan", color: "slate" },
                            { label: "Starter", email: "starter@ocrpro.com", pass: "start123", badge: "Starter Plan", color: "blue" },
                            { label: "Pro", email: "pro@ocrpro.com", pass: "pro12345", badge: "Pro Plan", color: "violet" },
                            { label: "Enterprise", email: "ent@ocrpro.com", pass: "ent1234", badge: "Enterprise Plan", color: "emerald" },
                            { label: "Admin", email: "admin@ocrpro.com", pass: "admin1234", badge: "System Admin", color: "amber" },
                        ].map(acc => (
                            <button
                                key={acc.email}
                                onClick={() => fillDemo(acc.email, acc.pass)}
                                className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 border border-transparent hover:border-slate-100 dark:hover:border-slate-700 transition-all group text-left"
                            >
                                <div className="flex items-center gap-3">
                                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center text-xs font-black ${acc.color === 'violet' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-600' : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600'}`}>
                                        {acc.label.charAt(0)}
                                    </div>
                                    <div>
                                        <p className="text-xs font-bold text-slate-700 dark:text-slate-300">{acc.email}</p>
                                        <p className="text-[10px] text-slate-400">Password: <span className="font-mono font-bold">{acc.pass}</span></p>
                                    </div>
                                </div>
                                <span className={`text-[9px] font-black uppercase px-2 py-1 rounded-md ${acc.color === 'amber' ? 'bg-amber-100   dark:bg-amber-900/30   text-amber-600' :
                                    acc.color === 'emerald' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600' :
                                        acc.color === 'violet' ? 'bg-violet-100  dark:bg-violet-900/30  text-violet-600' :
                                            acc.color === 'blue' ? 'bg-blue-100    dark:bg-blue-900/30    text-blue-600' :
                                                'bg-slate-100   dark:bg-slate-800       text-slate-500'
                                    }`}>
                                    {acc.badge}
                                </span>
                            </button>
                        ))}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-3 text-center">Click any account to auto-fill credentials</p>
                </div>

                <p className="text-center text-[10px] text-slate-400">
                    DOCRoom.AI © 2026 · Enterprise AI Document Processing
                </p>
            </div>
        </main>
    );
}
