"use client";
import React from "react";

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    message?: string;
    confirmLabel: string;
    cancelLabel: string;
    tone?: "danger" | "info";
    onConfirm: () => void;
    onCancel: () => void;
}

// Lightweight modal replacement for window.confirm — keeps look consistent
// with the rest of the app (dark backdrop, themed buttons) and supports
// keyboard cancel (Esc).
export default function ConfirmDialog({
    open, title, message, confirmLabel, cancelLabel,
    tone = "info", onConfirm, onCancel,
}: ConfirmDialogProps) {
    React.useEffect(() => {
        if (!open) return;
        const h = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [open, onCancel]);

    if (!open) return null;
    const confirmBg = tone === "danger" ? "var(--color-danger)" : "var(--color-info)";

    return (
        <div
            onClick={onCancel}
            style={{
                position: "fixed", inset: 0, zIndex: 200,
                background: "rgba(15, 23, 42, 0.55)",
                backdropFilter: "blur(2px)",
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 16,
                animation: "fadeIn 0.15s ease-out",
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    background: "var(--color-bg-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 12,
                    padding: 20,
                    maxWidth: 360, width: "100%",
                    boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
                    color: "var(--color-text-1)",
                }}
            >
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: message ? 8 : 16 }}>{title}</div>
                {message && (
                    <div style={{ fontSize: 13, color: "var(--color-text-2)", marginBottom: 18, lineHeight: 1.45 }}>
                        {message}
                    </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button
                        onClick={onCancel}
                        style={{
                            padding: "7px 14px", borderRadius: 7,
                            border: "1px solid var(--color-border)",
                            background: "transparent", color: "var(--color-text-2)",
                            fontSize: 12, fontWeight: 600, cursor: "pointer",
                        }}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        onClick={onConfirm}
                        style={{
                            padding: "7px 14px", borderRadius: 7,
                            border: "none",
                            background: confirmBg, color: "#fff",
                            fontSize: 12, fontWeight: 700, cursor: "pointer",
                        }}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
