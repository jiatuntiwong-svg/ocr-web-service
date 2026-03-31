import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import Stripe from "stripe";


export async function POST(request: NextRequest) {
    try {
        let env: any = process.env;
        try {
            const ctx = await getCloudflareContext();
            if (ctx && ctx.env) {
                env = { ...process.env, ...ctx.env };
            }
        } catch (e) {
            console.log("Using process.env fallback");
        }

        const stripeKey = (env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || "").toString().trim();
        const stripe = new Stripe(stripeKey, {
            apiVersion: "2023-10-16" as any,
        });

        const { userId, plan, type, credits } = await request.json() as {
            userId: string;
            plan: string;
            type: 'subscription' | 'topup';
            credits?: number;
        };

        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const sessionParams: Stripe.Checkout.SessionCreateParams = {
            payment_method_types: type === "subscription" ? ["card"] : ["card", "promptpay"],
            line_items: [],
            mode: type === "subscription" ? "subscription" : "payment",
            client_reference_id: userId,
            success_url: `${request.nextUrl.origin}/?billing=success`,
            cancel_url: `${request.nextUrl.origin}/?billing=cancel`,
            metadata: { userId, plan, type, credits: credits?.toString() || "0" },
        };

        if (type === "subscription") {
            // Define your Stripe Price IDs here
            let priceId = "";
            const starterId = env.STRIPE_PRICE_STARTER || process.env.STRIPE_PRICE_STARTER;
            const proId = env.STRIPE_PRICE_PRO || process.env.STRIPE_PRICE_PRO;
            const enterpriseId = env.STRIPE_PRICE_ENTERPRISE || process.env.STRIPE_PRICE_ENTERPRISE;

            if (plan === "starter") priceId = starterId;
            else if (plan === "pro") priceId = proId;
            else priceId = enterpriseId;

            sessionParams.line_items?.push({
                price: priceId?.toString().trim(),
                quantity: 1,
            });
        } else {
            // One-time Top-up
            sessionParams.line_items?.push({
                price_data: {
                    currency: "thb",
                    product_data: {
                        name: `${credits} OCR Credits Top-up`,
                        description: "Additional document processing credits",
                    },
                    unit_amount: plan === "Topup50" ? 19900 : 39900, // 199 THB or 399 THB
                },
                quantity: 1,
            });
        }

        const session = await stripe.checkout.sessions.create(sessionParams);

        return NextResponse.json({ url: session.url });
    } catch (err: any) {
        console.error("Stripe Session Error:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
