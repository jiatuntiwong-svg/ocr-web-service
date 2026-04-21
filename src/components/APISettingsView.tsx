"use client";
import React, { useState, useEffect } from "react";

interface AIConfig {
    id: string;
    provider: string;
    model: string;
    apiKey: string;
    label: string;
    isEnv?: boolean;
}

export default function APISettingsView() {
    const [configs, setConfigs] = useState<AIConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    const [editingId, setEditingId] = useState<string | null>(null);

    // New/Edit Config Form
    const [form, setForm] = useState({
        provider: "gemini",
        model: "gemini-2.5-flash",
        apiKey: "",
        label: ""
    });

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/settings");
            const data = await res.json() as { configs: AIConfig[] };
            setConfigs(data.configs || []);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSettings();
    }, []);

    const handleSubmit = async () => {
        if (!form.apiKey && !editingId) {
            alert("Please provide an API Key");
            return;
        }
        if (!form.model || !form.label) {
            alert("Please fill all fields");
            return;
        }
        setSubmitting(true);
        try {
            const action = editingId ? "update" : "add";
            const configData = editingId ? { ...form, id: editingId } : form;

            const res = await fetch("/api/admin/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action, config: configData }),
            });
            if (res.ok) {
                setForm({ provider: "gemini", model: "gemini-2.5-flash", apiKey: "", label: "" });
                setEditingId(null);
                await fetchSettings();
            } else {
                alert(`Failed to ${action} configuration`);
            }
        } catch (e) {
            alert("Error saving configuration");
        } finally {
            setSubmitting(false);
        }
    };

    const handleEditStart = (cfg: AIConfig) => {
        setEditingId(cfg.id);
        setForm({
            provider: cfg.provider,
            model: cfg.model,
            apiKey: cfg.apiKey, // Masked key
            label: cfg.label
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleCancelEdit = () => {
        setEditingId(null);
        setForm({ provider: "gemini", model: "gemini-2.5-flash", apiKey: "", label: "" });
    };

    const handleRemoveConfig = async (id: string) => {
        if (!confirm("Are you sure? ENV configs cannot be removed via UI")) return;
        setSubmitting(true);
        try {
            const res = await fetch("/api/admin/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "remove", config: { id } }),
            });
            if (res.ok) {
                await fetchSettings();
            }
        } catch (e) {
            alert("Error removing config");
        } finally {
            setSubmitting(false);
        }
    };

    const handleToggleActive = async (cfg: AIConfig) => {
        setSubmitting(true);
        try {
            const res = await fetch("/api/admin/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "toggle", config: { ...cfg, isActive: !cfg.isActive } }),
            });
            if (res.ok) {
                await fetchSettings();
            }
        } catch (e) {
            alert("Error updating config status");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="max-w-4xl space-y-8 animate-in fade-in slide-in-from-right-5 duration-700">
            <div className="bg-white dark:bg-slate-900 p-10 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 p-8">
                    <div className="flex items-center gap-2 bg-emerald-500/10 text-emerald-500 px-3 py-1.5 rounded-full">
                        <div className={`h-2 w-2 bg-emerald-500 rounded-full ${loading ? "animate-ping" : "animate-pulse"}`} />
                        <span className="text-[10px] font-black uppercase tracking-widest">
                            {loading ? "Refreshing..." : "System Active"}
                        </span>
                    </div>
                </div>
                <h3 className="text-2xl font-black mb-2 dark:text-white">
                    {editingId ? "Edit AI Configuration" : "Multi-Model AI Configuration"}
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-10 max-w-lg">
                    {editingId ? "Update existing settings. Leave the API key as is (masked) to keep current key." : "Add keys for different AI providers. The system will rotate keys per-model and allow users to select their preferred AI in the workspace."}
                </p>

                <div className="space-y-6">
                    {/* Add/Edit Form */}
                    <div className={`p-6 rounded-3xl border transition-all ${editingId ? 'bg-blue-50/50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800' : 'bg-slate-50 dark:bg-slate-950 border-slate-100 dark:border-slate-800'} space-y-4`}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-black uppercase text-slate-400">Provider</label>
                                <select
                                    className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 text-sm font-bold"
                                    value={form.provider}
                                    onChange={e => setForm({ ...form, provider: e.target.value })}
                                >
                                    <option value="gemini">Google Gemini</option>
                                    <option value="openai">OpenAI</option>
                                    <option value="openrouter">OpenRouter</option>
                                </select>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-black uppercase text-slate-400">Model Name</label>
                                <input
                                    type="text"
                                    placeholder="e.g. gemini-2.0-flash"
                                    className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 text-sm font-bold"
                                    value={form.model}
                                    onChange={e => setForm({ ...form, model: e.target.value })}
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-black uppercase text-slate-400">Label / Name</label>
                                <input
                                    type="text"
                                    placeholder="e.g. Finance Team Key"
                                    className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 text-sm font-bold"
                                    value={form.label}
                                    onChange={e => setForm({ ...form, label: e.target.value })}
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-black uppercase text-slate-400">API Key</label>
                                <input
                                    type="password"
                                    placeholder="Paste key here..."
                                    className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 text-sm font-bold"
                                    value={form.apiKey}
                                    onChange={e => setForm({ ...form, apiKey: e.target.value })}
                                />
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={handleSubmit}
                                disabled={submitting}
                                className="flex-1 bg-blue-600 text-white py-3 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-blue-500 disabled:opacity-50 transition-all shadow-lg shadow-blue-500/10"
                            >
                                {submitting ? "Processing..." : editingId ? "Update Configuration" : "Add AI Configuration"}
                            </button>
                            {editingId && (
                                <button
                                    onClick={handleCancelEdit}
                                    className="px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest border border-slate-200 dark:border-slate-800 text-slate-500 hover:bg-slate-100 transition-all"
                                >
                                    Cancel
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="pt-6 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {configs.map((cfg) => (
                            <div
                                key={cfg.id}
                                className={`p-6 rounded-2xl border flex flex-col justify-between min-h-[160px] group transition-all opacity-100 ${cfg.isActive === false ? 'bg-slate-100 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800/50 grayscale-[0.8]' : 'bg-slate-50 dark:bg-slate-950 border-slate-100 dark:border-slate-800'}`}
                            >
                                <div>
                                    <div className="flex justify-between items-start mb-2">
                                        <div className="flex flex-col">
                                            <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-md w-fit mb-1 ${cfg.provider === 'gemini' ? 'bg-blue-100 text-blue-600' :
                                                cfg.provider === 'openai' ? 'bg-emerald-100 text-emerald-600' : 'bg-violet-100 text-violet-600'
                                                }`}>
                                                {cfg.provider}
                                            </span>
                                            <p className="text-sm font-bold dark:text-white">{cfg.label}</p>
                                        </div>
                                        {cfg.isEnv && (
                                            <span className="text-[9px] bg-slate-200 dark:bg-slate-800 text-slate-500 px-2 py-0.5 rounded font-black uppercase">ENV</span>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-slate-400 font-mono mb-2">{cfg.model}</p>
                                    <p className="text-xs font-mono text-slate-500">{cfg.apiKey}</p>
                                </div>
                                <div className="flex items-center justify-between mt-4">
                                    <div className="flex items-center gap-3">
                                        {/* Toggle Active Button */}
                                        <button 
                                            onClick={() => handleToggleActive(cfg)}
                                            disabled={submitting}
                                            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${cfg.isActive !== false ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                                            title={cfg.isActive !== false ? "Click to Disable" : "Click to Enable"}
                                        >
                                            <span
                                                aria-hidden="true"
                                                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${cfg.isActive !== false ? 'translate-x-2' : '-translate-x-2'}`}
                                            />
                                        </button>

                                        <button
                                            onClick={() => handleEditStart(cfg)}
                                            className="text-[10px] text-blue-600 font-bold hover:underline"
                                        >
                                            Edit
                                        </button>
                                    </div>
                                    {!cfg.isEnv && (
                                        <button
                                            onClick={() => handleRemoveConfig(cfg.id)}
                                            disabled={submitting}
                                            className="text-[10px] text-rose-500 font-bold hover:underline"
                                        >
                                            Remove
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                        {configs.length === 0 && !loading && (
                            <div className="col-span-2 py-10 text-center border-2 border-dashed border-slate-100 dark:border-slate-800 rounded-2xl">
                                <p className="text-sm text-slate-400 font-bold">No AI configurations found.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
