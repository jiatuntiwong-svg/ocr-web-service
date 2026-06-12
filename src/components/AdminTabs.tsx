"use client";
import React from "react";
import { Icon, type IconName } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";

// Tab bar shown above every admin view — lets the admin switch sections
// without going back to the sidebar (mirrors the redesign spec).

const TABS: { id: string; i18nKey: string; icon: IconName }[] = [
    { id: "admin_users",        i18nKey: "nav.users",       icon: "Users" },
    { id: "admin_ai_usage",     i18nKey: "nav.aiUsage",     icon: "Cpu" },
    { id: "admin_logs",         i18nKey: "nav.logs",        icon: "FileText" },
    { id: "admin_feedback",     i18nKey: "nav.feedback",    icon: "FileText" },
    { id: "admin_tier_control", i18nKey: "nav.tierControl", icon: "Sliders" },
    { id: "settings",           i18nKey: "nav.apiSettings", icon: "Key" },
];

export interface AdminTabsProps {
    activeView: string;
    onTabChange: (id: string) => void;
    accent?: string;
    children: React.ReactNode;
}

export default function AdminTabs({ activeView, onTabChange, accent = "#10b981", children }: AdminTabsProps) {
    const { t } = useTranslation();
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <div style={{
                display: "flex", gap: 4,
                padding: "0 20px",
                borderBottom: "1px solid var(--color-border)",
                marginBottom: 20,
                overflowX: "auto",
            }} className="custom-scrollbar">
                {TABS.map(tab => {
                    const active = activeView === tab.id;
                    const Cmp = Icon[tab.icon];
                    return (
                        <button
                            key={tab.id}
                            onClick={() => onTabChange(tab.id)}
                            style={{
                                display: "flex", alignItems: "center", gap: 7,
                                padding: "12px 14px",
                                background: "transparent",
                                border: "none",
                                borderBottom: `2px solid ${active ? accent : "transparent"}`,
                                color: active ? accent : "var(--color-text-3)",
                                fontSize: 13,
                                fontWeight: active ? 600 : 500,
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                                marginBottom: -1,
                                transition: "all 0.15s",
                            }}
                        >
                            <Cmp width={14} height={14} />
                            {t(tab.i18nKey)}
                        </button>
                    );
                })}
            </div>
            <div>{children}</div>
        </div>
    );
}
