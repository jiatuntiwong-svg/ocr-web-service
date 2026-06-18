"use client";
import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/contexts/AppContext";

// Client-side guard: only role=admin gets through. API routes still verify
// admin role server-side via requireAdmin, so this is UX-only — not the
// actual security boundary.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const { user } = useApp();

    useEffect(() => {
        if (user && user.role !== "admin") router.replace("/dashboard");
    }, [user, router]);

    if (!user) return null;
    if (user.role !== "admin") return null;
    return <>{children}</>;
}
