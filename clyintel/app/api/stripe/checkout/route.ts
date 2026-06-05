import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { ensureStripeCustomer } from "@/lib/stripe-customer";
import { getProductDefaultPrice, createCheckoutSession } from "@/lib/stripe";

// Subscriber-initiated upgrade to a paid plan.
//
// Ensures the subscriber has a Stripe customer, resolves the target plan's
// price from its Stripe product's default_price, creates a subscription-mode
// Checkout Session, and returns the hosted URL. On successful payment the
// existing /api/stripe-webhook updates plan_id + subscription_status.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CheckoutBody {
  planId?: string;
}

export async function POST(req: NextRequest) {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: CheckoutBody;
  try {
    body = (await req.json()) as CheckoutBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const planId = body.planId?.trim();
  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: plan, error: planError } = await supabase
    .from("plans")
    .select("id, tier, display_name, monthly_price_cents, stripe_product_id")
    .eq("id", planId)
    .maybeSingle();

  if (planError || !plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  // Only self-serve paid tiers go through Checkout. Free is revenue-share only
  // (business rule #1) and Enterprise is sales-assisted; neither is checkout-able.
  if (
    plan.tier === "free" ||
    plan.tier === "enterprise" ||
    !plan.stripe_product_id ||
    plan.monthly_price_cents <= 0
  ) {
    return NextResponse.json(
      { error: "This plan is not available for self-serve checkout" },
      { status: 400 }
    );
  }

  const customerId = await ensureStripeCustomer(user.id);
  if (!customerId) {
    return NextResponse.json({ error: "Could not resolve Stripe customer" }, { status: 500 });
  }

  let priceId: string | null;
  try {
    priceId = await getProductDefaultPrice(plan.stripe_product_id);
  } catch (err) {
    console.error("checkout: price lookup failed", err);
    return NextResponse.json({ error: "Could not resolve plan price" }, { status: 502 });
  }
  if (!priceId) {
    return NextResponse.json(
      { error: "Plan has no default price configured in Stripe" },
      { status: 502 }
    );
  }

  const origin = req.nextUrl.origin;
  let url: string;
  try {
    url = await createCheckoutSession({
      customerId,
      priceId,
      subscriberId: user.id,
      successUrl: `${origin}/settings?upgrade=success`,
      cancelUrl: `${origin}/settings?upgrade=cancelled`,
    });
  } catch (err) {
    console.error("checkout: session creation failed", err);
    return NextResponse.json({ error: "Could not start checkout" }, { status: 502 });
  }

  await supabase.from("audit_log").insert({
    subscriber_id: user.id,
    actor: "subscriber",
    actor_detail: user.email ?? null,
    action: "start_checkout",
    entity_type: "subscriber",
    entity_id: user.id,
    payload: {
      plan_id: plan.id,
      tier: plan.tier,
      stripe_customer_id: customerId,
      price_id: priceId,
    } as never,
  });

  return NextResponse.json({ url });
}
