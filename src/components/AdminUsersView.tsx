"use client";
import React, { useState, useEffect, useCallback } from "react";

interface AdminUser {
    id: string;
    name: string;
    email: string;
    role: string;
    plan: string;
    totalDocs: number;
    customLimit: number | null;
    effectiveLimit: number;
    creditsRemaining: number;
}

type EditMode = "credit" | "plan" | "role" | "settings" | null;

const PLANS = ["Free", "Starter", "Pro", "Enterprise", "System"];
const ROLES = ["user", "admin"];

const PLAN_COLORS: Record<string, string> = {
    Free: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    Starter: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    Pro: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    Enterprise: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
    System: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
};

const ROLE_BADGE: Record<string, string> = {
    admin: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    user: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

// ── Toast component ──────────────────────────────────────────────────────────
function Toast({ msg, type }: { msg: string; type: "success" | "error" | "info" }) {
    const bg = type === "success" ? "bg-emerald-600" : type === "error" ? "bg-rose-600" : "bg-blue-600";
    const icon = type === "success"
        ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        : type === "error"
            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
            : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />;
    return (
        <div className={`fixed top-6 right-6 z-[9999] px-5 py-3 rounded-2xl shadow-2xl text-sm font-bold flex items-center gap-2 animate-in slide-in-from-top-3 duration-300 ${bg} text-white`}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">{icon}</svg>
            {msg}
        </div>
    );
}

// ── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string | number; sub?: string; color: string }) {
    return (
        <div className={`bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-200 dark:border-slate-800 p-6 shadow-sm flex items-start gap-4 hover:shadow-md transition-shadow`}>
            <div className={`p-3 rounded-xl ${color}`}>{icon}</div>
            <div>
                <p className="text-2xl font-black dark:text-white">{value}</p>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-0.5">{label}</p>
                {sub && <p className="text-[11px] text-slate-400 mt-1">{sub}</p>}
            </div>
        </div>
    );
}

