/**
 * useAuth.ts
 * Handles authentication check on mount, redirects to /login if unauthenticated.
 * Returns { user, authChecked, handleLogout }.
 */
"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { User } from "@/lib/types";

export function useAuth() {
    const router = useRouter();
    const [user, setUser] = useState<User | null>(null);
    const [authChecked, setAuthChecked] = useState(false);

    useEffect(() => {
        fetch("/api/auth")
            .then((r) => r.json())
            .then((d: any) => {
                if (d.user) {
                    setUser(d.user);
                    localStorage.setItem("ocr_user", JSON.stringify(d.user));
                } else {
                    router.replace("/login");
                }
            })
            .catch(() => {
                // Fallback: use cached user from localStorage when API is unreachable
                const saved = localStorage.getItem("ocr_user");
                if (saved) {
                    setUser(JSON.parse(saved));
                } else {
                    router.replace("/login");
                }
            })
            .finally(() => setAuthChecked(true));
    }, [router]);

    const handleLogout = async () => {
        await fetch("/api/auth", { method: "DELETE" });
        localStorage.removeItem("ocr_user");
        router.replace("/login");
    };

    return { user, authChecked, handleLogout };
}
