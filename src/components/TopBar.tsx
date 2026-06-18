"use client";
import React from "react";
import { Icon, type IconName } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { useTheme } from "@/lib/hooks/useTheme";
import NotificationBell from "./NotificationBell";

// Compact top bar (52px) — shows current view + credits/plan chip.
// Title/subtitle come from i18n via VIEW_META keyed on activeView IDs.

const VIEW_META: Record<string, { i18nKey: string; icon: IconName; accent: string }> = {
    dashboard:           { i18nKey: "dashboard",        icon: "Grid",       accent: "#06b6d4" },
    ocr:                 { i18nKey: "ocr",              icon: "Scan",       accent: "#6366f1" },
    compare:             { i18nKey: "compare",          icon: "Compare",    accent: "#f59e0b" },
    documents:           { i18nKey: "documents",        icon: "FileText",   accent: "#8b5cf6" },
    billing:             { i18nKey: "billing",          icon: "CreditCard", accent: "#06b6d4" },
    admin_users:         { i18nKey: "adminUsers",       icon: "Users",      accent: "#10b981" },
    admin_ai_usage:      { i18nKey: "adminAiUsage",     icon: "Cpu",        accent: "#10b981" },
    admin_logs:          { i18nKey: "adminLogs",        icon: "FileText",   accent: "#10b981" },
    admin_feedback:      { i18nKey: "adminFeedback",    icon: "FileText",   accent: "#10b981" },
    admin_tier_control:  { i18nKey: "adminTierControl", icon: "Sliders",    accent: "#10b981" },
    settings:            { i18nKey: "settings",         icon: "Key",        accent: "#10b981" },
};

export interface TopBarProps {
    activeView: string;
    creditsLabel?: string;     // e.g. "1,580" or "Unlimited"
    planLabel?: string;        // e.g. "Pro"
    userId?: string;           // for notification polling — omit to hide bell
    onNotificationNavigate?: (link: string) => void;
}

export default function TopBar({ activeView, creditsLabel, planLabel, userId, onNotificationNavigate }: TopBarProps) {
    const { t, locale, setLocale } = useTranslation();
    const { theme, toggleTheme } = useTheme();
    const meta = VIEW_META[activeView] || VIEW_META.dashboard;
    const Cmp = Icon[meta.icon];
    const title = t(`views.${meta.i18nKey}.title`);
    const subtitle = t(`views.${meta.i18nKey}.subtitle`);

    const iconBtnStyle: React.CSSProperties = {
        width: 32, height: 32, borderRadius: 8,
        background: "var(--color-bg-elevated)", color: "var(--color-text-2)",
        border: "1px solid var(--color-border)", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.15s, color 0.15s",
    };

    return (
        <div
            style={{
                height: 52,
                background: "color-mix(in srgb, var(--color-bg-body) 80%, transparent)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                borderBottom: "1px solid var(--color-border)",
                display: "flex", alignItems: "center", gap: 12,
                padding: "0 20px",
                position: "sticky", top: 0, zIndex: 5,
            }}
        >
            <div style={{
                width: 28, height: 28, borderRadius: 8,
                background: meta.accent + "22", color: meta.accent,
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
                <Cmp width={16} height={16} />
            </div>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: "var(--color-text-1)", whiteSpace: "nowrap" }}>{title}</span>
            <span data-topbar-subtitle style={{ color: "var(--color-text-4)", fontSize: 12 }}>·</span>
            <span data-topbar-subtitle style={{ fontSize: 13, color: "var(--color-text-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {subtitle}
            </span>

            <div style={{ flex: 1 }} />

            {creditsLabel !== undefined && (
                <div data-topbar-chip style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "6px 10px", borderRadius: 8,
                    background: "rgba(245,158,11,0.1)", color: "#f59e0b",
                    fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                }}>
                    <Icon.Zap width={13} height={13} />
                    <span>{t("common.credits")}: {creditsLabel}</span>
                </div>
            )}
            {planLabel && (
                <div data-topbar-chip style={{
                    padding: "6px 10px", borderRadius: 8,
                    background: meta.accent + "1a", color: meta.accent,
                    fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                }}>
                    {t("common.plan")}: {planLabel}
                </div>
            )}
            {/* Locale toggle */}
            <button
                onClick={() => setLocale(locale === "th" ? "en" : "th")}
                title={`Locale: ${locale.toUpperCase()}`}
                style={{ ...iconBtnStyle, width: "auto", padding: "0 10px", gap: 5, fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}
            >
                <Icon.Globe width={13} height={13} />
                <span>{locale.toUpperCase()}</span>
            </button>

            {/* Theme toggle */}
            <button
                onClick={toggleTheme}
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                style={iconBtnStyle}
            >
                {theme === "dark" ? <Icon.Sun width={15} height={15} /> : <Icon.Moon width={15} height={15} />}
            </button>

            {userId
                ? <NotificationBell userId={userId} onNavigate={onNotificationNavigate} />
                : (
                    <button title={t("common.notifications")} style={iconBtnStyle}>
                        <Icon.Bell width={15} height={15} />
                    </button>
                )
            }
        </div>
    );
}
