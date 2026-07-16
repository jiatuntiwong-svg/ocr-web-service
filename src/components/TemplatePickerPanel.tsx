"use client";
// TemplatePickerPanel — shared UI-6 template picker.
//
// UI-7 UAT r1 (F2): extracted from OCRWorkspaceV2 into its own module so
// OCRBatchViewV2 can reuse the exact same widget (⭐ Favorites / 🕐 Recent /
// 📋 All + search + star toggle + inline delete + save-as-new / update-active).
// Batch mode owns a single shared template across every queued file (D2), so
// the picker's contract is identical — only the surrounding state lives in
// the caller (favorites/recent in localStorage, defaults via /api/user-prefs,
// save/update/delete via /api/templates).
import React, { useState } from "react";

export interface TemplatePickerPanelProps {
    templates: { id: string; name: string; fields_json: string; user_id?: string }[];
    activeTemplateId: string | null;
    activeTemplateName: string | null;
    favoriteIds: string[];
    recentIds: string[];
    defaultTemplateId: string | null;
    dirty: boolean;
    search: string;
    onSearch: (s: string) => void;
    onApply: (id: string | null) => void;
    onToggleFavorite: (id: string) => void;
    onSetDefault: (id: string | null) => void;
    onSaveAsNew: () => void;
    onUpdateActive: () => void;
    onDelete: (id: string) => void;
    savingTemplate: boolean;
    t: (k: string, vars?: any) => string;
}

