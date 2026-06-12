"use client";
// Floating "Feedback" FAB mounted globally so users can report bugs or
// suggest features from any view. Opens an inline modal — no navigation,
// no lost work in progress. Submit POSTs to /api/feedback which writes to
// the `feedback` table (admin triage via AdminFeedbackView).

import React, { useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { apiError } from "@/lib/friendlyError";
import { ErrorCode } from "@/lib/errorCodes";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { useToast } from "@/components/Toast";

type Category = "bug" | "feature" | "other";

interface FeedbackButtonProps {
    userId?: string | null;
}

export default function FeedbackButton({ userId }: FeedbackButtonProps) {
    const { t } = useTranslation();
    const { showToast, toastNode } = useToast();
    const [open, setOpen] = useState(false);
    const [category, setCategory] = useState<Category>("bug");
    const [message, setMessage] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const reset = () => {
        setCategory("bug");
        setMessage("");
    };

    const submit = async () => {
        const trimmed = message.trim();
        if (!trimmed) return;
        setSubmitting(true);
        const res = await fetchJson("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                userId: userId || undefined,
                category,
                message: trimmed,
                pageUrl: typeof window !== "undefined" ? window.location.href : "",
                userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
            }),
        });
        setSubmitting(false);
        if (res.ok) {
            showToast(t("feedback.thanks"), "success");
            reset();
            setOpen(false);
        } else {
            showToast(apiError(res.code || ErrorCode.GENERIC, res.vars, t), "error");
        }
    };

    React.useEffect(() => {
        if (!open) return;
        const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [open]);

    const CATEGORIES: { value: Category; label: string }[] = [
        { value: "bug", label: t("feedback.categoryBug") },
        { value: "feature", label: t("feedback.categoryFeature") },
        { value: "other", label: t("feedback.categoryOther") },
    ];

    return (
        <>
            {toastNode}
            {/* FAB */}
            <button
                onClick={() => setOpen(true)}
                aria-label={t("feedback.openLabel")}
                title={t("feedback.openLabel")}
                style={{
                    position: "fixed", bottom: 22, right: 22, zIndex: 90,
                    width: 52, height: 52, borderRadius: "50%",
                    background: "var(--color-info)", color: "#fff",
                    border: "none", cursor: "pointer",
                    boxShadow: "0 8px 24px rgba(59,130,246,0.35), 0 2px 6px rgba(15,23,42,0.2)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "transform 0.18s ease, box-shadow 0.18s ease",
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.05)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
            >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
            </button>

            {open && (
                <div
                    onClick={() => setOpen(false)}
                    style={{
                        position: "fixed", inset: 0, zIndex: 200,
                        background: "rgba(15,23,42,0.55)", backdropFilter: "blur(2px)",
                        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
                    }}
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{
                            background: "var(--color-bg-card)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 14, padding: 22,
                            width: "100%", maxWidth: 460,
                            boxShadow: "0 24px 60px rgba(0,0,0,0.32)",
                            color: "var(--color-text-1)",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{t("feedback.title")}</h2>
                            <button
                                onClick={() => setOpen(false)}
                                style={{ background: "transparent", border: "none", color: "var(--color-text-3)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}
                                aria-label={t("common.close")}
                            >×</button>
                        </div>
                        <p style={{ fontSize: 12.5, color: "var(--color-text-3)", margin: "0 0 16px", lineHeight: 1.5 }}>
                            {t("feedback.subtitle")}
                        </p>

                        {/* Category chips */}
                        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
                            {CATEGORIES.map(c => {
                                const active = category === c.value;
                                return (
                                    <button
                                        key={c.value}
                                        onClick={() => setCategory(c.value)}
                                        style={{
                                            padding: "6px 12px",
                                            borderRadius: 18,
                                            border: `1px solid ${active ? "var(--color-info)" : "var(--color-border)"}`,
                                            background: active ? "rgba(59,130,246,0.13)" : "transparent",
                                            color: active ? "var(--color-info)" : "var(--color-text-2)",
                                            fontSize: 12, fontWeight: 600, cursor: "pointer",
                                            transition: "all 0.15s",
                                        }}
                                    >
                                        {c.label}
                                    </button>
                                );
                            })}
                        </div>

                        <textarea
                            value={message}
                            onChange={e => setMessage(e.target.value)}
                            placeholder={t("feedback.placeholder")}
                            rows={6}
                            maxLength={4000}
                            autoFocus
                            style={{
                                width: "100%", boxSizing: "border-box",
                                padding: "10px 12px", borderRadius: 8,
                                border: "1px solid var(--color-border)",
                                background: "var(--color-bg-elevated)",
                                color: "var(--color-text-1)",
                                fontSize: 13, lineHeight: 1.5, resize: "vertical",
                                fontFamily: "inherit", outline: "none",
                            }}
                        />
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                            <span style={{ fontSize: 11, color: "var(--color-text-4)" }}>
                                {message.length} / 4000
                            </span>
                            <span style={{ fontSize: 11, color: "var(--color-text-4)" }}>
                                {t("feedback.contextHint")}
                            </span>
                        </div>

                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
                            <button
                                onClick={() => setOpen(false)}
                                style={{
                                    padding: "7px 14px", borderRadius: 7,
                                    border: "1px solid var(--color-border)",
                                    background: "transparent", color: "var(--color-text-2)",
                                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                                }}
                            >{t("common.cancel")}</button>
                            <button
                                onClick={submit}
                                disabled={submitting || !message.trim()}
                                style={{
                                    padding: "7px 14px", borderRadius: 7,
                                    border: "none",
                                    background: "var(--color-info)", color: "#fff",
                                    fontSize: 12, fontWeight: 700,
                                    cursor: submitting || !message.trim() ? "not-allowed" : "pointer",
                                    opacity: submitting || !message.trim() ? 0.55 : 1,
                                }}
                            >
                                {submitting ? t("common.processing") : t("feedback.submit")}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
