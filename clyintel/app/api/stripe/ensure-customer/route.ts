import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { ensureStripeCustomer } from "@/lib/stripe-customer";

// Idempotently attach a Stripe customer to the authenticated subscriber.
// Called from the login flow so every subscriber has a stripe_customer_id —
// the field the Stripe webhook keys on to apply plan/status updates.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const customerId = await ensureStripeCustomer(user.id);
  if (!customerId) {
    return NextResponse.json({ error: "Could not ensure Stripe customer" }, { status: 500 });
  }

  return NextResponse.json({ stripe_customer_id: customerId });
}
