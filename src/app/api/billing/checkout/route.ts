import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import Stripe from "stripe";


export async function POST(request: NextRequest) {
    try {
        const { env } = await getCloudflareContext();
        const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
            apiVersion: "2026-02-25.clover" as any,
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
            if (plan === "starter") priceId = env.STRIPE_PRICE_STARTER;
            else if (plan === "pro") priceId = env.STRIPE_PRICE_PRO;
            else priceId = env.STRIPE_PRICE_ENTERPRISE;

            sessionParams.line_items?.push({
                price: priceId as string,
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
