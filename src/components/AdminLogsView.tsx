import React, { useState, useEffect } from "react";

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

export default function AdminLogsView({ userId }: { userId: string }) {
    const [logs, setLogs] = useState<SystemLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchLogs = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/admin/logs?userId=${userId}`);
            const data = await res.json() as any;
            if (data.success) {
                setLogs(data.logs);
            } else {
                setError(data.error || "Failed to load logs");
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();
    }, [userId]);

    const formatTime = (ts: string) => {
        const d = new Date(ts);
        return new Intl.DateTimeFormat('en-US', {
             month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).format(d);
    };

    return (
        <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-[1.75rem] border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-6 md:p-8 space-y-8">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                            <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                            </div>
                            System Events & Logs
                        </h2>
                        <p className="text-sm text-slate-500 mt-2 font-medium">Trace application events and track errors globally.</p>
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
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium">
                            {logs.length === 0 && !loading && (
                                <tr>
                                    <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
                                        No logs recorded yet.
                                    </td>
                                </tr>
                            )}
                            {logs.map(log => (
                                <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                                    <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap">{formatTime(log.created_at)}</td>
                                    <td className="px-5 py-3">
                                        <span className={`inline-flex items-center px-2 py-1 rounded text-[10px] uppercase font-black tracking-widest ${
                                            log.level === 'error' ? 'bg-rose-100 text-rose-600 dark:bg-rose-900/30' :
                                            log.level === 'warning' ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30' :
                                            'bg-blue-100 text-blue-600 dark:bg-blue-900/30'
                                        }`}>
                                            {log.level}
                                        </span>
                                    </td>
                                    <td className="px-5 py-3 font-bold text-slate-700 dark:text-slate-300">
                                        {log.action}
                                    </td>
                                    <td className="px-5 py-3 text-xs text-slate-500 max-w-[200px] truncate" title={log.details}>
                                        {log.details}
                                    </td>
                                    <td className="px-5 py-3 text-xs flex items-center gap-2">
                                        {log.user_email ? (
                                            <div className="flex flex-col">
                                                <span className="font-bold text-slate-700 dark:text-slate-300">{log.user_name || 'User'}</span>
                                                <span className="text-[10px] text-slate-400">{log.user_email}</span>
                                            </div>
                                        ) : (
                                            <span className="text-slate-400 italic">System / Anonymous</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
