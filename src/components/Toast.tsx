"use client";
import React, { useCallback, useState } from "react";

export type ToastType = "success" | "error" | "info";
export interface ToastState { msg: string; type: ToastType }

export function Toast({ msg, type }: ToastState) {
    const bg = type === "success" ? "bg-emerald-600" : type === "error" ? "bg-rose-600" : "bg-blue-600";
    const icon = type === "success"
        ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        : type === "error"
            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
            : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />;
    return (
        <div className={`fixed top-6 right-6 z-[9999] px-5 py-3 rounded-2xl shadow-2xl text-sm font-bold flex items-center gap-2 animate-in slide-in-from-top-3 duration-300 ${bg} text-white max-w-sm`}>
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">{icon}</svg>
            <span className="leading-snug">{msg}</span>
        </div>
    );
}

export function useToast() {
    const [toast, setToast] = useState<ToastState | null>(null);
    const showToast = useCallback((msg: string, type: ToastType = "success", durationMs = 3200) => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), durationMs);
    }, []);
    const toastNode = toast ? <Toast msg={toast.msg} type={toast.type} /> : null;
    return { showToast, toastNode };
}
