"use client";
// Template Rulebase — Phase A read-only viewer.
//
// Mounted by the template editor (and future template-detail modals) when
// ENABLE_TEMPLATE_RULEBASE is on. Phase A scope:
//   - List rules grouped by type
//   - Toggle enabled / soft-delete per rule
//   - Reset-all (with confirm)
// Phase B-F will add: corrections inbox, candidate-rule generation modal,
// rule injection visibility, advisor warnings, etc.
//
// All API calls are no-ops when the flag is off (server returns 404), so this
// component is safe to mount; it just shows an empty state.

import React, { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icons";
import { ENABLE_TEMPLATE_RULEBASE } from "@/lib/featureFlags";

type RuleType = "extraction" | "alignment" | "comparison" | "validation";

interface RuleRow {
    id: string;
    template_id: string;
    user_id: string;
    type: RuleType;
    spec_json: string;
    spec: any;
    natural_lang: string | null;
    source: "user" | "ai_generated" | "system";
    confidence: number;
    hit_count: number;
    miss_count: number;
    enabled: boolean;
    created_at: string;
    last_used_at: string | null;
}

const TYPE_META: Record<RuleType, { label: string; icon: string; color: string }> = {
    extraction:  { label: "Extraction", icon: "🟢", color: "var(--color-info)" },
    alignment:   { label: "Alignment",  icon: "🟡", color: "var(--color-warning)" },
    comparison:  { label: "Comparison", icon: "🔵", color: "var(--color-info)" },
    validation:  { label: "Validation", icon: "🟣", color: "#8b5cf6" },
};

interface Suggestion {
    id: string;
    kind: string;
    target_rule_ids: string[];
    action: any;
    natural_lang: string | null;
    status: string;
    created_at: string;
}

export default function TemplateRulesPanel({ templateId, onClose }: { templateId: string; onClose?: () => void }) {
    const [rules, setRules] = useState<RuleRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [confirmReset, setConfirmReset] = useState(false);
    const [resetText, setResetText] = useState("");
    const [deleteCorrections, setDeleteCorrections] = useState(false);
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [curating, setCurating] = useState(false);
    const [curateMessage, setCurateMessage] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const res = await fetch(`/api/templates/rules?templateId=${encodeURIComponent(templateId)}`);
            if (res.status === 404) {
                // Feature flag is off — show empty state, not an error.
                setRules([]);
            } else if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            } else {
                const data = (await res.json()) as RuleRow[];
                setRules(data);
            }
        } catch (e: any) {
            setError(e.message || "Failed to load rules");
        } finally {
            setLoading(false);
        }
    }, [templateId]);

    const refreshSuggestions = useCallback(async () => {
        try {
            const res = await fetch(`/api/templates/rules/curate?templateId=${encodeURIComponent(templateId)}&status=pending`);
            if (!res.ok) { setSuggestions([]); return; }
            const data = (await res.json()) as Suggestion[];
            setSuggestions(data);
        } catch { setSuggestions([]); }
    }, [templateId]);

    useEffect(() => { refresh(); refreshSuggestions(); }, [refresh, refreshSuggestions]);

    const runCuration = async (force = false) => {
        setCurating(true); setCurateMessage(null);
        try {
            const res = await fetch(`/api/templates/rules/curate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateId, force }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data: any = await res.json();
            if (data.skipped) {
                setCurateMessage(
                    data.reason === "recent_pending"
                        ? `Already have ${data.pendingCount} pending suggestion(s). Review them first or use Force.`
                        : data.reason === "no_rules"
                            ? "No rules to curate yet."
                            : "Curation skipped.",
                );
            } else {
                setCurateMessage(`AI found ${data.generated} suggestion(s).`);
                await refreshSuggestions();
            }
        } catch (e: any) {
            setCurateMessage(`Curation failed: ${e.message || "unknown"}`);
        } finally {
            setCurating(false);
        }
    };

    const handleApplySuggestion = async (sug: Suggestion) => {
        try {
            const res = await fetch(`/api/templates/rules/curate/${sug.id}/apply`, { method: "POST" });
            if (!res.ok) throw new Error("apply failed");
            await Promise.all([refresh(), refreshSuggestions()]);
        } catch (e: any) {
            setError(e.message || "Apply failed");
        }
    };
    const handleDismissSuggestion = async (sug: Suggestion) => {
        try {
            const res = await fetch(`/api/templates/rules/curate/${sug.id}/dismiss`, { method: "POST" });
            if (!res.ok) throw new Error("dismiss failed");
            await refreshSuggestions();
        } catch (e: any) {
            setError(e.message || "Dismiss failed");
        }
    };

    const toggleEnabled = async (rule: RuleRow) => {
        const next = !rule.enabled;
        // Optimistic update
        setRules(rs => rs.map(r => r.id === rule.id ? { ...r, enabled: next } : r));
        try {
            const res = await fetch(`/api/templates/rules/${rule.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled: next }),
            });
            if (!res.ok) throw new Error("patch failed");
        } catch {
            // Revert
            setRules(rs => rs.map(r => r.id === rule.id ? { ...r, enabled: !next } : r));
        }
    };

    const deleteRule = async (rule: RuleRow) => {
        if (!confirm(`Delete rule "${rule.natural_lang || rule.type}"? (soft delete — can restore later)`)) return;
        setRules(rs => rs.filter(r => r.id !== rule.id));
        try {
            const res = await fetch(`/api/templates/rules/${rule.id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("delete failed");
        } catch {
            refresh();
        }
    };

    const resetAll = async () => {
        try {
            const res = await fetch(`/api/templates/rules/reset`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateId, deleteCorrections }),
            });
            if (!res.ok) throw new Error("reset failed");
            setConfirmReset(false); setResetText(""); setDeleteCorrections(false);
            await refresh();
        } catch (e: any) {
            setError(e.message || "Reset failed");
        }
    };

    const grouped = (() => {
        const m = new Map<RuleType, RuleRow[]>();
        for (const r of rules) {
            if (!m.has(r.type)) m.set(r.type, []);
            m.get(r.type)!.push(r);
        }
        return m;
    })();

    const total = rules.length;
    const enabledCount = rules.filter(r => r.enabled).length;

    return (
        <div style={{
            display: "flex", flexDirection: "column",
            background: "var(--color-bg-card)",
            border: "1px solid var(--color-border)",
            borderRadius: 12, padding: 16,
            maxHeight: "80vh", overflow: "hidden",
        }}>
            {/* Header */}
            <div style={{
                display: "flex", alignItems: "center", gap: 10,
                paddingBottom: 12, marginBottom: 12,
                borderBottom: "1px solid var(--color-border)",
            }}>
                <Icon.FileText width={16} height={16} color="var(--color-info)" />
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--color-text-1)" }}>
                    Template Rules
                </h3>
                <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                    {enabledCount} active / {total} total
                </span>
                <div style={{ flex: 1 }} />
                {!ENABLE_TEMPLATE_RULEBASE && (
                    <span style={{
                        fontSize: 9.5, fontWeight: 700, padding: "3px 7px", borderRadius: 4,
                        background: "rgba(245,158,11,0.18)", color: "var(--color-warning)",
                        letterSpacing: 0.5, textTransform: "uppercase",
                    }}>
                        Preview · flag off
                    </span>
                )}
                {onClose && (
                    <button onClick={onClose} style={iconBtn} title="Close">
                        <Icon.X width={12} height={12} />
                    </button>
                )}
            </div>

            {/* Curation toolbar */}
            <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 0", marginBottom: 8,
                borderBottom: "1px solid var(--color-border)",
            }}>
                <button
                    onClick={() => runCuration(false)}
                    disabled={curating || rules.length === 0}
                    style={{
                        fontSize: 11, fontWeight: 700, padding: "5px 10px",
                        background: rules.length === 0 ? "var(--color-bg-elevated)" : "var(--color-info)",
                        color: rules.length === 0 ? "var(--color-text-3)" : "#fff",
                        border: "none", borderRadius: 5,
                        cursor: rules.length === 0 || curating ? "not-allowed" : "pointer",
                        display: "inline-flex", alignItems: "center", gap: 5,
                    }}
                >
                    🪄 {curating ? "Curating…" : "Curate now"}
                </button>
                {suggestions.length > 0 && (
                    <span style={{
                        fontSize: 10, fontWeight: 700, padding: "3px 7px",
                        background: "rgba(139,92,246,0.15)", color: "#8b5cf6",
                        borderRadius: 10,
                    }}>{suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"} pending</span>
                )}
                {curateMessage && (
                    <span style={{ fontSize: 11, color: "var(--color-text-3)", flex: 1 }}>{curateMessage}</span>
                )}
            </div>

            {/* Suggestions list */}
            {suggestions.length > 0 && (
                <div style={{
                    marginBottom: 12, padding: 10,
                    background: "rgba(139,92,246,0.06)",
                    border: "1px solid rgba(139,92,246,0.25)",
                    borderRadius: 8,
                }}>
                    <div style={{
                        fontSize: 10, fontWeight: 700, color: "#8b5cf6",
                        letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 6,
                    }}>
                        💡 AI suggestions
                    </div>
                    {suggestions.map(s => (
                        <SuggestionCard key={s.id} sug={s} onApply={handleApplySuggestion} onDismiss={handleDismissSuggestion} />
                    ))}
                </div>
            )}

            {/* Body */}
            <div className="custom-scrollbar" style={{ flex: 1, overflowY: "auto" }}>
                {loading ? (
                    <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-3)", fontSize: 12 }}>
                        Loading rules…
                    </div>
                ) : error ? (
                    <div style={{ padding: 12, color: "var(--color-danger)", fontSize: 12 }}>{error}</div>
                ) : total === 0 ? (
                    <EmptyState />
                ) : (
                    Array.from(grouped.entries()).map(([type, list]) => (
                        <div key={type} style={{ marginBottom: 16 }}>
                            <div style={{
                                fontSize: 10, fontWeight: 700, letterSpacing: 1.2,
                                textTransform: "uppercase", color: "var(--color-text-3)",
                                marginBottom: 6, display: "flex", alignItems: "center", gap: 6,
                            }}>
                                <span>{TYPE_META[type].icon}</span>
                                <span>{TYPE_META[type].label}</span>
                                <span style={{ opacity: 0.6 }}>({list.length})</span>
                            </div>
                            {list.map(rule => <RuleCard key={rule.id} rule={rule} onToggle={toggleEnabled} onDelete={deleteRule} />)}
                        </div>
                    ))
                )}
            </div>

            {/* Danger zone */}
            {total > 0 && (
                <div style={{
                    paddingTop: 12, marginTop: 12,
                    borderTop: "1px solid var(--color-border)",
                }}>
                    {!confirmReset ? (
                        <button
                            onClick={() => setConfirmReset(true)}
                            style={{
                                fontSize: 11, fontWeight: 600, padding: "6px 12px",
                                background: "transparent", color: "var(--color-danger)",
                                border: "1px solid var(--color-danger)", borderRadius: 6,
                                cursor: "pointer",
                            }}
                        >
                            Reset all rules
                        </button>
                    ) : (
                        <div style={{
                            padding: 12, background: "rgba(239,68,68,0.08)",
                            border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8,
                        }}>
                            <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--color-text-1)", fontWeight: 600 }}>
                                ⚠ Reset all rules for this template?
                            </p>
                            <ul style={{ margin: "0 0 8px 16px", padding: 0, fontSize: 11, color: "var(--color-text-2)" }}>
                                <li>Keeps all fields</li>
                                <li>Soft-deletes {total} learned rules (restorable for 30 days)</li>
                            </ul>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 8 }}>
                                <input type="checkbox" checked={deleteCorrections} onChange={e => setDeleteCorrections(e.target.checked)} />
                                Also delete correction history
                            </label>
                            <div style={{ fontSize: 11, marginBottom: 6 }}>Type <code>RESET</code> to confirm:</div>
                            <input
                                value={resetText}
                                onChange={e => setResetText(e.target.value)}
                                style={{
                                    width: "100%", padding: "5px 8px", fontSize: 12,
                                    background: "var(--color-bg-elevated)", color: "var(--color-text-1)",
                                    border: "1px solid var(--color-border)", borderRadius: 4,
                                }}
                            />
                            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                                <button
                                    onClick={resetAll}
                                    disabled={resetText !== "RESET"}
                                    style={{
                                        flex: 1, padding: "6px 12px", fontSize: 11, fontWeight: 700,
                                        background: resetText === "RESET" ? "var(--color-danger)" : "var(--color-bg-elevated)",
                                        color: resetText === "RESET" ? "#fff" : "var(--color-text-3)",
                                        border: "none", borderRadius: 4,
                                        cursor: resetText === "RESET" ? "pointer" : "not-allowed",
                                    }}
                                >
                                    Reset rules
                                </button>
                                <button
                                    onClick={() => { setConfirmReset(false); setResetText(""); setDeleteCorrections(false); }}
                                    style={{
                                        padding: "6px 12px", fontSize: 11,
                                        background: "transparent", color: "var(--color-text-2)",
                                        border: "1px solid var(--color-border)", borderRadius: 4,
                                        cursor: "pointer",
                                    }}
                                >Cancel</button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function RuleCard({ rule, onToggle, onDelete }: { rule: RuleRow; onToggle: (r: RuleRow) => void; onDelete: (r: RuleRow) => void }) {
    const accuracyPct = rule.hit_count + rule.miss_count > 0
        ? Math.round((rule.hit_count / (rule.hit_count + rule.miss_count)) * 100)
        : null;
    return (
        <div style={{
            padding: 10, marginBottom: 6, borderRadius: 6,
            background: rule.enabled ? "var(--color-bg-elevated)" : "transparent",
            border: `1px solid ${rule.enabled ? "var(--color-border)" : "var(--color-border)"}`,
            opacity: rule.enabled ? 1 : 0.55,
            display: "flex", flexDirection: "column", gap: 4,
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-1)", flex: 1 }}>
                    {rule.natural_lang || JSON.stringify(rule.spec).slice(0, 80)}
                </span>
                <span style={{
                    fontSize: 9, padding: "2px 5px", borderRadius: 3,
                    background: rule.source === "ai_generated" ? "rgba(139,92,246,0.18)" : "rgba(59,130,246,0.18)",
                    color: rule.source === "ai_generated" ? "#8b5cf6" : "var(--color-info)",
                    fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                }}>{rule.source === "ai_generated" ? "AI" : rule.source.toUpperCase()}</span>
                <button
                    onClick={() => onToggle(rule)}
                    style={{ ...iconBtn, opacity: rule.enabled ? 1 : 0.45 }}
                    title={rule.enabled ? "Disable" : "Enable"}
                >
                    <Icon.Eye width={11} height={11} />
                </button>
                <button onClick={() => onDelete(rule)} style={{ ...iconBtn, color: "var(--color-danger)" }} title="Delete">
                    <Icon.X width={11} height={11} />
                </button>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--color-text-3)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span>used {rule.hit_count} times</span>
                {accuracyPct !== null && <span>· {accuracyPct}% accurate</span>}
                <span>· confidence {Math.round(rule.confidence * 100)}%</span>
                {rule.last_used_at && <span>· last fired {new Date(rule.last_used_at).toLocaleDateString()}</span>}
            </div>
        </div>
    );
}

function SuggestionCard({ sug, onApply, onDismiss }: { sug: Suggestion; onApply: (s: Suggestion) => void; onDismiss: (s: Suggestion) => void }) {
    const kindColor: Record<string, string> = {
        duplicate: "var(--color-warning)",
        conflict: "var(--color-danger)",
        merge: "var(--color-info)",
        overgeneralization: "var(--color-warning)",
        retire: "var(--color-text-3)",
    };
    const color = kindColor[sug.kind] || "var(--color-text-2)";
    const opLabel = sug.action?.op
        ? sug.action.op.charAt(0).toUpperCase() + sug.action.op.slice(1)
        : "Apply";
    return (
        <div style={{
            padding: 8, marginBottom: 6, borderRadius: 6,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border)",
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{
                    fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                    background: color, color: "#fff", textTransform: "uppercase",
                }}>{sug.kind}</span>
                <span style={{ fontSize: 10, color: "var(--color-text-3)" }}>
                    affects {sug.target_rule_ids.length} rule{sug.target_rule_ids.length === 1 ? "" : "s"}
                </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-1)", marginBottom: 6 }}>
                {sug.natural_lang || "(no description)"}
            </div>
            <div style={{ display: "flex", gap: 5 }}>
                <button onClick={() => onApply(sug)} style={{
                    fontSize: 10.5, padding: "3px 9px", fontWeight: 600,
                    background: "var(--color-info)", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer",
                }}>{opLabel}</button>
                <button onClick={() => onDismiss(sug)} style={{
                    fontSize: 10.5, padding: "3px 9px", fontWeight: 600,
                    background: "transparent", color: "var(--color-text-2)",
                    border: "1px solid var(--color-border)", borderRadius: 4, cursor: "pointer",
                }}>Dismiss</button>
            </div>
        </div>
    );
}

function EmptyState() {
    return (
        <div style={{ padding: "32px 16px", textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>📋</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-1)", marginBottom: 4 }}>
                No rules yet
            </div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-3)", maxWidth: 280, margin: "0 auto" }}>
                AI will learn from your corrections — try comparing a few documents first, then mark any incorrect results.
            </div>
        </div>
    );
}

const iconBtn: React.CSSProperties = {
    background: "transparent", border: "none", cursor: "pointer",
    color: "var(--color-text-3)", padding: 2, borderRadius: 3,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
};
