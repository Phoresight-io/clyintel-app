import { getSupabase } from "@/lib/supabase";
import { createCustomer } from "@/lib/stripe";

// Idempotently ensure a subscriber has a Stripe customer id.
//
// The `handle_new_auth_user` Postgres trigger creates the subscribers row on
// signup but cannot make the outbound Stripe call, so we attach the customer at
// the application layer on the subscriber's first authenticated session (auth
// callback / login) and as a safety net before Checkout.
//
// Returns the customer id, or null if it could not be created (e.g.
// STRIPE_SECRET_KEY missing) — callers decide how to handle that. Safe to call
// on every login: it only hits Stripe when the id is absent.
export async function ensureStripeCustomer(userId: string): Promise<string | null> {
  const supabase = getSupabase();

  const { data: subscriber, error } = await supabase
    .from("subscribers")
    .select("id, email, stripe_customer_id")
    .eq("id", userId)
    .maybeSingle();

  if (error || !subscriber) {
    console.error("ensureStripeCustomer: subscriber lookup failed", error);
    return null;
  }
  if (subscriber.stripe_customer_id) return subscriber.stripe_customer_id;

  let customerId: string;
  try {
    customerId = await createCustomer(subscriber.email, subscriber.id);
  } catch (err) {
    console.error("ensureStripeCustomer: Stripe customer creation failed", err);
    return null;
  }

  // Only write if still unset (guards against a concurrent caller having won).
  const { data: updated, error: updateError } = await supabase
    .from("subscribers")
    .update({ stripe_customer_id: customerId })
    .eq("id", userId)
    .is("stripe_customer_id", null)
    .select("stripe_customer_id");

  if (updateError) {
    console.error("ensureStripeCustomer: failed to store stripe_customer_id", updateError);
    return null;
  }

  // A concurrent call already set the id; defer to the stored value.
  if (!updated || updated.length === 0) {
    const { data: refreshed } = await supabase
      .from("subscribers")
      .select("stripe_customer_id")
      .eq("id", userId)
      .maybeSingle();
    return refreshed?.stripe_customer_id ?? customerId;
  }

  await supabase.from("audit_log").insert({
    subscriber_id: userId,
    actor: "system",
    actor_detail: "stripe-ensure-customer",
    action: "create_stripe_customer",
    entity_type: "subscriber",
    entity_id: userId,
    payload: { stripe_customer_id: customerId } as never,
  });

  return customerId;
}
