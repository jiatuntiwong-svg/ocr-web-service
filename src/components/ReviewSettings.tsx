"use client";
import React, { useEffect, useState } from "react";
import { useTranslation } from "@/lib/i18n/LocaleContext";

// Compact inline panel: confidence threshold slider + "block export below
// threshold" toggle. Reads/writes /api/user-prefs.
//
// Threshold storage is 0..1 (fraction). The slider works in whole percents
// (0..100) and converts at the boundary.

interface Props {
    userId: string;
    onChange?: (settings: { threshold: number; blockExport: boolean }) => void;
}

export default function ReviewSettings({ userId, onChange }: Props) {
    const { t } = useTranslation();
    const [threshold, setThreshold] = useState(70);  // percent
    const [blockExport, setBlockExport] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/user-prefs?userId=${encodeURIComponent(userId)}`);
                const data = await res.json() as { confidenceThreshold?: number; blockExportLowConfidence?: boolean };
                if (cancelled) return;
                if (typeof data.confidenceThreshold === "number") {
                    setThreshold(Math.round(data.confidenceThreshold * 100));
                }
                if (typeof data.blockExportLowConfidence === "boolean") {
                    setBlockExport(data.blockExportLowConfidence);
                }
            } catch {} finally {
                if (!cancelled) setLoaded(true);
            }
        })();
        return () => { cancelled = true; };
    }, [userId]);

    const persist = async (next: { threshold?: number; blockExport?: boolean }) => {
        setSaving(true);
        try {
            await fetch("/api/user-prefs", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userId,
                    ...(next.threshold !== undefined ? { confidenceThreshold: next.threshold / 100 } : {}),
                    ...(next.blockExport !== undefined ? { blockExportLowConfidence: next.blockExport } : {}),
                }),
            });
            onChange?.({
                threshold: (next.threshold ?? threshold) / 100,
                blockExport: next.blockExport ?? blockExport,
            });
        } catch {} finally {
            setSaving(false);
        }
    };

    return (
        <div style={{
            padding: 12,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            display: "flex", flexDirection: "column", gap: 10,
            fontSize: 12,
        }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <strong style={{ color: "var(--color-text-1)", fontSize: 12 }}>
                    {t("reviewSettings.title")}
                </strong>
                {saving && <span style={{ fontSize: 10, color: "var(--color-text-4)" }}>{t("common.saving") || "Saving…"}</span>}
            </div>

            <div>
                <div style={{ display: "flex", justifyContent: "space-between", color: "var(--color-text-3)", marginBottom: 4 }}>
                    <span>{t("reviewSettings.threshold")}</span>
                    <span style={{ fontWeight: 600, color: "var(--color-text-1)" }}>{threshold}%</span>
                </div>
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={threshold}
                    disabled={!loaded}
                    onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
                    onMouseUp={() => persist({ threshold })}
                    onTouchEnd={() => persist({ threshold })}
                    style={{ width: "100%" }}
                />
                <div style={{ fontSize: 10.5, color: "var(--color-text-4)", marginTop: 2 }}>
                    {t("reviewSettings.thresholdHint")}
                </div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                    type="checkbox"
                    disabled={!loaded}
                    checked={blockExport}
                    onChange={(e) => {
                        const next = e.target.checked;
                        setBlockExport(next);
                        persist({ blockExport: next });
                    }}
                />
                <span style={{ color: "var(--color-text-2)" }}>
                    {t("reviewSettings.blockExport")}
                </span>
            </label>
            <div style={{ fontSize: 10.5, color: "var(--color-text-4)", marginTop: -4, marginLeft: 22 }}>
                {t("reviewSettings.blockExportHint")}
            </div>
        </div>
    );
}
