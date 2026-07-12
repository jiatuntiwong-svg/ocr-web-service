"use client";
// Correction Modal — Phase B + C combined flow.
//
// State machine:
//   input     — user fills form (issue type, correct value, explanation)
//      ↓ Save
//   generating — POST correction → POST .../generate (sync spinner)
//      ↓ AI candidate ready
//   review    — show candidate rule + conflicts + test preview
//      ↓ Approve  →  POST .../approve  →  saved
//      ↓ Skip     →  POST .../reject   →  closed (correction dropped per D10)
//   saved     — success state
//
// Phase C decisions applied:
//   Q1 sync  — generating phase blocks on AI ~2-3s in modal
//   D3       — every rule requires explicit user approve
//   Q4       — "Test on current doc" preview shown in review
//   Q2       — conflicts list rendered; user picks keep_both/replace
//   D10      — rejecting drops the correction

import React, { useState } from "react";
import { Icon } from "./Icons";
import { useTranslation } from "@/lib/i18n/LocaleContext";

interface Props {
    open: boolean;
    onClose: () => void;
    templateId: string;
    documentId?: string;
    fieldKey: string;
    fieldLabel: string;
    paneIdx?: number;
    currentValue?: string;
    availableFieldKeys?: string[];
    /** Current Compare result (passed by parent) — used to show a tiny
     *  "Test on current doc" preview before the user approves. */
    currentResultFields?: Array<{ key: string; doc1?: any; doc2?: any; doc3?: any; is_diff?: boolean }>;
}

type IssueType = "wrong_value" | "wrong_field" | "should_ignore";
type Phase = "input" | "generating" | "review" | "saved";

interface Candidate {
    type: string;
    spec: any;
    naturalLang: string;
    rationale?: string;
}
interface Conflict {
    ruleId: string;
    naturalLang: string | null;
    reason: string;
}

