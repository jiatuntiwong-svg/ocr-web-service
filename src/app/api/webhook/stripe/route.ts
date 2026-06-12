import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import Stripe from "stripe";
import { loadTierCredits, creditForPlan } from "@/lib/tier-config";
import { broadcastToAdmins } from "@/lib/notifications";


export async function POST(request: NextRequest) {
    const { env } = await getCloudflareContext();
    const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
        apiVersion: "2026-02-25.clover" as any,
    });

    const signature = request.headers.get("stripe-signature");
    if (!signature) return new Response("No signature", { status: 400 });

    try {
        const body = await request.text();
        console.log("🔔 Webhook received:", signature ? "Has Signature" : "No Signature");

        const event = await stripe.webhooks.constructEventAsync(
            body,
            signature,
            env.STRIPE_WEBHOOK_SECRET as string
        );

        console.log("✅ Event type:", event.type);
        const db = env.DB;

        switch (event.type) {
            case "checkout.session.completed": {
                const session = event.data.object as Stripe.Checkout.Session;
                const userId = session.client_reference_id;
                const type = session.metadata?.type;
                const plan = session.metadata?.plan || "Pro";

                console.log("💰 Data:", { userId, type, plan });

                if (!userId) {
                    console.error("❌ No client_reference_id");
                    break;
                }

                if (type === "subscription") {
                    // Stamp the new plan's configured credit (admin-editable).
                    const tierCredits = await loadTierCredits(env);
                    const credits = creditForPlan(tierCredits, plan);
                    console.log(`🆙 Updating user ${userId} to ${plan} (${credits} credits)`);

                    // Ensure user exists in DB (especially for dev users)
                    await db.prepare("INSERT OR IGNORE INTO users (id, email, name, role, plan) VALUES (?, ?, ?, 'user', 'Free')")
                        .bind(userId, session.customer_details?.email || "", session.customer_details?.name || "Customer").run();

                    const res = await db.prepare(
                        "UPDATE users SET plan = ?, credits_total = ?, credits_remaining = ?, subscription_id = ?, subscription_status = 'active', last_reset_date = CURRENT_TIMESTAMP WHERE id = ?"
                    ).bind(plan, credits, credits, session.subscription, userId).run();
                    console.log("✅ DB Update:", res.success ? "OK" : "Error");
                } else if (type === "topup") {
                    const amount = parseInt(session.metadata?.credits || "50");
                    await db.prepare(
                        "UPDATE users SET extra_credits = extra_credits + ? WHERE id = ?"
                    ).bind(amount, userId).run();
                    console.log(`➕ Top-up: ${amount} credits`);
                }

                // Log transaction
                await db.prepare(
                    "INSERT INTO transactions (id, user_id, stripe_session_id, amount, currency, status, type) VALUES (?, ?, ?, ?, ?, ?, ?)"
                ).bind(
                    crypto.randomUUID(),
                    userId,
                    session.id,
                    session.amount_total ? session.amount_total / 100 : 0,
                    session.currency,
                    "completed",
                    type || "subscription"
                ).run();
                console.log("📄 Transaction logged");

                await broadcastToAdmins(env, {
                    kind: "payment",
                    severity: "info",
                    title: type === "topup" ? "Top-up purchased" : "Subscription started",
                    body: `${session.customer_details?.email || userId} — ${plan} (${session.amount_total ? (session.amount_total / 100).toFixed(2) : 0} ${session.currency?.toUpperCase() || ""})`,
                    link: "/admin_users",
                    metadata: { userId, plan, type, amount: session.amount_total },
                });

                break;
            }

            case "customer.subscription.deleted": {
                const sub = event.data.object as Stripe.Subscription;
                console.log("❌ Sub Canceled:", sub.id);
                // Downgrade to Free → re-stamp with the configured Free credit.
                const tierCredits = await loadTierCredits(env);
                const freeCredit = creditForPlan(tierCredits, "free");
                await db.prepare(
                    "UPDATE users SET plan = 'Free', subscription_status = 'canceled', credits_total = ? WHERE subscription_id = ?"
                ).bind(freeCredit, sub.id).run();
                break;
            }
        }

        return NextResponse.json({ received: true });
    } catch (err: any) {
        console.error("🚨 Webhook ERROR:", err.message);
        return new Response(`Webhook Error: ${err.message}`, { status: 400 });
    }
}