export default function AdminUsersView() {
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [filterRole, setFilterRole] = useState<string>("all");
    const [filterPlan, setFilterPlan] = useState<string>("all");
    const [saving, setSaving] = useState(false);
    const [toast, setToast] = useState<{ msg: string; type: "success" | "error" | "info" } | null>(null);

    // Edit state
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editMode, setEditMode] = useState<EditMode>(null);
    const [editValue, setEditValue] = useState("");

    const showToast = useCallback((msg: string, type: "success" | "error" | "info" = "success") => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3200);
    }, []);

    const fetchUsers = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/users");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as AdminUser[];
            setUsers(data);
        } catch (e: any) {
            showToast(`โหลดข้อมูลไม่สำเร็จ: ${e.message}`, "error");
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);

    // ── Edit helpers ──────────────────────────────────────────────────────────
    const startEdit = (user: AdminUser, mode: EditMode) => {
        setEditingId(user.id);
        setEditMode(mode);
        if (mode === "credit") setEditValue(user.customLimit !== null ? String(user.customLimit) : String(user.effectiveLimit));
        if (mode === "plan") setEditValue(user.plan);
        if (mode === "role") setEditValue(user.role);
        if (mode === "settings") setEditValue(""); // Used for password
    };

    const cancelEdit = () => { setEditingId(null); setEditMode(null); setEditValue(""); };

    const patchUser = async (body: object) => {
        const res = await fetch("/api/admin/users", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json() as { success?: boolean; error?: string; dev?: boolean };
        if (!res.ok || !data.success) throw new Error(data.error || "ไม่สามารถบันทึกได้");
        if (data.dev) showToast("บันทึกสำเร็จ (Dev mode — ไม่ถาวร)", "info");
        else showToast("บันทึกสำเร็จ ✓");
    };

    const saveCredit = async (userId: string) => {
        const val = editValue.trim();
        const parsed = val === "" ? null : parseInt(val, 10);
        if (parsed !== null && (isNaN(parsed) || parsed < 0)) { showToast("กรุณากรอกตัวเลขที่ถูกต้อง", "error"); return; }
        setSaving(true);
        try {
            await patchUser({ userId, customLimit: parsed });
            cancelEdit();
            await fetchUsers();
        } catch (e: any) { showToast(e.message, "error"); }
        finally { setSaving(false); }
    };

    const savePlan = async (userId: string) => {
        setSaving(true);
        try {
            await patchUser({ userId, plan: editValue });
            cancelEdit();
            await fetchUsers();
        } catch (e: any) { showToast(e.message, "error"); }
        finally { setSaving(false); }
    };

    const saveRole = async (userId: string) => {
        setSaving(true);
        try {
            await patchUser({ userId, role: editValue });
            cancelEdit();
            await fetchUsers();
        } catch (e: any) { showToast(e.message, "error"); }
        finally { setSaving(false); }
    };

    const resetCredit = async (userId: string) => {
        if (!confirm("รีเซ็ต credit limit กลับเป็นค่าเริ่มต้นของ plan?")) return;
        setSaving(true);
        try { await patchUser({ userId, customLimit: null }); await fetchUsers(); }
        catch (e: any) { showToast(e.message, "error"); }
        finally { setSaving(false); }
    };

    const saveSettings = async (userId: string, data: { password?: string, creditsRemaining?: number }) => {
        setSaving(true);
        try {
            await patchUser({
                userId,
                password: data.password || undefined,
                credits_remaining: data.creditsRemaining
            });
            cancelEdit();
            await fetchUsers();
        } catch (e: any) { showToast(e.message, "error"); }
        finally { setSaving(false); }
    };

    // ── Stats derived ─────────────────────────────────────────────────────────
    const totalUsers = users.length;
    const adminCount = users.filter(u => u.role === "admin").length;
    const totalDocs = users.reduce((s, u) => s + u.totalDocs, 0);
    // Alert if credits are 0 OR less than 10% of limit OR less than 20 credits (urgent)
    const lowCredit = users.filter(u => {
        if (isUnlimited(u)) return false;
        const isActuallyLow = u.creditsRemaining <= (u.effectiveLimit * 0.1) || u.creditsRemaining < 20;
        return isActuallyLow;
    }).length;

    // ── Filter / search ───────────────────────────────────────────────────────
    const filtered = users.filter(u => {
        const q = search.toLowerCase();
        const matchQ = !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.plan.toLowerCase().includes(q);
        const matchRole = filterRole === "all" || u.role === filterRole;
        const matchPlan = filterPlan === "all" || u.plan === filterPlan;
        return matchQ && matchRole && matchPlan;
    });

    function isUnlimited(u: AdminUser) { return u.effectiveLimit >= 999999; }
    function usedPct(u: AdminUser) { return isUnlimited(u) ? 0 : Math.min(100, Math.round((u.totalDocs / u.effectiveLimit) * 100)); }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            {toast && <Toast msg={toast.msg} type={toast.type} />}

            {/* ── KPI Overview ── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                    icon={<svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
                    label="Total Users" value={totalUsers} sub={`${adminCount} admin · ${totalUsers - adminCount} users`}
                    color="bg-blue-50 dark:bg-blue-900/20"
                />
                <StatCard
                    icon={<svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>}
                    label="Docs Processed" value={totalDocs.toLocaleString()} sub="รวมทุก user"
                    color="bg-emerald-50 dark:bg-emerald-900/20"
                />
                <StatCard
                    icon={<svg className="w-5 h-5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}
                    label="Plan Distribution"
                    value={[...new Set(users.map(u => u.plan))].length + " plans"}
                    sub={PLANS.filter(p => users.some(u => u.plan === p)).join(", ")}
                    color="bg-violet-50 dark:bg-violet-900/20"
                />
                <StatCard
                    icon={<svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>}
                    label="Low Credit Alert" value={lowCredit} sub="users มี credit ต่ำกว่า 20%"
                    color="bg-amber-50 dark:bg-amber-900/20"
                />
            </div>

            {/* ── User Table ── */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">

                {/* Table Header */}
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between px-8 py-5 border-b border-slate-100 dark:border-slate-800 gap-4">
                    <div>
                        <h3 className="font-black text-lg dark:text-white flex items-center gap-2">
                            <span className="h-7 w-7 bg-amber-500 rounded-lg flex items-center justify-center">
                                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                            </span>
                            User Management
                        </h3>
                        <p className="text-xs text-slate-400 mt-0.5">แก้ไข Plan · Role · Credit Limit ของทุก user</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {/* Search */}
                        <div className="relative">
                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                            <input type="text" placeholder="ค้นหา..." value={search} onChange={e => setSearch(e.target.value)}
                                className="pl-8 pr-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48" />
                        </div>
                        {/* Role filter */}
                        <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
                            className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500">
                            <option value="all">All Roles</option>
                            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        {/* Plan filter */}
                        <select value={filterPlan} onChange={e => setFilterPlan(e.target.value)}
                            className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500">
                            <option value="all">All Plans</option>
                            {PLANS.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                        {/* Refresh */}
                        <button onClick={fetchUsers} title="Refresh" className="p-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-blue-600 transition-all">
                            <svg className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        </button>
                    </div>
                </div>

                {/* Table body */}
                {loading ? (
                    <div className="flex items-center justify-center py-24 gap-3 text-slate-400">
                        <div className="h-5 w-5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
                        <span className="text-sm font-bold">กำลังโหลด...</span>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-24 text-slate-400">
                        <svg className="w-10 h-10 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        <p className="text-sm font-bold">ไม่พบผู้ใช้ที่ตรงกัน</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50/70 dark:bg-slate-800/50">
                                <tr className="border-b border-slate-100 dark:border-slate-800">
                                    {["ผู้ใช้", "Role", "Plan", "Docs", "Credit Limit", "คงเหลือ", "จัดการ"].map(h => (
                                        <th key={h} className="px-5 py-3.5 text-left text-[9px] font-black uppercase tracking-[0.15em] text-slate-400">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50 dark:divide-slate-800/60">
                                {filtered.map(u => {
                                    const pct = usedPct(u);
                                    const unlimited = isUnlimited(u);
                                    const isEditing = editingId === u.id;

                                    return (
                                        <tr key={u.id} className="hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-all group">

                                            {/* User */}
                                            <td className="px-5 py-4">
                                                <div className="flex items-center gap-3">
                                                    <div className={`h-10 w-10 rounded-xl flex items-center justify-center text-white font-black text-sm shrink-0 shadow-md ${u.role === "admin" ? "bg-gradient-to-br from-amber-500 to-orange-500" : "bg-gradient-to-br from-blue-500 to-blue-700"}`}>
                                                        {u.name?.charAt(0)?.toUpperCase() || "?"}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="font-bold text-slate-800 dark:text-white text-sm">{u.name}</p>
                                                        <p className="text-[11px] text-slate-400 truncate max-w-[140px]">{u.email}</p>
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Role (inline edit) */}
                                            <td className="px-5 py-4">
                                                {isEditing && editMode === "role" ? (
                                                    <div className="flex items-center gap-1.5">
                                                        <select value={editValue} onChange={e => setEditValue(e.target.value)} autoFocus
                                                            className="px-2 py-1 rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-900/20 text-xs font-bold focus:outline-none">
                                                            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                                                        </select>
                                                        <button onClick={() => saveRole(u.id)} disabled={saving} className="p-1 rounded-md bg-emerald-500 text-white disabled:opacity-50"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></button>
                                                        <button onClick={cancelEdit} className="p-1 rounded-md bg-slate-200 dark:bg-slate-700 text-slate-500"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg></button>
                                                    </div>
                                                ) : (
                                                    <button onClick={() => startEdit(u, "role")} className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide cursor-pointer hover:ring-2 hover:ring-amber-400 transition-all ${ROLE_BADGE[u.role] || ROLE_BADGE.user}`}>
                                                        {u.role === "admin" ? "🛡️ " : "👤 "}{u.role}
                                                    </button>
                                                )}
                                            </td>

                                            {/* Plan (inline edit) */}
                                            <td className="px-5 py-4">
                                                {isEditing && editMode === "plan" ? (
                                                    <div className="flex items-center gap-1.5">
                                                        <select value={editValue} onChange={e => setEditValue(e.target.value)} autoFocus
                                                            className="px-2 py-1 rounded-lg border-2 border-blue-400 bg-blue-50 dark:bg-blue-900/20 text-xs font-bold focus:outline-none">
                                                            {PLANS.map(p => <option key={p} value={p}>{p}</option>)}
                                                        </select>
                                                        <button onClick={() => savePlan(u.id)} disabled={saving} className="p-1 rounded-md bg-emerald-500 text-white disabled:opacity-50"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></button>
                                                        <button onClick={cancelEdit} className="p-1 rounded-md bg-slate-200 dark:bg-slate-700 text-slate-500"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg></button>
                                                    </div>
                                                ) : (
                                                    <button onClick={() => startEdit(u, "plan")} className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide cursor-pointer hover:ring-2 hover:ring-blue-400 transition-all ${PLAN_COLORS[u.plan] || PLAN_COLORS.Free}`}>
                                                        {u.plan}
                                                    </button>
                                                )}
                                            </td>

                                            {/* Docs */}
                                            <td className="px-5 py-4">
                                                <p className="font-bold dark:text-white text-sm">{u.totalDocs.toLocaleString()}</p>
                                                <p className="text-[10px] text-slate-400">เอกสาร</p>
                                            </td>

                                            {/* Credit Limit (editable) */}
                                            <td className="px-5 py-4 min-w-[180px]">
                                                {isEditing && editMode === "credit" ? (
                                                    <div className="flex items-center gap-1.5">
                                                        <input type="number" min={0} value={editValue} onChange={e => setEditValue(e.target.value)}
                                                            onKeyDown={e => { if (e.key === "Enter") saveCredit(u.id); if (e.key === "Escape") cancelEdit(); }}
                                                            autoFocus placeholder="ตัวเลข"
                                                            className="w-24 px-2.5 py-1.5 rounded-lg border-2 border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-sm font-bold focus:outline-none" />
                                                        <button onClick={() => saveCredit(u.id)} disabled={saving} className="p-1.5 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></button>
                                                        <button onClick={cancelEdit} className="p-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-500"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg></button>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-bold dark:text-white text-sm">
                                                            {unlimited ? "∞ Unlimited" : u.effectiveLimit.toLocaleString()}
                                                        </span>
                                                        {u.customLimit !== null && (
                                                            <span className="text-[9px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 px-1.5 py-0.5 rounded-full font-black uppercase">custom</span>
                                                        )}
                                                    </div>
                                                )}
                                            </td>

                                            {/* Credits remaining */}
                                            <td className="px-5 py-4">
                                                {unlimited ? (
                                                    <span className="text-violet-600 dark:text-violet-400 font-bold text-xl">∞</span>
                                                ) : (
                                                    <div className="space-y-1.5 min-w-[100px]">
                                                        <div className="flex items-center justify-between gap-2">
                                                            <span className={`font-bold text-sm ${u.creditsRemaining <= 0 ? "text-rose-500" : u.creditsRemaining < u.effectiveLimit * 0.2 ? "text-amber-500" : "text-emerald-600 dark:text-emerald-400"}`}>
                                                                {u.creditsRemaining.toLocaleString()}
                                                            </span>
                                                            <span className="text-[10px] text-slate-400 font-bold">{pct}%</span>
                                                        </div>
                                                        <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                                            <div className={`h-full rounded-full transition-all duration-700 ${pct > 80 ? "bg-rose-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500"}`}
                                                                style={{ width: `${pct}%` }} />
                                                        </div>
                                                    </div>
                                                )}
                                            </td>

                                            {/* Settings Overlay for row */}
                                            {isEditing && editMode === "settings" && (
                                                <td colSpan={7} className="px-5 py-4 bg-slate-50 dark:bg-slate-800/80 animate-in fade-in duration-300">
                                                    <div className="flex flex-wrap items-center gap-6">
                                                        <div className="flex flex-col gap-1">
                                                            <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Reset Password</label>
                                                            <input
                                                                type="text"
                                                                placeholder="New Password"
                                                                className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-bold w-40"
                                                                value={editValue}
                                                                onChange={e => setEditValue(e.target.value)}
                                                            />
                                                        </div>
                                                        <div className="flex flex-col gap-1">
                                                            <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Adjust Credits</label>
                                                            <input
                                                                type="number"
                                                                className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-bold w-32"
                                                                defaultValue={u.creditsRemaining}
                                                                id={`credits-${u.id}`}
                                                            />
                                                        </div>
                                                        <div className="flex items-center gap-2 mt-4">
                                                            <button
                                                                onClick={() => {
                                                                    const credInput = document.getElementById(`credits-${u.id}`) as HTMLInputElement;
                                                                    saveSettings(u.id, {
                                                                        password: editValue,
                                                                        creditsRemaining: parseInt(credInput.value)
                                                                    });
                                                                }}
                                                                disabled={saving}
                                                                className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-emerald-500 transition-all shadow-lg shadow-emerald-600/20 disabled:opacity-50"
                                                            >
                                                                Save Changes
                                                            </button>
                                                            <button
                                                                onClick={cancelEdit}
                                                                className="px-4 py-2 bg-slate-200 dark:bg-slate-700 text-slate-500 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-slate-300 dark:hover:bg-slate-600 transition-all"
                                                            >
                                                                Cancel
                                                            </button>
                                                        </div>
                                                    </div>
                                                </td>
                                            )}

                                            {/* Actions */}
                                            <td className="px-5 py-4">
                                                {!isEditing && (
                                                    <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200">
                                                        <button onClick={() => startEdit(u, "settings")}
                                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 hover:bg-blue-600 hover:text-white text-[10px] font-black uppercase tracking-wide transition-all"
                                                            title="Settings & Reset">
                                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                                            Advanced
                                                        </button>
                                                        <button onClick={() => startEdit(u, "credit")}
                                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 hover:bg-blue-100 text-[10px] font-black uppercase tracking-wide transition-all"
                                                            title="แก้ไข Limit">
                                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                                            Limit
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Footer */}
                {!loading && (
                    <div className="px-8 py-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                        <p className="text-[11px] text-slate-400 font-bold">แสดง <span className="text-slate-600 dark:text-slate-300">{filtered.length}</span> จาก <span className="text-slate-600 dark:text-slate-300">{users.length}</span> user</p>
                        <p className="text-[11px] text-slate-400">คลิก Role หรือ Plan เพื่อเปลี่ยนแบบ inline · คลิก Credit เพื่อแก้ไข limit</p>
                    </div>
                )}
            </div>
        </div>
    );
}
