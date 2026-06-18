// Single source of truth for menu view <-> URL mapping.
// Keeps NavRail / TopBar / notifications / admin guard in sync.

export const VIEW_TO_PATH: Record<string, string> = {
    dashboard: "/dashboard",
    ocr: "/ocr",
    compare: "/compare",
    documents: "/documents",
    billing: "/billing",
    settings: "/settings",
    admin_users: "/admin/users",
    admin_ai_usage: "/admin/ai-usage",
    admin_logs: "/admin/logs",
    admin_feedback: "/admin/feedback",
    admin_tier_control: "/admin/tier-control",
};

const PATH_PREFIX_TO_VIEW: Array<[string, string]> = [
    ["/admin/users", "admin_users"],
    ["/admin/ai-usage", "admin_ai_usage"],
    ["/admin/logs", "admin_logs"],
    ["/admin/feedback", "admin_feedback"],
    ["/admin/tier-control", "admin_tier_control"],
    ["/dashboard", "dashboard"],
    ["/ocr", "ocr"],
    ["/compare", "compare"],
    ["/documents", "documents"],
    ["/billing", "billing"],
    ["/settings", "settings"],
];

export function pathToView(pathname: string): string {
    for (const [prefix, view] of PATH_PREFIX_TO_VIEW) {
        if (pathname === prefix || pathname.startsWith(prefix + "/")) return view;
    }
    return "dashboard";
}

export function viewToPath(view: string): string {
    return VIEW_TO_PATH[view] ?? "/dashboard";
}
