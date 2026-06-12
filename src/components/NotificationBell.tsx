"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";

// Bell + unread badge + dropdown. Polls /api/notifications every 30s.
// All writes (mark read / mark-all) go through PATCH on the same route.
// Visibility is auto-paused when the tab is hidden to avoid useless polling.

const POLL_MS = 30_000;

interface NotificationItem {
    id: string;
    audience: "user" | "admin";
    kind: string;
    severity: "info" | "warning" | "error";
    title: string;
    body: string | null;
    link: string | null;
    metadata: Record<string, unknown> | null;
    readAt: string | null;
    createdAt: string;
}

interface Props {
    userId: string;
    onNavigate?: (link: string) => void;  // when user clicks a notification with a link
}

const SEVERITY_COLOR: Record<string, string> = {
    info: "#06b6d4",
    warning: "#f59e0b",
    error: "#ef4444",
};

export default function NotificationBell({ userId, onNavigate }: Props) {
    const { t } = useTranslation();
    const [items, setItems] = useState<NotificationItem[]>([]);
    const [unread, setUnread] = useState(0);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    const fetchList = useCallback(async () => {
        if (!userId) return;
        try {
            const res = await fetch(`/api/notifications?userId=${encodeURIComponent(userId)}&limit=50`);
            if (!res.ok) return;
            const data = await res.json() as { success?: boolean; notifications?: NotificationItem[]; unreadCount?: number };
            if (data?.success) {
                setItems(data.notifications ?? []);
                setUnread(data.unreadCount ?? 0);
            }
        } catch {}
    }, [userId]);

    // Initial fetch + polling. Pause when tab is hidden so we don't burn
    // requests on backgrounded tabs.
    useEffect(() => {
        if (!userId) return;
        fetchList();
        let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
            if (!document.hidden) fetchList();
        }, POLL_MS);
        const onVisible = () => { if (!document.hidden) fetchList(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            if (timer) clearInterval(timer);
            timer = null;
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [userId, fetchList]);

    // Click-outside to close dropdown.
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    const markRead = async (id: string) => {
        // Optimistic — flip locally first, then PATCH.
        setItems((prev) => prev.map((n) => n.id === id ? { ...n, readAt: new Date().toISOString() } : n));
        setUnread((u) => Math.max(0, u - 1));
        try {
            await fetch("/api/notifications", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId, id }),
            });
        } catch {}
    };

    const markAll = async () => {
        if (unread === 0) return;
        setLoading(true);
        const now = new Date().toISOString();
        setItems((prev) => prev.map((n) => n.readAt ? n : { ...n, readAt: now }));
        setUnread(0);
        try {
            await fetch("/api/notifications", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId, markAll: true }),
            });
        } catch {}
        setLoading(false);
    };

    const handleItemClick = (n: NotificationItem) => {
        if (!n.readAt) markRead(n.id);
        if (n.link && onNavigate) onNavigate(n.link);
    };

    const iconBtnStyle: React.CSSProperties = {
        width: 32, height: 32, borderRadius: 8,
        background: "var(--color-bg-elevated)", color: "var(--color-text-2)",
        border: "1px solid var(--color-border)", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.15s, color 0.15s",
        position: "relative",
    };

    return (
        <div ref={rootRef} style={{ position: "relative" }}>
            <button
                title={t("common.notifications")}
                style={iconBtnStyle}
                onClick={() => setOpen((o) => !o)}
                aria-label={t("common.notifications")}
            >
                <Icon.Bell width={15} height={15} />
                {unread > 0 && (
                    <span
                        style={{
                            position: "absolute",
                            top: -4, right: -4,
                            minWidth: 16, height: 16,
                            padding: "0 4px",
                            borderRadius: 8,
                            background: "#ef4444",
                            color: "white",
                            fontSize: 10,
                            fontWeight: 700,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            lineHeight: 1,
                            border: "2px solid var(--color-bg-body)",
                            boxSizing: "content-box",
                        }}
                    >
                        {unread > 99 ? "99+" : unread}
                    </span>
                )}
            </button>

            {open && (
                <div
                    data-notif-dropdown
                    style={{
                        position: "absolute",
                        top: "calc(100% + 8px)",
                        right: 0,
                        width: 360,
                        maxHeight: 480,
                        background: "var(--color-bg-elevated)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 10,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                        zIndex: 50,
                        display: "flex", flexDirection: "column",
                        overflow: "hidden",
                    }}
                >
                    <div style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid var(--color-border)",
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                    }}>
                        <strong style={{ fontSize: 13, color: "var(--color-text-1)" }}>
                            {t("common.notifications")}
                        </strong>
                        <button
                            onClick={markAll}
                            disabled={unread === 0 || loading}
                            style={{
                                background: "none",
                                border: "none",
                                color: unread === 0 ? "var(--color-text-4)" : "var(--color-accent, #6366f1)",
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: unread === 0 ? "default" : "pointer",
                                padding: 0,
                            }}
                        >
                            {t("notifications.markAllRead")}
                        </button>
                    </div>

                    <div style={{ overflowY: "auto", flex: 1 }}>
                        {items.length === 0 ? (
                            <div style={{ padding: 32, textAlign: "center", color: "var(--color-text-4)", fontSize: 12 }}>
                                {t("notifications.empty")}
                            </div>
                        ) : (
                            items.map((n) => (
                                <button
                                    key={n.id}
                                    onClick={() => handleItemClick(n)}
                                    style={{
                                        width: "100%",
                                        textAlign: "left",
                                        padding: "10px 14px",
                                        background: n.readAt ? "transparent" : "color-mix(in srgb, var(--color-accent, #6366f1) 6%, transparent)",
                                        border: "none",
                                        borderBottom: "1px solid var(--color-border)",
                                        cursor: "pointer",
                                        display: "flex",
                                        gap: 10,
                                        alignItems: "flex-start",
                                    }}
                                >
                                    <span
                                        aria-hidden
                                        style={{
                                            width: 8, height: 8, borderRadius: 4,
                                            marginTop: 6, flexShrink: 0,
                                            background: SEVERITY_COLOR[n.severity] ?? SEVERITY_COLOR.info,
                                        }}
                                    />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{
                                            fontSize: 12.5,
                                            fontWeight: n.readAt ? 500 : 700,
                                            color: "var(--color-text-1)",
                                            marginBottom: 2,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}>
                                            {n.title}
                                        </div>
                                        {n.body && (
                                            <div style={{
                                                fontSize: 11.5,
                                                color: "var(--color-text-3)",
                                                lineHeight: 1.4,
                                                marginBottom: 2,
                                            }}>
                                                {n.body}
                                            </div>
                                        )}
                                        <div style={{ fontSize: 10.5, color: "var(--color-text-4)" }}>
                                            {formatRelativeTime(n.createdAt)}
                                            {n.audience === "admin" && (
                                                <span style={{
                                                    marginLeft: 6,
                                                    padding: "1px 6px",
                                                    borderRadius: 4,
                                                    background: "rgba(16,185,129,0.15)",
                                                    color: "#10b981",
                                                    fontWeight: 600,
                                                }}>
                                                    ADMIN
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function formatRelativeTime(iso: string): string {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
}
