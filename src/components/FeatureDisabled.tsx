"use client";
import React from "react";
import { useTranslation } from "@/lib/i18n/LocaleContext";

export default function FeatureDisabled({ name, onUpgrade }: { name: string; onUpgrade: () => void }) {
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
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
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
