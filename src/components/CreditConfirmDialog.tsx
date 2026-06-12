"use client";
import React, { useState } from "react";
import { Icon } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import {
    rememberSkip,
    type ConfirmReason,
    type ConfirmThresholds,
    loadThresholds,
} from "@/lib/credit-preferences";
import { creditTone } from "@/lib/pricing";

export interface CreditConfirmDialogProps {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    credits: number;
    balance: number;
    reasons: ConfirmReason[];
    /** Breakdown rows from `estimateCredits().steps` */
    steps: { label: string; value: string }[];
    /** Fingerprint to remember if user ticks "don't ask again". */
    fingerprint: string;
    /** Avg + thresholds used to render reason copy. */
    userAvg?: number;
    thresholds?: ConfirmThresholds;
}

const TONE_COLOR: Record<string, string> = {
    green:  "var(--color-success)",
    amber:  "var(--color-warning)",
    orange: "#f97316",
    red:    "var(--color-danger)",
};

export default function CreditConfirmDialog(props: CreditConfirmDialogProps) {
    const { t } = useTranslation();
    const [skip, setSkip] = useState(false);

    if (!props.open) return null;

    const th = props.thresholds ?? loadThresholds();
    const accent = TONE_COLOR[creditTone(props.credits)];
    const after = props.balance - props.credits;

    const reasonText = (r: ConfirmReason): string => {
        switch (r) {
            case "T1_abs_high":
                return t("credits.reasonT1", { n: th.absolute });
            case "T2_rel_spike":
                return t("credits.reasonT2", { avg: props.userAvg?.toFixed(1) ?? "?" });
            case "T3_table_field":
                return t("credits.reasonT3");
            case "T4_low_balance":
                return t("credits.reasonT4", { pct: Math.round(th.lowBalance * 100) });
        }
    };

    const handleConfirm = () => {
        if (skip) rememberSkip(props.fingerprint);
        props.onConfirm();
    };

    return (
        <div
            role="dialog"
            aria-modal
            onClick={props.onCancel}
            style={{
                position: "fixed", inset: 0, zIndex: 200,
                background: "rgba(0,0,0,0.55)",
                backdropFilter: "blur(3px)",
                display: "flex", alignItems: "center", justifyContent: "center",
                animation: "fadeIn 0.15s ease",
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: "min(440px, 92vw)",
                    background: "var(--color-bg-card)",
                    border: "1px solid var(--color-border-strong)",
                    borderRadius: 14,
                    padding: 22,
                    color: "var(--color-text-1)",
                    boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
                }}
            >
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                    <div style={{
                        width: 36, height: 36, borderRadius: 9,
                        background: `${accent}22`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                        <Icon.AlertCircle width={18} height={18} color={accent} />
                    </div>
                    <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
                        {t("credits.confirmTitle", { n: props.credits })}
                    </h3>
                </div>

                {/* Reason chips */}
                {props.reasons.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 14 }}>
                        {props.reasons.map(r => (
                            <div key={r} style={{
                                fontSize: 11.5, color: accent,
                                background: `${accent}14`,
                                border: `1px solid ${accent}33`,
                                padding: "5px 9px", borderRadius: 6,
                                display: "flex", alignItems: "center", gap: 6,
                            }}>
                                <span>•</span>
                                <span>{reasonText(r)}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Breakdown */}
                <div style={{
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8, padding: "10px 12px",
                    marginBottom: 12,
                }}>
                    {props.steps.map((s, i) => (
                        <div key={i} style={{
                            display: "flex", justifyContent: "space-between",
                            fontSize: 11.5, color: "var(--color-text-2)",
                            padding: "2px 0",
                            ...(i === props.steps.length - 1 ? {
                                borderTop: "1px solid var(--color-border)",
                                paddingTop: 6, marginTop: 4,
                                color: "var(--color-text-1)", fontWeight: 600,
                            } : {}),
                        }}>
                            <span>{s.label}</span>
                            <span style={{ fontFamily: "monospace" }}>{s.value}</span>
                        </div>
                    ))}
                </div>

                {/* Balance after */}
                <div style={{
                    fontSize: 11.5, color: "var(--color-text-3)",
                    marginBottom: 14, textAlign: "right",
                }}>
                    {t("credits.afterRun", { n: Math.max(0, after) })}
                </div>

                {/* Don't ask again */}
                <label style={{
                    display: "flex", alignItems: "center", gap: 8,
                    fontSize: 11.5, color: "var(--color-text-2)",
                    marginBottom: 14, cursor: "pointer", userSelect: "none",
                }}>
                    <input
                        type="checkbox"
                        checked={skip}
                        onChange={e => setSkip(e.target.checked)}
                        style={{ cursor: "pointer" }}
                    />
                    <span>{t("credits.confirmDontAsk")}</span>
                </label>

                {/* Actions */}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button
                        onClick={props.onCancel}
                        style={{
                            padding: "7px 14px", borderRadius: 7,
                            background: "transparent",
                            border: "1px solid var(--color-border-strong)",
                            color: "var(--color-text-2)",
                            fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                        }}
                    >
                        {t("credits.confirmCancel")}
                    </button>
                    <button
                        onClick={handleConfirm}
                        style={{
                            padding: "7px 16px", borderRadius: 7,
                            background: accent, color: "#000",
                            border: "none",
                            fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                            display: "inline-flex", alignItems: "center", gap: 6,
                        }}
                    >
                        <Icon.Zap width={12} height={12} />
                        {t("credits.confirmProceed")}
                    </button>
                </div>
            </div>
        </div>
    );
}
