import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as { name?: string; email?: string; password?: string };
        const name = body.name?.trim() ?? "";
        const email = body.email?.toLowerCase().trim() ?? "";
        const password = body.password ?? "";

        if (!name || !email || !password) {
            return NextResponse.json({ error: "Name, email, and password are required" }, { status: 400 });
        }

        if (password.length < 6) {
            return NextResponse.json({ error: "Password must be at least 6 characters long" }, { status: 400 });
        }

        const { env } = await getCloudflareContext();
        
        if (!env?.DB) {
            // Development mode without DB: return success but don't persist
            return NextResponse.json({ success: true, message: "Dev mode: Registration simulated" });
        }

        // Check if email already exists
        const existing = await env.DB
            .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
            .bind(email)
            .first();

        if (existing) {
            return NextResponse.json({ error: "Email is already registered" }, { status: 400 });
        }

        // Create new user record
        const id = crypto.randomUUID();
        await env.DB
            .prepare("INSERT INTO users (id, name, email, password, role, plan) VALUES (?, ?, ?, ?, 'user', 'Free')")
            .bind(id, name, email, password)
            .run();

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error("[Register POST] error:", err);
        return NextResponse.json({ error: "Registration failed. Please try again later." }, { status: 500 });
    }
}
