import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import Stripe from "stripe";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    try {
        const { env } = await getCloudflareContext();
        const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
            apiVersion: "2026-02-25.clover" as any,
        });

        // Fetch all active prices
        const prices = await stripe.prices.list({
            active: true,
            limit: 10,
            expand: ['data.product'],
        });

        const priceMap: Record<string, any> = {};

        // Helper to find price by ID from the list
        const findPrice = (id?: string) => {
            if (!id) return null;
            const p = prices.data.find(x => x.id === id);
            if (!p) return null;
            return p.unit_amount ? (p.unit_amount / 100).toLocaleString('en-US', { style: 'currency', currency: p.currency }) : null;
        };

        priceMap.starter = findPrice(env.STRIPE_PRICE_STARTER as string) || "$9";
        priceMap.pro = findPrice(env.STRIPE_PRICE_PRO as string) || "$19";
        priceMap.enterprise = findPrice(env.STRIPE_PRICE_ENTERPRISE as string) || "$99";

        return NextResponse.json(priceMap);
    } catch (error: any) {
        console.error("Error fetching Stripe prices:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
