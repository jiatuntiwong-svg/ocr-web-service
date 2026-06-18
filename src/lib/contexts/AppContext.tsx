"use client";
import React, { createContext, useContext } from "react";
import type { User, UsageStats } from "@/lib/types";
import type { BatchItem } from "@/lib/types/batch";

interface AppContextValue {
    user: User | null;
    usageStats: UsageStats;
    fetchStats: () => Promise<void> | void;
    handleLogout: () => Promise<void> | void;
    // Batch state lives at the layout level so it survives navigation away
    // from /ocr and back (File objects can't be persisted, so this is a
    // memory-only stash — a hard refresh still clears it).
    batchItems: BatchItem[];
    setBatchItems: React.Dispatch<React.SetStateAction<BatchItem[]>>;
    batchRunning: boolean;
    setBatchRunning: React.Dispatch<React.SetStateAction<boolean>>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
    value,
    children,
}: {
    value: AppContextValue;
    children: React.ReactNode;
}) {
    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error("useApp must be used inside <AppProvider> ((app)/layout.tsx)");
    return ctx;
}
