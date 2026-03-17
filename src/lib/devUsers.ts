// Shared dev-mode fallback users
// Used by auth and admin APIs when D1 is unavailable (next dev mode)

export const DEV_USERS = [
    { id: "user-free", name: "Free User", email: "free@ocrpro.com", password: "free1234", role: "user", plan: "Free" as const },
    { id: "user-starter", name: "Starter User", email: "starter@ocrpro.com", password: "start123", role: "user", plan: "Starter" as const },
    { id: "user-pro", name: "Pro User", email: "pro@ocrpro.com", password: "pro12345", role: "user", plan: "Pro" as const },
    { id: "user-ent", name: "Enterprise User", email: "ent@ocrpro.com", password: "ent1234", role: "user", plan: "Enterprise" as const },
    { id: "admin-sys", name: "System Admin", email: "admin@ocrpro.com", password: "admin1234", role: "admin", plan: "System" as const },
];

export type Plan = "Free" | "Starter" | "Pro" | "Enterprise" | "System";

export const PLAN_LIMITS: Record<string, number> = {
    free: 50,
    starter: 500,
    pro: 1000,
    enterprise: 999999,
    system: 999999,
};

export const RETENTION_LIMITS: Record<string, number> = {
    free: 50,
    starter: 100,
    pro: 500,
    enterprise: 1000,
    system: 1000,
};
