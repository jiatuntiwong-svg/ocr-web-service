export async function logSystemEvent(
    env: any,
    action: string,
    details: string,
    level: 'info' | 'warning' | 'error' = 'info',
    userId: string | null = null
) {
    try {
        if (!env?.DB) return;
        
        // Auto-create just in case it's the first run
        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                action TEXT,
                details TEXT,
                level TEXT DEFAULT 'info',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `).run();

        const id = typeof crypto !== "undefined" && crypto.randomUUID 
                   ? crypto.randomUUID() 
                   : Date.now().toString(36) + Math.random().toString(36).substring(2);
        await env.DB.prepare(`
            INSERT INTO system_logs (id, user_id, action, details, level)
            VALUES (?, ?, ?, ?, ?)
        `).bind(id, userId, action, details, level).run();
    } catch (err) {
        console.error("Failed to write to system_logs:", err);
    }
}
