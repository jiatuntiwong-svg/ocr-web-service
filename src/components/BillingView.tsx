"use client";
import React, { useState } from 'react';

interface BillingViewProps {
    userPlan: string;
    userId: string;
}

export default function BillingView({ userPlan, userId }: BillingViewProps) {
    const [loading, setLoading] = useState<string | null>(null);
    const [isSuccess, setIsSuccess] = useState(false);
    const [prices, setPrices] = useState<Record<string, string>>({});
    const currentPlan = userPlan?.toLowerCase() || 'free';

    React.useEffect(() => {
        // Fetch real prices from Stripe
        fetch('/api/billing/prices')
            .then(res => res.json())
            .then(data => setPrices(data as Record<string, any>))
            .catch(err => console.error("Price fetch error:", err));

        const params = new URLSearchParams(window.location.search);
        if (params.get('billing') === 'success') {
            setIsSuccess(true);
            const timer = setTimeout(() => setIsSuccess(false), 10000);
            return () => clearTimeout(timer);
        }
    }, []);

    const handleCheckout = async (plan: string, type: 'subscription' | 'topup', credits?: number) => {
        setLoading(plan);
        try {
            const response = await fetch('/api/billing/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, plan, type, credits }),
            });
            const data = await response.json() as { url?: string; error?: string };
            if (data.url) {
                window.location.href = data.url;
            } else {
                alert(data.error || "Failed to initiate checkout");
            }
        } catch (err) {
            console.error(err);
            alert("Something went wrong");
        } finally {
            setLoading(null);
        }
    };

    const plans = [
        {
            id: "free",
            name: "Free",
            price: "THB 0",
            period: "forever",
            docs: "50 Documents / mo",
            features: ["Standard Precision OCR", "3 Templates saved", "Community Support"],
            active: currentPlan === "free"
        },
        {
            id: "starter",
            name: "Starter",
            price: prices.starter || "$9",
            period: "/ mo",
            docs: "500 Documents / mo",
            features: ["High Precision OCR", "20 Templates saved", "CSV & Excel Export", "Standard API Access"],
            active: currentPlan === "starter"
        },
        {
            id: "pro",
            name: "Pro",
            price: prices.pro || "$19",
            period: "/ mo",
            docs: "1,000 Documents / mo",
            popular: true,
            features: ["Max Precision OCR", "Unlimited Templates", "Priority Processing", "Webhook Support", "1-on-1 Support"],
            active: currentPlan === "pro"
        },
        {
            id: "enterprise",
            name: "Enterprise",
            price: prices.enterprise || "$99",
            period: "/ mo",
            docs: "Unlimited Docs",
            features: ["Custom AI Training", "Full Audit Logs", "Dedicated Server", "Unlimited API Access", "Account Manager"],
            active: currentPlan === "enterprise"
        }
    ];

    const tokenPackages = [
        { id: "Topup50", tokens: 50, price: "$5.99", popular: false },
        { id: "Topup100", tokens: 100, price: "$9.99", popular: true },
        { id: "Topup500", tokens: 500, price: "$39.99", popular: false },
    ];

    return (
        <div className="space-y-12 animate-in fade-in slide-in-from-right-5 duration-700">
            {loading && (
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[100] flex items-center justify-center">
                    <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-2xl flex flex-col items-center gap-4">
                        <div className="h-10 w-10 border-4 border-slate-100 border-t-blue-600 rounded-full animate-spin" />
                        <span className="text-sm font-black uppercase tracking-widest dark:text-white">Connecting to Stripe...</span>
                    </div>
                </div>
            )}

            {/* Plans Section */}
            <div>
                <div className="mb-8">
                    <h2 className="text-2xl font-black tracking-tight dark:text-white mb-2">Subscription Plans</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Choose the right processing power for your business needs.</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {plans.map((plan) => (
                        <div
                            key={plan.id}
                            className={`p-8 rounded-[2.5rem] relative transition-all flex flex-col h-full bg-white dark:bg-slate-900 border ${plan.popular ? "border-blue-500 shadow-xl shadow-blue-500/10 ring-4 ring-blue-500/20 md:-translate-y-2" :
                                plan.active ? "border-emerald-500 ring-2 ring-emerald-500/30" : "border-slate-200 dark:border-slate-800"
                                }`}
                        >
                            {plan.active ? (
                                <div className="absolute top-0 right-1/2 translate-x-1/2 -mt-3.5">
                                    <span className={`${isSuccess ? "bg-blue-600 animate-bounce" : "bg-emerald-500"} text-white text-[9px] font-black px-3 py-1 rounded-full uppercase tracking-widest shadow-lg whitespace-nowrap`}>
                                        {isSuccess ? "✨ Newly Upgraded" : "Current Plan"}
                                    </span>
                                </div>
                            ) : plan.popular ? (
                                <div className="absolute top-0 right-1/2 translate-x-1/2 -mt-3.5">
                                    <span className="bg-blue-600 text-white text-[9px] font-black px-3 py-1 rounded-full uppercase tracking-widest shadow-lg shadow-blue-500/30 whitespace-nowrap">
                                        Most Popular
                                    </span>
                                </div>
                            ) : null}

                            <h4 className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400 mb-4">{plan.name}</h4>
                            <p className="text-4xl font-black mb-1 dark:text-white">{plan.price} <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{plan.period}</span></p>
                            <p className="text-sm font-bold text-blue-600 dark:text-blue-400 mb-8 pb-8 border-b border-slate-100 dark:border-slate-800">{plan.docs}</p>

                            <div className="space-y-4 mb-10 flex-grow">
                                {plan.features.map((f, i) => (
                                    <div key={i} className="flex items-start gap-3">
                                        <svg className="w-5 h-5 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                        <span className="text-xs font-bold text-slate-600 dark:text-slate-300">{f}</span>
                                    </div>
                                ))}
                            </div>

                            {plan.active ? (
                                <button disabled className="w-full py-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 font-black text-[10px] uppercase tracking-[0.2em] opacity-80 cursor-default">
                                    Active
                                </button>
                            ) : (
                                <button
                                    onClick={() => handleCheckout(plan.id, 'subscription')}
                                    disabled={plan.id === 'free'}
                                    className={`w-full py-3.5 rounded-xl font-black text-[10px] uppercase tracking-[0.2em] transition-all ${plan.popular ? "bg-blue-600 text-white hover:bg-blue-500 shadow-xl shadow-blue-600/20" :
                                        "border-2 border-slate-100 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-900 hover:text-white dark:hover:bg-slate-800"
                                        }`}>
                                    Upgrade
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            <div className="border-t border-slate-200 dark:border-slate-800 my-10" />

            {/* Pay As You Go Section */}
            <div>
                <div className="mb-8 max-w-xl">
                    <h2 className="text-2xl font-black tracking-tight dark:text-white mb-2">Need Extra Tokens?</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Buy additional on-demand OCR tokens (credits) at any time. Tokens never expire and are added directly to your account limit.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {tokenPackages.map((pkg, i) => (
                        <div key={i}
                            onClick={() => handleCheckout(pkg.id, 'topup', pkg.tokens)}
                            className="relative bg-slate-50 dark:bg-slate-900/50 p-6 rounded-[2rem] border border-slate-200 dark:border-slate-800 flex items-center justify-between group hover:border-blue-500 hover:shadow-lg hover:shadow-blue-500/10 transition-all cursor-pointer">
                            {pkg.popular && (
                                <div className="absolute top-0 right-0 p-4">
                                    <span className="bg-amber-100 dark:bg-amber-900/30 text-amber-600 text-[9px] font-black px-2 py-1 rounded-md uppercase tracking-wider">
                                        Best Value
                                    </span>
                                </div>
                            )}
                            <div>
                                <p className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                                    {pkg.tokens} <span className="text-xs font-bold text-slate-400 mt-1 uppercase tracking-wider">OCR Tokens</span>
                                </p>
                                <p className="text-sm font-bold text-blue-600 mt-1">{pkg.price}</p>
                            </div>
                            <button className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-5 py-3 rounded-full text-[10px] font-black uppercase tracking-widest shadow-md group-hover:bg-blue-600 group-hover:text-white transition-all transform group-hover:scale-105 active:scale-95">
                                Buy Now
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
