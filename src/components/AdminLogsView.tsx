import React, { useState, useEffect, useMemo } from "react";
import { useToast } from "@/components/Toast";
import { fetchJson } from "@/lib/fetchJson";
import { apiError } from "@/lib/friendlyError";
import { useTranslation } from "@/lib/i18n/LocaleContext";

interface SystemLog {
    id: string;
    user_id: string;
    user_name?: string;
    user_email?: string;
    action: string;
    details: string;
    level: 'info' | 'warning' | 'error';
    created_at: string;
}

type LevelFilter = 'all' | 'info' | 'warning' | 'error';

export default function AdminLogsView({ userId }: { userId: string }) {
    const { t } = useTranslation();
    const { showToast, toastNode } = useToast();
    const [logs, setLogs] = useState<SystemLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
    const [search, setSearch] = useState('');

    const fetchLogs = async () => {
        setLoading(true);
        setError(null);
        const data = await fetchJson<{ logs: SystemLog[] }>(`/api/admin/logs?userId=${userId}`);
        setLoading(false);
        if (data.ok) {
            setLogs(data.logs);
        } else {
            setError(apiError(data.code, data.vars, t));
        }
    };

    useEffect(() => {
        fetchLogs();
    }, [userId]);

    // SQLite stores `datetime('now')` as UTC without a 'Z' suffix, so JS parses
    // it as local time → wrong by browser-TZ offset. Append 'Z' to force UTC,
    // then render in Asia/Bangkok.
    const formatTime = (ts: string) => {
        const iso = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return ts;
        return new Intl.DateTimeFormat('th-TH', {
            timeZone: 'Asia/Bangkok',
            year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        }).format(d);
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return logs.filter(l => {
            if (levelFilter !== 'all' && l.level !== levelFilter) return false;
            if (!q) return true;
            return (
                (l.action || '').toLowerCase().includes(q)
                || (l.details || '').toLowerCase().includes(q)
                || (l.user_name || '').toLowerCase().includes(q)
                || (l.user_email || '').toLowerCase().includes(q)
            );
        });
    }, [logs, levelFilter, search]);

    const copyLog = async (log: SystemLog) => {
        const text = `[${formatTime(log.created_at)}] [${log.level.toUpperCase()}] ${log.action}\n${log.details}${log.user_email ? `\nuser: ${log.user_email}` : ''}`;
        try {
            await navigator.clipboard.writeText(text);
            showToast('คัดลอกแล้ว', 'success');
        } catch {
            showToast('ไม่สามารถคัดลอกได้', 'error');
        }
    };

    const counts = useMemo(() => ({
        all: logs.length,
        info: logs.filter(l => l.level === 'info').length,
        warning: logs.filter(l => l.level === 'warning').length,
        error: logs.filter(l => l.level === 'error').length,
    }), [logs]);

    const FilterChip = ({ value, label }: { value: LevelFilter; label: string }) => {
        const active = levelFilter === value;
        const activeBg = value === 'error' ? 'bg-rose-600' : value === 'warning' ? 'bg-amber-600' : value === 'info' ? 'bg-blue-600' : 'bg-slate-700';
        return (
            <button
                onClick={() => setLevelFilter(value)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition flex items-center gap-2 ${active
                    ? `${activeBg} text-white shadow-sm`
                    : `bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700`}`}
            >
                {label}
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${active ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700 text-slate-500'}`}>
                    {counts[value]}
                </span>
            </button>
        );
    };

    return (
        <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            {toastNode}
            <div className="p-6 md:p-8 space-y-6">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                            <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                            </div>
                            System Events & Logs
                        </h2>
                        <p className="text-sm text-slate-500 mt-2 font-medium">Trace application events and track errors globally. (TZ: Asia/Bangkok)</p>
                    </div>
                    <button
                        onClick={fetchLogs}
                        disabled={loading}
                        className="px-5 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 transition flex items-center gap-2 text-sm font-bold disabled:opacity-50"
                    >
                        <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        Refresh Logs
                    </button>
                </div>

                <div className="flex flex-col md:flex-row md:items-center gap-3">
                    <div className="flex gap-2 flex-wrap">
                        <FilterChip value="all" label="All" />
                        <FilterChip value="error" label="Error" />
                        <FilterChip value="warning" label="Warning" />
                        <FilterChip value="info" label="Info" />
                    </div>
                    <div className="flex-1 relative">
                        <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="ค้นหาใน action / details / user…"
                            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                        />
                    </div>
                    {(levelFilter !== 'all' || search) && (
                        <button
                            onClick={() => { setLevelFilter('all'); setSearch(''); }}
                            className="text-xs font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-2"
                        >
                            Clear
                        </button>
                    )}
                </div>

                {error && (
                    <div className="p-4 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl text-sm font-bold flex items-center gap-2">
                        <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <span>{error}</span>
                    </div>
                )}

                <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm overflow-x-auto">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead className="bg-slate-50/50 dark:bg-slate-900/50 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                            <tr>
                                <th className="px-5 py-4">Timestamp</th>
                                <th className="px-5 py-4">Level</th>
                                <th className="px-5 py-4">Action</th>
                                <th className="px-5 py-4 w-1/2">Details</th>
                                <th className="px-5 py-4">User</th>
                                <th className="px-5 py-4 text-right">Copy</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium">
                            {filtered.length === 0 && !loading && (
                                <tr>
                                    <td colSpan={6} className="px-5 py-8 text-center text-slate-400">
                                        {logs.length === 0 ? 'No logs recorded yet.' : 'No logs match the current filter.'}
                                    </td>
                                </tr>
                            )}
                            {filtered.map(log => (
                                <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                                    <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap font-mono">{formatTime(log.created_at)}</td>
                                    <td className="px-5 py-3">
                                        <span className={`inline-flex items-center px-2 py-1 rounded text-[10px] uppercase font-black tracking-widest ${log.level === 'error' ? 'bg-rose-100 text-rose-600 dark:bg-rose-900/30' :
                                            log.level === 'warning' ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30' :
                                                'bg-blue-100 text-blue-600 dark:bg-blue-900/30'
                                            }`}>
                                            {log.level}
                                        </span>
                                    </td>
                                    <td className="px-5 py-3 font-bold text-slate-700 dark:text-slate-300">
                                        {log.action}
                                    </td>
                                    <td className="px-5 py-3 text-xs text-slate-500 max-w-[280px] truncate" title={log.details}>
                                        {log.details}
                                    </td>
                                    <td className="px-5 py-3 text-xs">
                                        {log.user_email ? (
                                            <div className="flex flex-col">
                                                <span className="font-bold text-slate-700 dark:text-slate-300">{log.user_name || 'User'}</span>
                                                <span className="text-[10px] text-slate-400">{log.user_email}</span>
                                            </div>
                                        ) : (
                                            <span className="text-slate-400 italic">System / Anonymous</span>
                                        )}
                                    </td>
                                    <td className="px-5 py-3 text-right">
                                        <button
                                            onClick={() => copyLog(log)}
                                            title="Copy log entry"
                                            className="opacity-0 group-hover:opacity-100 transition p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500"
                                        >
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2v-1m-6-4h8m0 0V9a2 2 0 00-2-2h-5L9 4H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></svg>
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {logs.length > 0 && (
                    <p className="text-xs text-slate-400 text-right">
                        Showing {filtered.length} of {logs.length} logs
                    </p>
                )}
            </div>
        </div>
    );
}
