"use client";
import React, { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";

// DOCRoom redesign sidebar — dark, icon + label, admin collapsible.
// Uses the app's existing view IDs so it slots into page.tsx without a mapping
// layer.

const ADMIN_VIEWS = new Set([
    "admin_users", "admin_ai_usage", "admin_logs", "admin_feedback", "admin_tier_control", "settings",
]);

export interface NavRailProps {
    activeView: string;
    onNavigate: (view: string) => void;
    accent?: string;
    collapsed: boolean;
    onToggleCollapse: () => void;
    isAdmin: boolean;
    user?: { name?: string; plan?: string };
    onLogout?: () => void;
    features?: { ocr?: boolean; compare?: boolean; public_api?: boolean };
}

interface Item { id: string; labelKey: string; icon: IconName; gate?: keyof NonNullable<NavRailProps["features"]> }

const USER_ITEMS: Item[] = [
    { id: "dashboard", labelKey: "nav.dashboard", icon: "Grid" },
    { id: "ocr",       labelKey: "nav.ocr",       icon: "Scan",       gate: "ocr" },
    { id: "compare",   labelKey: "nav.compare",   icon: "Compare",    gate: "compare" },
    { id: "documents", labelKey: "nav.documents", icon: "FileText" },
    // Billing hidden until Stripe integration is fixed. View + route still exist
    // so existing callers (e.g. tier-disabled upgrade prompts) keep working.
    // { id: "billing",   labelKey: "nav.billing",   icon: "CreditCard" },
];

const ADMIN_ITEMS: Item[] = [
    { id: "admin_users",        labelKey: "nav.users",       icon: "Users" },
    { id: "admin_ai_usage",     labelKey: "nav.aiUsage",     icon: "Cpu" },
    { id: "admin_logs",         labelKey: "nav.logs",        icon: "FileText" },
    { id: "admin_feedback",     labelKey: "nav.feedback",    icon: "FileText" },
    { id: "admin_tier_control", labelKey: "nav.tierControl", icon: "Sliders" },
    { id: "settings",           labelKey: "nav.apiSettings", icon: "Key" },
];

export default function NavRail({
    activeView, onNavigate, accent = "#06b6d4",
    collapsed, onToggleCollapse,
    isAdmin, user, onLogout, features,
}: NavRailProps) {
    const { t } = useTranslation();
    const onAdmin = ADMIN_VIEWS.has(activeView);
    const [adminOpen, setAdminOpen] = useState(onAdmin);
    const [hovered, setHovered] = useState<string | null>(null);

    useEffect(() => { if (onAdmin) setAdminOpen(true); }, [onAdmin]);

    const accentMid = accent + "33";

    const NavItem = ({ id, labelKey, icon, indent = false }: Item & { indent?: boolean }) => {
        const active = activeView === id;
        const Cmp = Icon[icon];
        const isHov = hovered === id;
        const label = t(labelKey);
        return (
            <button
                onClick={() => onNavigate(id)}
                onMouseEnter={() => setHovered(id)}
                onMouseLeave={() => setHovered(null)}
                title={collapsed ? label : ""}
                style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: collapsed ? "10px 0" : indent ? "9px 12px 9px 40px" : "10px 12px",
                    justifyContent: collapsed ? "center" : "flex-start",
                    background: active ? accentMid : isHov ? "var(--color-bg-elevated)" : "transparent",
                    borderRadius: 8, border: "none", cursor: "pointer",
                    color: active ? accent : isHov ? "var(--color-text-1)" : "var(--color-text-2)",
                    transition: "all 0.15s",
                    margin: "1px 8px",
                    width: "calc(100% - 16px)",
                    borderLeft: active && !collapsed ? `2px solid ${accent}` : "2px solid transparent",
                }}
            >
                <Cmp width={18} height={18} style={{ flexShrink: 0 }} />
                {!collapsed && (
                    <span style={{ fontSize: 13.5, fontWeight: active ? 600 : 400, whiteSpace: "nowrap" }}>
                        {label}
                    </span>
                )}
            </button>
        );
    };

    const userItemsVisible = USER_ITEMS.filter(it => !it.gate || features?.[it.gate] !== false);

    return (
        <div
            style={{
                width: collapsed ? 64 : 220,
                minWidth: collapsed ? 64 : 220,
                height: "100vh",
                background: "var(--color-bg-panel)",
                borderRight: "1px solid var(--color-border)",
                display: "flex", flexDirection: "column",
                transition: "width 0.2s ease, min-width 0.2s ease",
                overflow: "hidden", position: "sticky", top: 0, zIndex: 10,
            }}
        >
            {/* Logo — uses favicon.svg as single source of truth so brand stays in sync */}
            <div style={{
                padding: collapsed ? "20px 0 16px" : "20px 16px 16px",
                display: "flex", alignItems: "center", gap: 10,
                justifyContent: collapsed ? "center" : "flex-start",
                borderBottom: "1px solid var(--color-border)",
            }}>
                <img
                    src="/favicon.svg"
                    alt="DOCRoom"
                    style={{ width: 34, height: 34, flexShrink: 0, display: "block" }}
                />
                {!collapsed && (
                    <span style={{ fontWeight: 700, fontSize: 15.5, color: "var(--color-text-1)", letterSpacing: -0.3 }}>
                        DOCRoom
                    </span>
                )}
            </div>

            {/* Items */}
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "10px 0" }}>
                {!collapsed && (
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1.2, color: "var(--color-text-3)", textTransform: "uppercase", padding: "8px 20px 4px" }}>
                        {t("nav.menuHeader")}
                    </div>
                )}
                {userItemsVisible.map(it => <NavItem key={it.id} {...it} />)}

                {isAdmin && (
                    <>
                        <div style={{ height: 1, background: "var(--color-border)", margin: "10px 16px" }} />
                        {!collapsed ? (
                            <>
                                <button
                                    onClick={() => setAdminOpen(o => !o)}
                                    style={{
                                        width: "calc(100% - 16px)", display: "flex", alignItems: "center", justifyContent: "space-between",
                                        padding: "8px 12px", margin: "1px 8px", background: "transparent",
                                        border: "none", cursor: "pointer", borderRadius: 8,
                                        color: onAdmin ? accent : "var(--color-text-3)",
                                    }}
                                >
                                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <Icon.Shield width={14} height={14} />
                                        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1.2, textTransform: "uppercase" }}>
                                            {t("nav.adminHeader")}
                                        </span>
                                    </div>
                                    <Icon.ChevronDown
                                        width={14} height={14}
                                        style={{ transition: "transform 0.2s", transform: adminOpen ? "rotate(180deg)" : "none" }}
                                    />
                                </button>
                                {adminOpen && ADMIN_ITEMS.map(it => <NavItem key={it.id} {...it} indent />)}
                            </>
                        ) : (
                            ADMIN_ITEMS.map(it => <NavItem key={it.id} {...it} />)
                        )}
                    </>
                )}
            </div>

            {/* Bottom: collapse toggle + user */}
            <div style={{ borderTop: "1px solid var(--color-border)", padding: collapsed ? "12px 0" : "12px" }}>
                <button
                    onClick={onToggleCollapse}
                    title={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
                    style={{
                        width: "100%", display: "flex", alignItems: "center",
                        justifyContent: collapsed ? "center" : "flex-end",
                        padding: "6px 8px", background: "transparent", border: "none", cursor: "pointer",
                        color: "var(--color-text-3)", borderRadius: 6, marginBottom: 8,
                    }}
                >
                    {collapsed
                        ? <Icon.ChevronRight width={16} height={16} />
                        : (
                            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-3)" }}>
                                <Icon.ChevronLeft width={14} height={14} />
                                <span>{t("nav.collapseShort")}</span>
                            </div>
                        )}
                </button>

                <div style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: collapsed ? "8px 0" : "8px 6px",
                    justifyContent: collapsed ? "center" : "flex-start",
                }}>
                    <div style={{
                        width: 32, height: 32, borderRadius: "50%",
                        background: `linear-gradient(135deg, ${accent} 0%, #a78bfa 100%)`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 13, fontWeight: 700, color: "white", flexShrink: 0,
                    }}>
                        {(user?.name?.charAt(0) || "U").toUpperCase()}
                    </div>
                    {!collapsed && (
                        <div style={{ flex: 1, overflow: "hidden" }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {user?.name || t("nav.userDefault")}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--color-text-3)", whiteSpace: "nowrap" }}>
                                {user?.plan ? `${user.plan} ${t("nav.planSuffix")}` : t("nav.freePlan")}
                            </div>
                        </div>
                    )}
                    {!collapsed && onLogout && (
                        <button onClick={onLogout} title={t("nav.logout")}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-3)", padding: 4, borderRadius: 4 }}>
                            <Icon.LogOut width={16} height={16} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
