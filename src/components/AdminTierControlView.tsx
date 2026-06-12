import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { apiError } from "@/lib/friendlyError";
import { ErrorCode } from "@/lib/errorCodes";

interface FeatureMeta { key: string; label: string }
interface TierConfigData {
    tiers: string[];
    features: FeatureMeta[];
    credits: Record<string, number>;
    flags: Record<string, Record<string, boolean>>;
}

const TIER_LABEL: Record<string, string> = {
    free: "Free", starter: "Starter", pro: "Pro", enterprise: "Enterprise",
};

export default function AdminTierControlView({ userId }: { userId: string }) {
    const { t } = useTranslation();
    const [data, setData] = useState<TierConfigData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [savedMsg, setSavedMsg] = useState<string | null>(null);

    // editable drafts
    const [flags, setFlags] = useState<Record<string, Record<string, boolean>>>({});
    const [credits, setCredits] = useState<Record<string, string>>({});

    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/admin/tier-config?userId=${userId}`);
            const json = await res.json() as any;
            if (!json.success) throw new Error(json.error || "Failed to load");
            const d: TierConfigData = {
                tiers: json.tiers || [], features: json.features || [],
                credits: json.credits || {}, flags: json.flags || {},
            };
            setData(d);
            // Build explicit boolean drafts — unset flag defaults to ON.
            const fDraft: Record<string, Record<string, boolean>> = {};
            const cDraft: Record<string, string> = {};
            for (const t of d.tiers) {
                fDraft[t] = {};
                for (const f of d.features) {
                    fDraft[t][f.key] = d.flags[t]?.[f.key] !== false;
                }
                cDraft[t] = String(d.credits[t] ?? 0);
            }
            setFlags(fDraft);
            setCredits(cDraft);
        } catch (err: any) {
            setError(apiError(err?.code || ErrorCode.GENERIC, err?.vars, t));
        } finally {
            setLoading(false);
        }
    }, [userId]);

    useEffect(() => { fetchData(); }, [fetchData]);

    const save = async () => {
        setSaving(true);
        setSavedMsg(null);
        setError(null);
        try {
            const creditsNum: Record<string, number> = {};
            for (const [t, v] of Object.entries(credits)) creditsNum[t] = Number(v) || 0;
            const res = await fetch(`/api/admin/tier-config?userId=${userId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ flags, credits: creditsNum }),
            });
            const json = await res.json() as any;
            if (!json.success) throw new Error(json.error || "Save failed");
            setSavedMsg(t("admin.tierSavedOk"));
            await fetchData();
        } catch (err: any) {
            setError(apiError(err?.code || ErrorCode.GENERIC, err?.vars, t));
        } finally {
            setSaving(false);
        }
    };

    const toggle = (tier: string, feature: string) =>
        setFlags(p => ({ ...p, [tier]: { ...p[tier], [feature]: !p[tier]?.[feature] } }));

    const tiers = data?.tiers || [];
    const features = data?.features || [];

    return (
        <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-6 md:p-8 space-y-8">
                {/* Header */}
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                            <div className="p-2.5 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
                                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
                            </div>
                            Tier Control
                        </h2>
                        <p className="text-sm text-slate-500 mt-2 font-medium">{t("admin.tierSubtitle")}</p>
                    </div>
                    <div className="flex items-center gap-3">
                        {savedMsg && <span className="text-xs font-bold text-emerald-600">{savedMsg}</span>}
                        <button
                            onClick={save}
                            disabled={saving || loading || tiers.length === 0}
                            className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition text-sm font-bold disabled:opacity-50"
                        >
                            {saving ? t("admin.saving") : t("admin.saveSettings")}
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="p-4 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl text-sm font-bold">{error}</div>
                )}

                {/* Feature toggle matrix */}
                <div>
                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-400 mb-3">{t("admin.tierFeaturesHeader")}</h3>
                    <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50/50 dark:bg-slate-900/50 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                                <tr>
                                    <th className="px-5 py-3">{t("admin.tierColFeature")}</th>
                                    {tiers.map(tier => (
                                        <th key={tier} className="px-5 py-3 text-center">{TIER_LABEL[tier] || tier}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {features.length === 0 && (
                                    <tr><td className="px-5 py-6 text-center text-slate-400" colSpan={tiers.length + 1}>{t("admin.loading")}</td></tr>
                                )}
                                {features.map(f => (
                                    <tr key={f.key}>
                                        <td className="px-5 py-3 font-bold text-slate-700 dark:text-slate-200">{f.label}</td>
                                        {tiers.map(tier => {
                                            const on = flags[tier]?.[f.key] !== false;
                                            return (
                                                <td key={tier} className="px-5 py-3 text-center">
                                                    <button
                                                        onClick={() => toggle(tier, f.key)}
                                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-700"}`}
                                                        title={on ? t("admin.tierOn") : t("admin.tierOff")}
                                                    >
                                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
                                                    </button>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2">{t("admin.tierNote")}</p>
                </div>

                {/* Per-tier starting credit */}
                <div>
                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-400 mb-3">{t("admin.tierCreditsHeader")}</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {tiers.map(tier => (
                            <div key={tier} className="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">{TIER_LABEL[tier] || tier}</p>
                                <input
                                    type="number" min="0" step="1"
                                    value={credits[tier] ?? ""}
                                    onChange={(e) => setCredits(p => ({ ...p, [tier]: e.target.value }))}
                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold"
                                />
                            </div>
                        ))}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2">{t("admin.tierCreditsNote")}</p>
                </div>
            </div>
        </div>
    );
}
