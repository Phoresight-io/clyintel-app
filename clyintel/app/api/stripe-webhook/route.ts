import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import crypto from "crypto";
import { getSupabase } from "@/lib/supabase";

// Stripe webhook → Supabase subscriber sync.
//
// We verify the Stripe signature manually with HMAC-SHA256 (no `stripe` npm
// package, per product rule "do not add packages without approval"). The
// handler returns 200 immediately and processes the event asynchronously via
// `waitUntil` so Stripe never sees a slow response or retries on our work.

export const runtime = "nodejs";
// Stripe signature verification needs the raw, unparsed request body.
export const dynamic = "force-dynamic";

const TOLERANCE_SECONDS = 60 * 5;

// Verify the `Stripe-Signature` header against the raw payload.
function verifyStripeSignature(payload: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = header.split(",").reduce<Record<string, string>>((acc, part) => {
    const [key, value] = part.split("=");
    if (key && value) acc[key.trim()] = value.trim();
    return acc;
  }, {});

  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Reject stale timestamps to mitigate replay attacks.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

async function writeAudit(
  subscriberId: string,
  action: string,
  entityId: string | null,
  payload: Record<string, unknown>
) {
  const supabase = getSupabase();
  const { error } = await supabase.from("audit_log").insert({
    subscriber_id: subscriberId,
    actor: "system",
    actor_detail: "stripe-webhook",
    action,
    entity_type: "subscriber",
    entity_id: entityId,
    payload: payload as never,
  });
  if (error) console.error("audit_log insert failed", error);
}

// Resolve the Stripe product id from a subscription object's first line item.
function extractProductId(subscription: Record<string, unknown>): string | null {
  const items = subscription["items"] as { data?: Array<{ price?: { product?: unknown } }> } | undefined;
  const product = items?.data?.[0]?.price?.product;
  return typeof product === "string" ? product : null;
}

async function updateSubscriberStatus(
  customerId: string,
  status: string,
  productId: string | null,
  eventType: string,
  eventId: string
) {
  const supabase = getSupabase();

  const { data: subscriber, error: lookupError } = await supabase
    .from("subscribers")
    .select("id, plan_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (lookupError || !subscriber) {
    console.error(`stripe-webhook: no subscriber for customer ${customerId}`, lookupError);
    return;
  }

  const update: { subscription_status: string; plan_id?: string } = { subscription_status: status };

  // Match the plan by stripe_product_id when the event carries one.
  if (productId) {
    const { data: plan } = await supabase
      .from("plans")
      .select("id")
      .eq("stripe_product_id", productId)
      .maybeSingle();
    if (plan) update.plan_id = plan.id;
  }

  const { error: updateError } = await supabase
    .from("subscribers")
    .update(update)
    .eq("id", subscriber.id);

  if (updateError) {
    console.error("stripe-webhook: subscriber update failed", updateError);
    return;
  }

  await writeAudit(subscriber.id, eventType, subscriber.id, {
    stripe_event_id: eventId,
    stripe_customer_id: customerId,
    subscription_status: status,
    plan_matched: update.plan_id ?? null,
  });
}

async function processEvent(event: StripeEvent) {
  const object = event.data.object;

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const customerId = object["customer"] as string;
      if (customerId) {
        await updateSubscriberStatus(customerId, "active", extractProductId(object), event.type, event.id);
      }
      break;
    }
    case "customer.subscription.deleted": {
      const customerId = object["customer"] as string;
      if (customerId) {
        await updateSubscriberStatus(customerId, "canceled", null, event.type, event.id);
      }
      break;
    }
    case "invoice.payment_succeeded": {
      const customerId = object["customer"] as string;
      if (customerId) {
        await updateSubscriberStatus(customerId, "active", null, event.type, event.id);
      }
      break;
    }
    case "invoice.payment_failed": {
      const customerId = object["customer"] as string;
      if (customerId) {
        await updateSubscriberStatus(customerId, "past_due", null, event.type, event.id);
      }
      break;
    }
    default:
      // Unhandled event types are acknowledged but ignored.
      break;
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  const payload = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!verifyStripeSignature(payload, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Acknowledge immediately; do the database work asynchronously.
  waitUntil(processEvent(event).catch((err) => console.error("stripe-webhook processing error", err)));

  return NextResponse.json({ received: true }, { status: 200 });
}
