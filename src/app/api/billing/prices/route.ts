import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import Stripe from "stripe";


export async function GET(request: NextRequest) {
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

        // Fetch all active prices
        const prices = await stripe.prices.list({
            active: true,
            limit: 100,
            expand: ['data.product'],
        });

        const priceMap: Record<string, any> = {};

        // Helper to find price by ID from the list
        const findPrice = (id?: string) => {
            if (!id) return null;
            const cleanId = id.toString().trim();
            const p = prices.data.find(x => x.id === cleanId);
            if (!p) return null;
            return p.unit_amount ? (p.unit_amount / 100).toLocaleString('en-US', { style: 'currency', currency: p.currency }) : null;
        };

        const starterId = env.STRIPE_PRICE_STARTER || process.env.STRIPE_PRICE_STARTER;
        const proId = env.STRIPE_PRICE_PRO || process.env.STRIPE_PRICE_PRO;
        const enterpriseId = env.STRIPE_PRICE_ENTERPRISE || process.env.STRIPE_PRICE_ENTERPRISE;

        priceMap.starter = findPrice(starterId as string) || "$9";
        priceMap.pro = findPrice(proId as string) || "$19";
        priceMap.enterprise = findPrice(enterpriseId as string) || "$99";

        // ADD DEBUG INFO
        priceMap._debug = {
            hasStripeKey: !!stripeKey,
            stripeKeyPrefix: stripeKey ? stripeKey.substring(0, 7) : null,
            envStarterId: starterId,
            envProId: proId,
            envEnterpriseId: enterpriseId,
            totalPricesFetched: prices.data.length,
            availablePriceIds: prices.data.map(p => p.id),
        };

        return NextResponse.json(priceMap);
    } catch (error: any) {
        console.error("Error fetching Stripe prices:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