export default function CorrectionModal({
    open, onClose, templateId, documentId, fieldKey, fieldLabel,
    paneIdx, currentValue, availableFieldKeys = [], currentResultFields = [],
}: Props) {
    const { t } = useTranslation();
    const [phase, setPhase] = useState<Phase>("input");
    const [issue, setIssue] = useState<IssueType>("wrong_value");
    const [correctValue, setCorrectValue] = useState("");
    const [correctField, setCorrectField] = useState("");
    const [explanation, setExplanation] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [correctionId, setCorrectionId] = useState<string | null>(null);
    const [candidate, setCandidate] = useState<Candidate | null>(null);
    const [conflicts, setConflicts] = useState<Conflict[]>([]);
    const [conflictAction, setConflictAction] = useState<"keep_both" | "replace">("keep_both");
    const [editedNL, setEditedNL] = useState("");

    if (!open) return null;

    const reset = () => {
        setPhase("input"); setIssue("wrong_value"); setCorrectValue("");
        setCorrectField(""); setExplanation(""); setError(null);
        setCorrectionId(null); setCandidate(null); setConflicts([]);
        setConflictAction("keep_both"); setEditedNL("");
    };

    const closeAndReset = () => { reset(); onClose(); };

    // ── Phase 1 → 2 → 3: save correction + generate candidate ──
    const handleSaveAndGenerate = async () => {
        setError(null);
        setPhase("generating");
        try {
            // 1. Save correction
            const saveBody: any = {
                templateId, documentId, fieldKey, paneIdx,
                wrongValue: currentValue,
                issueType: issue,
                correctValue: issue === "wrong_value" ? correctValue
                    : issue === "wrong_field" ? correctField : null,
                explanation: explanation || undefined,
            };
            const saveRes = await fetch("/api/templates/corrections", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(saveBody),
            });
            if (!saveRes.ok) throw new Error(`save HTTP ${saveRes.status}`);
            const saveData: any = await saveRes.json();
            const cid = saveData.id as string;
            setCorrectionId(cid);

            // 2. Ask AI for candidate
            const genRes = await fetch(`/api/templates/corrections/${cid}/generate`, { method: "POST" });
            if (!genRes.ok) throw new Error(`gen HTTP ${genRes.status}`);
            const genData: any = await genRes.json();
            if (!genData.success || !genData.candidate) {
                setError(genData.reason || t("correction.aiNoRule"));
                setPhase("input");
                return;
            }
            setCandidate(genData.candidate);
            setEditedNL(genData.candidate.naturalLang || "");
            setConflicts(genData.conflicts || []);
            setPhase("review");
        } catch (e: any) {
            setError(e.message || "Generation failed");
            setPhase("input");
        }
    };

    // ── Phase 3 → 4: approve → save rule ──
    const handleApprove = async () => {
        if (!candidate || !correctionId) return;
        setError(null);
        try {
            const body: any = {
                type: candidate.type,
                spec: candidate.spec,
                naturalLang: editedNL || candidate.naturalLang,
                conflictAction,
            };
            if (conflictAction === "replace" && conflicts.length > 0) {
                body.replaceRuleId = conflicts[0].ruleId;
            }
            const res = await fetch(`/api/templates/corrections/${correctionId}/approve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`approve HTTP ${res.status}`);
            setPhase("saved");
        } catch (e: any) {
            setError(e.message || "Approval failed");
        }
    };

    // ── Phase 3 → close: reject correction ──
    const handleSkip = async () => {
        if (correctionId) {
            try { await fetch(`/api/templates/corrections/${correctionId}/reject`, { method: "POST" }); }
            catch { /* ignore — closing anyway */ }
        }
        closeAndReset();
    };

    const canSave = phase === "input" && (
        (issue === "wrong_value" && correctValue.trim().length > 0) ||
        (issue === "wrong_field" && correctField.trim().length > 0) ||
        (issue === "should_ignore")
    );

    return (
        <>
            {/* Click-through backdrop — dims the rest of the screen lightly
                but lets the user keep reading the compare result behind.
                z-index 100 so it sits above the fullscreen result view. */}
            <div
                onClick={onClose}
                style={{
                    position: "fixed", inset: 0, zIndex: 100,
                    background: "rgba(0,0,0,0.25)",
                    cursor: "pointer",
                }}
                title={t("common.close")}
            />
            {/* Right-side panel — keeps the compare result + previews visible
                on the left while the user fills in a correction. Slides in
                from the right edge; sized comfortably for the form. */}
            <div
                onClick={e => e.stopPropagation()}
                style={{
                    position: "fixed",
                    top: 16, right: 16, bottom: 16,
                    width: "min(440px, 92vw)",
                    zIndex: 101,
                    background: "var(--color-bg-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 12, padding: 20,
                    boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
                    overflowY: "auto",
                    animation: "slide-in-right 0.18s ease-out",
                }}
            >
                <Header fieldLabel={fieldLabel} onClose={onClose} t={t} phase={phase} />

                {phase === "input" && (
                    <>
                        <IssueRadios issue={issue} setIssue={setIssue} t={t} />
                        {issue === "wrong_value" && (
                            <Field label={t("correction.correctValue")}>
                                <input
                                    autoFocus
                                    value={correctValue}
                                    onChange={e => setCorrectValue(e.target.value)}
                                    placeholder={currentValue ? `instead of "${currentValue}"` : ""}
                                    style={inputStyle}
                                />
                            </Field>
                        )}
                        {issue === "wrong_field" && (
                            <Field label={t("correction.shouldBeField")}>
                                <input
                                    autoFocus
                                    value={correctField}
                                    onChange={e => setCorrectField(e.target.value)}
                                    placeholder="field key (e.g. weight_kgs)"
                                    list="cm-field-suggest"
                                    style={inputStyle}
                                />
                                <datalist id="cm-field-suggest">
                                    {availableFieldKeys.filter(k => k !== fieldKey).map(k => (
                                        <option key={k} value={k} />
                                    ))}
                                </datalist>
                            </Field>
                        )}
                        <Field label={t("correction.explanation") + " (" + t("common.optional") + ")"}>
                            <textarea
                                value={explanation}
                                onChange={e => setExplanation(e.target.value)}
                                rows={2}
                                placeholder={t("correction.explanationHint")}
                                style={{ ...inputStyle, resize: "vertical", minHeight: 50 }}
                            />
                        </Field>
                        {error && <Banner kind="error" text={error} />}
                        <Footer>
                            <button onClick={onClose} style={btnSecondary}>{t("common.cancel")}</button>
                            <button
                                onClick={handleSaveAndGenerate}
                                disabled={!canSave}
                                style={{ ...btnPrimary, opacity: canSave ? 1 : 0.5, cursor: canSave ? "pointer" : "not-allowed" }}
                            >
                                {t("correction.saveAndTeach")}
                            </button>
                        </Footer>
                    </>
                )}

                {phase === "generating" && (
                    <div style={{ padding: "28px 12px", textAlign: "center" }}>
                        <div style={{
                            width: 36, height: 36, border: "3px solid var(--color-bg-elevated)",
                            borderTopColor: "var(--color-info)", borderRadius: "50%",
                            margin: "0 auto 14px", animation: "spin 0.8s linear infinite",
                        }} />
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-1)" }}>
                            {t("correction.generating")}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 4 }}>
                            {t("correction.generatingHint")}
                        </div>
                    </div>
                )}

                {phase === "review" && candidate && (
                    <>
                        <div style={{
                            padding: 12, marginBottom: 12, borderRadius: 8,
                            background: "rgba(6,182,212,0.08)",
                            border: "1px solid rgba(6,182,212,0.3)",
                        }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                <span style={{
                                    fontSize: 9.5, fontWeight: 700, padding: "2px 6px",
                                    background: "rgba(139,92,246,0.18)", color: "#8b5cf6",
                                    borderRadius: 3, textTransform: "uppercase",
                                }}>{candidate.type}</span>
                                <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                                    {t("correction.candidateRule")}
                                </span>
                            </div>
                            <textarea
                                value={editedNL}
                                onChange={e => setEditedNL(e.target.value)}
                                rows={3}
                                style={{
                                    ...inputStyle, fontSize: 12.5, fontWeight: 500,
                                    background: "var(--color-bg-card)",
                                    color: "var(--color-text-1)",
                                }}
                            />
                            {candidate.rationale && (
                                <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 6, fontStyle: "italic" }}>
                                    {candidate.rationale}
                                </div>
                            )}
                        </div>

                        {/* Conflict list */}
                        {conflicts.length > 0 && (
                            <div style={{
                                padding: 10, marginBottom: 12, borderRadius: 8,
                                background: "rgba(245,158,11,0.08)",
                                border: "1px solid rgba(245,158,11,0.3)",
                            }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-warning)", marginBottom: 6 }}>
                                    ⚠ {t("correction.conflictTitle", { count: conflicts.length })}
                                </div>
                                {conflicts.map(c => (
                                    <div key={c.ruleId} style={{ fontSize: 11, color: "var(--color-text-2)", marginBottom: 4 }}>
                                        • {c.naturalLang || c.ruleId}
                                    </div>
                                ))}
                                <div style={{ marginTop: 8, display: "flex", gap: 4, flexWrap: "wrap" }}>
                                    {(["keep_both", "replace"] as const).map(act => (
                                        <button
                                            key={act}
                                            onClick={() => setConflictAction(act)}
                                            style={{
                                                fontSize: 10.5, padding: "3px 8px",
                                                background: conflictAction === act ? "var(--color-warning)" : "transparent",
                                                color: conflictAction === act ? "#000" : "var(--color-text-2)",
                                                border: `1px solid ${conflictAction === act ? "var(--color-warning)" : "var(--color-border)"}`,
                                                borderRadius: 4, cursor: "pointer",
                                            }}
                                        >
                                            {t(`correction.conflict_${act}`)}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Test on current doc preview */}
                        <TestPreview candidate={candidate} fields={currentResultFields} t={t} />

                        {error && <Banner kind="error" text={error} />}

                        <Footer>
                            <button onClick={handleSkip} style={btnSecondary}>{t("correction.skip")}</button>
                            <button onClick={handleApprove} style={btnPrimary}>
                                {t("correction.applyRule")}
                            </button>
                        </Footer>
                    </>
                )}

                {phase === "saved" && <SavedState onClose={closeAndReset} t={t} />}
            </div>
        </>
    );
}

function TestPreview({ candidate, fields, t }: { candidate: Candidate; fields: any[]; t: any }) {
    // Quick MVP preview: show which fields would be affected if rule is applied.
    // Real preview that re-runs extraction is deferred to Phase D.
    const targetField = candidate.spec?.assert?.field_target || candidate.spec?.match?.field_target;
    const affected = targetField
        ? fields.filter(f => f.key === targetField || (f.key && f.key.toLowerCase().includes(targetField.toLowerCase())))
        : [];
    return (
        <div style={{
            padding: 10, marginBottom: 12, borderRadius: 8,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border)",
        }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
                {t("correction.testPreview")}
            </div>
            {targetField ? (
                <>
                    <div style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                        {t("correction.previewWillAffect")}: <code style={{ color: "var(--color-info)" }}>{targetField}</code>
                    </div>
                    {affected.length > 0 ? (
                        <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 4 }}>
                            {t("correction.previewMatchesInDoc", { count: affected.length })}
                        </div>
                    ) : (
                        <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 4 }}>
                            {t("correction.previewNoMatchInDoc")}
                        </div>
                    )}
                </>
            ) : (
                <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                    {t("correction.previewNoTarget")}
                </div>
            )}
        </div>
    );
}

function Header({ fieldLabel, onClose, t, phase }: { fieldLabel: string; onClose: () => void; t: any; phase: Phase }) {
    const titles: Record<Phase, string> = {
        input: t("correction.title"),
        generating: t("correction.generatingTitle"),
        review: t("correction.reviewTitle"),
        saved: t("correction.savedTitle"),
    };
    return (
        <div style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            paddingBottom: 12, marginBottom: 12,
            borderBottom: "1px solid var(--color-border)",
        }}>
            <div style={{ flex: 1 }}>
                <h3 style={{ margin: "0 0 2px", fontSize: 14, fontWeight: 700, color: "var(--color-text-1)" }}>
                    {titles[phase]}
                </h3>
                {phase !== "saved" && (
                    <div style={{ fontSize: 12, color: "var(--color-text-3)" }}>
                        {t("correction.field")}: <code style={{ color: "var(--color-text-2)" }}>{fieldLabel}</code>
                    </div>
                )}
            </div>
            <button onClick={onClose} style={iconBtn} title={t("common.close")}>
                <Icon.X width={12} height={12} />
            </button>
        </div>
    );
}

function IssueRadios({ issue, setIssue, t }: { issue: IssueType; setIssue: (v: IssueType) => void; t: any }) {
    return (
        <Field label={t("correction.whatsWrong")}>
            {(["wrong_value", "wrong_field", "should_ignore"] as IssueType[]).map(opt => (
                <label
                    key={opt}
                    style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "8px 10px", marginBottom: 4,
                        background: issue === opt ? "rgba(6,182,212,0.10)" : "transparent",
                        border: `1px solid ${issue === opt ? "rgba(6,182,212,0.4)" : "var(--color-border)"}`,
                        borderRadius: 6, cursor: "pointer",
                        fontSize: 12, color: "var(--color-text-1)",
                    }}
                >
                    <input type="radio" checked={issue === opt} onChange={() => setIssue(opt)} style={{ accentColor: "var(--color-info)" }} />
                    <span style={{ flex: 1 }}>{t(`correction.issue_${opt}`)}</span>
                </label>
            ))}
        </Field>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 10 }}>
            <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
                textTransform: "uppercase", color: "var(--color-text-3)",
                marginBottom: 5,
            }}>{label}</div>
            {children}
        </div>
    );
}

function Footer({ children }: { children: React.ReactNode }) {
    return <div style={{ display: "flex", gap: 8, marginTop: 14 }}>{children}</div>;
}

function Banner({ kind, text }: { kind: "error" | "info"; text: string }) {
    return (
        <div style={{
            fontSize: 11.5,
            color: kind === "error" ? "var(--color-danger)" : "var(--color-text-1)",
            background: kind === "error" ? "rgba(239,68,68,0.08)" : "var(--color-bg-elevated)",
            padding: "6px 10px", borderRadius: 6, marginBottom: 10,
        }}>{text}</div>
    );
}

function SavedState({ onClose, t }: { onClose: () => void; t: any }) {
    return (
        <div style={{ textAlign: "center", padding: "12px 8px" }}>
            <div style={{
                width: 48, height: 48, borderRadius: "50%",
                background: "rgba(16,185,129,0.18)", color: "var(--color-success)",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                marginBottom: 10,
            }}>
                <Icon.Check width={22} height={22} />
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 700, color: "var(--color-text-1)" }}>
                {t("correction.ruleAppliedTitle")}
            </h3>
            <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-text-2)", lineHeight: 1.5 }}>
                {t("correction.ruleAppliedBody")}
            </p>
            <button onClick={onClose} style={btnPrimary}>{t("common.done")}</button>
        </div>
    );
}

const inputStyle: React.CSSProperties = {
    width: "100%", padding: "6px 9px",
    background: "var(--color-bg-elevated)", color: "var(--color-text-1)",
    border: "1px solid var(--color-border)", borderRadius: 5,
    fontSize: 12, fontFamily: "inherit",
};
const btnPrimary: React.CSSProperties = {
    flex: 1, padding: "8px 14px", fontSize: 12, fontWeight: 700,
    background: "var(--color-info)", color: "#fff",
    border: "none", borderRadius: 6, cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
    padding: "8px 14px", fontSize: 12, fontWeight: 600,
    background: "transparent", color: "var(--color-text-2)",
    border: "1px solid var(--color-border)", borderRadius: 6, cursor: "pointer",
};
const iconBtn: React.CSSProperties = {
    background: "transparent", border: "none", cursor: "pointer",
    color: "var(--color-text-3)", padding: 4, borderRadius: 4,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
};