export default function TemplatePickerPanel(p: TemplatePickerPanelProps) {
    const q = p.search.trim().toLowerCase();
    const matches = (n: string) => q === "" || n.toLowerCase().includes(q);
    const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
    const isSystemTemplate = (tpl: { id: string; user_id?: string }) =>
        tpl.user_id === "system" || tpl.id.startsWith("global-");

    const favTemplates = p.templates.filter(x => p.favoriteIds.includes(x.id) && matches(x.name));
    const recentTemplates = p.recentIds
        .map(id => p.templates.find(x => x.id === id))
        .filter((x): x is NonNullable<typeof x> => !!x && matches(x.name));
    const allTemplates = p.templates.filter(x => matches(x.name));

    const renderRow = (tpl: { id: string; name: string; user_id?: string }) => {
        const isActive = tpl.id === p.activeTemplateId;
        const isFav = p.favoriteIds.includes(tpl.id);
        const isDefault = tpl.id === p.defaultTemplateId;
        const isSystem = isSystemTemplate(tpl);
        const isConfirming = confirmingDeleteId === tpl.id;
        return (
            <div key={tpl.id}
                onClick={() => { if (!isConfirming) p.onApply(tpl.id); }}
                className="ocr-v2-tpl-row"
                style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "6px 8px", borderRadius: 8, cursor: "pointer",
                    background: isActive ? "var(--color-accent-dim)" : "transparent",
                    border: isActive ? "1px solid var(--color-accent-border)" : "1px solid transparent",
                    fontSize: 12.5,
                }}>
                <button
                    onClick={e => { e.stopPropagation(); p.onToggleFavorite(tpl.id); }}
                    title={isFav ? p.t("ocr.v2.templatePicker.unfavorite") : p.t("ocr.v2.templatePicker.favorite")}
                    style={{
                        background: "transparent", border: "none",
                        color: isFav ? "#f59e0b" : "var(--color-text-4)",
                        cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1,
                    }}>{isFav ? "★" : "☆"}</button>
                <span style={{ flex: 1, color: "var(--color-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {tpl.name}
                </span>
                {isDefault && (
                    <span style={{
                        fontSize: 9.5, padding: "1px 6px", borderRadius: 4,
                        background: "var(--color-accent)", color: "#0a1628", fontWeight: 700,
                    }}>{p.t("ocr.v2.templatePicker.default")}</span>
                )}
                {isActive && (
                    <span style={{ fontSize: 12, color: "var(--color-accent)" }}>✓</span>
                )}
                {isSystem ? (
                    <span
                        title={p.t("ocr.v2.templatePicker.delete.systemLocked")}
                        aria-label={p.t("ocr.v2.templatePicker.delete.systemLocked")}
                        style={{
                            fontSize: 12, color: "var(--color-text-4)",
                            opacity: 0.35, padding: "0 2px", lineHeight: 1,
                        }}>🔒</span>
                ) : isConfirming ? (
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
                        onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: 10.5, color: "var(--color-danger)", marginRight: 2 }}>
                            {p.t("ocr.v2.templatePicker.delete.confirm")}
                        </span>
                        <button
                            onClick={e => {
                                e.stopPropagation();
                                setConfirmingDeleteId(null);
                                p.onDelete(tpl.id);
                            }}
                            style={{
                                background: "var(--color-danger)", color: "#fff",
                                border: "none", borderRadius: 4,
                                padding: "1px 6px", fontSize: 10.5, fontWeight: 700,
                                cursor: "pointer", fontFamily: "inherit",
                            }}>{p.t("ocr.v2.templatePicker.delete.yes")}</button>
                        <button
                            onClick={e => { e.stopPropagation(); setConfirmingDeleteId(null); }}
                            style={{
                                background: "var(--color-bg-elevated)",
                                color: "var(--color-text-2)",
                                border: "1px solid var(--color-border)", borderRadius: 4,
                                padding: "1px 6px", fontSize: 10.5, fontWeight: 700,
                                cursor: "pointer", fontFamily: "inherit",
                            }}>{p.t("ocr.v2.templatePicker.delete.no")}</button>
                    </span>
                ) : (
                    <button
                        className="ocr-v2-tpl-delete"
                        onClick={e => {
                            e.stopPropagation();
                            setConfirmingDeleteId(tpl.id);
                        }}
                        title={p.t("ocr.v2.templatePicker.delete.button")}
                        aria-label={p.t("ocr.v2.templatePicker.delete.button")}
                        style={{
                            background: "transparent", border: "none",
                            color: "var(--color-text-4)",
                            cursor: "pointer", fontSize: 12, padding: "0 2px",
                            lineHeight: 1, opacity: 0.4,
                            transition: "opacity 0.15s ease, color 0.15s ease",
                        }}>🗑</button>
                )}
            </div>
        );
    };

    return (
        <div style={cardStyle}>
            <style>{`
                .ocr-v2-tpl-row:hover .ocr-v2-tpl-delete { opacity: 1; color: var(--color-danger); }
                .ocr-v2-tpl-delete:hover { opacity: 1 !important; color: var(--color-danger) !important; }
            `}</style>
            <h4 style={cardHeadStyle}>
                <span>{p.t("ocr.v2.templatePicker.head")}</span>
                {p.activeTemplateId && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {p.dirty && (
                            <span style={{
                                fontSize: 10, padding: "1px 6px", borderRadius: 4,
                                background: "rgba(245,158,11,0.15)",
                                color: "var(--color-warning)",
                                border: "1px solid rgba(245,158,11,0.35)", fontWeight: 700,
                            }}>● {p.t("ocr.v2.templatePicker.dirty")}</span>
                        )}
                        <button
                            onClick={() => p.onApply(null)}
                            style={{
                                background: "transparent", border: "none",
                                color: "var(--color-text-3)", fontSize: 11, cursor: "pointer",
                                fontFamily: "inherit",
                            }}>
                            {p.t("ocr.v2.templatePicker.clear")}
                        </button>
                    </span>
                )}
            </h4>
            <input value={p.search}
                onChange={e => p.onSearch(e.target.value)}
                placeholder={p.t("ocr.v2.templatePicker.searchPh")}
                style={{
                    width: "100%", padding: "6px 10px", borderRadius: 8,
                    background: "var(--color-bg-panel)", color: "var(--color-text-1)",
                    border: "1px solid var(--color-border)", fontSize: 12,
                    fontFamily: "inherit", marginBottom: 8,
                }} />
            <div style={{ maxHeight: 240, overflowY: "auto" }}>
                {favTemplates.length > 0 && (
                    <div>
                        <div style={pickerSectionHead}>⭐ {p.t("ocr.v2.templatePicker.favSection")}</div>
                        {favTemplates.map(renderRow)}
                    </div>
                )}
                {recentTemplates.length > 0 && (
                    <div>
                        <div style={pickerSectionHead}>🕐 {p.t("ocr.v2.templatePicker.recentSection")}</div>
                        {recentTemplates.map(renderRow)}
                    </div>
                )}
                <div>
                    <div style={pickerSectionHead}>📋 {p.t("ocr.v2.templatePicker.allSection")}</div>
                    {allTemplates.length === 0
                        ? <p style={{ margin: 0, padding: "6px 8px", fontSize: 11.5, color: "var(--color-text-3)" }}>
                            {p.t("ocr.v2.templatePicker.empty")}
                          </p>
                        : allTemplates.map(renderRow)}
                </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 10, borderTop: "1px solid var(--color-border)", paddingTop: 10 }}>
                <button style={{ ...miniBtnStyle, flex: 1, padding: "6px 10px" }}
                    disabled={p.savingTemplate}
                    onClick={p.onSaveAsNew}>
                    + {p.t("ocr.v2.templatePicker.saveAsNew")}
                </button>
                <button style={{
                        ...miniBtnStyle, flex: 1, padding: "6px 10px",
                        color: p.activeTemplateId ? "var(--color-accent)" : "var(--color-text-4)",
                        borderColor: p.activeTemplateId ? "var(--color-accent-border)" : "var(--color-border)",
                    }}
                    disabled={!p.activeTemplateId || p.savingTemplate}
                    title={!p.activeTemplateId ? p.t("ocr.v2.templatePicker.updateDisabledTip") : ""}
                    onClick={p.onUpdateActive}>
                    ↻ {p.activeTemplateName
                        ? p.t("ocr.v2.templatePicker.updateActive", { name: p.activeTemplateName })
                        : p.t("ocr.v2.templatePicker.updateDisabled")}
                </button>
            </div>
        </div>
    );
}

// Local styles (kept in sync with OCRWorkspaceV2 card/mini styles).
const cardStyle: React.CSSProperties = {
    background: "var(--color-bg-card)", border: "1px solid var(--color-border)",
    borderRadius: 12, padding: 14, marginBottom: 12,
};
const cardHeadStyle: React.CSSProperties = {
    fontSize: 13, margin: 0, marginBottom: 8, display: "flex",
    justifyContent: "space-between", alignItems: "center",
};
const miniBtnStyle: React.CSSProperties = {
    padding: "3px 10px", borderRadius: 6, fontSize: 11,
    background: "var(--color-bg-elevated)", color: "var(--color-text-2)",
    border: "1px solid var(--color-border)", cursor: "pointer",
    fontFamily: "inherit",
};
const pickerSectionHead: React.CSSProperties = {
    fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em",
    color: "var(--color-text-3)", fontWeight: 700,
    padding: "6px 8px 2px",
};
