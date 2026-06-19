import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import crypto from "crypto";
import { getSupabase } from "@/lib/supabase";
import { sendEmail } from "@/lib/email";

// Free plan: the canonical downgrade target on cancellation. Only the id is
// hardcoded — the plan's entitlements are read at runtime so this never drifts
// from the plans row.
const FREE_PLAN_ID = "db2ec96b-8fa2-4784-8f84-c6fc178641ee";

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
  created?: number;
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

// Reconcile a canceled subscription: downgrade the subscriber to Free and send
// a cancellation email. Idempotent and signature-verified (caller verifies the
// signature). On an unresolvable subscriber we FAIL LOUD via the error log but
// still return normally so Stripe doesn't retry forever (caller returns 200).
async function handleSubscriptionDeleted(
  subscription: Record<string, unknown>,
  eventId: string
) {
  const supabase = getSupabase();

  const metadata = (subscription["metadata"] as Record<string, unknown> | undefined) ?? {};
  const metaSubscriberId =
    typeof metadata["subscriber_id"] === "string" ? (metadata["subscriber_id"] as string) : null;
  const subscriptionId =
    typeof subscription["id"] === "string" ? (subscription["id"] as string) : null;
  const customerId =
    typeof subscription["customer"] === "string" ? (subscription["customer"] as string) : null;

  // ── Resolve subscriber: metadata.subscriber_id > stripe_subscription_id > stripe_customer_id.
  let subscriberId: string | null = null;
  let resolvedVia: string | null = null;

  if (metaSubscriberId) {
    const { data } = await supabase
      .from("subscribers")
      .select("id")
      .eq("id", metaSubscriberId)
      .maybeSingle();
    if (data) {
      subscriberId = data.id;
      resolvedVia = "metadata";
    }
  }
  if (!subscriberId && subscriptionId) {
    const { data } = await supabase
      .from("subscribers")
      .select("id")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    if (data) {
      subscriberId = data.id;
      resolvedVia = "subscription_id";
    }
  }
  if (!subscriberId && customerId) {
    const { data } = await supabase
      .from("subscribers")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (data) {
      subscriberId = data.id;
      resolvedVia = "customer_id";
    }
  }

  if (!subscriberId) {
    // Fail loud, but don't 500 — Stripe would retry indefinitely. Logged as an
    // error for manual follow-up; never guessed or silently skipped.
    console.error(
      "stripe-webhook: UNRESOLVED subscriber for customer.subscription.deleted " +
        `(event=${eventId} customer=${customerId} subscription=${subscriptionId} ` +
        `metadata.subscriber_id=${metaSubscriberId})`
    );
    return;
  }

  // ── Idempotency: if this exact event was already reconciled for this
  // subscriber, stop. The downgrade itself is naturally idempotent (same
  // canonical end state), but the cancellation email is NOT — this guard keeps
  // Stripe duplicate deliveries from sending a second email.
  const { data: priorRows } = await supabase
    .from("audit_log")
    .select("payload")
    .eq("subscriber_id", subscriberId)
    .eq("action", "subscription_canceled");

  const alreadyProcessed = (priorRows ?? []).some(
    (row) => (row.payload as { stripe_event_id?: string } | null)?.stripe_event_id === eventId
  );
  if (alreadyProcessed) {
    console.log(`stripe-webhook: event ${eventId} already reconciled for ${subscriberId}, skipping`);
    return;
  }

  // ── Read Free plan entitlements at runtime (don't hardcode the flags inline).
  const { data: freePlan, error: planError } = await supabase
    .from("plans")
    .select(
      "predictive_insights, multi_channel_recovery, api_access, white_label_reports, advanced_negotiation"
    )
    .eq("id", FREE_PLAN_ID)
    .maybeSingle();

  if (planError || !freePlan) {
    console.error(`stripe-webhook: Free plan ${FREE_PLAN_ID} not found`, planError);
    return;
  }

  // Field-name remap: plans.<entitlement> -> subscribers.flag_<entitlement>.
  // Limits (monthly_*_limit) stay sourced from plans; usage counters
  // (*_used_this_month) are intentionally NOT reset on cancel.
  const { error: updateError } = await supabase
    .from("subscribers")
    .update({
      subscription_status: "canceled",
      plan_id: FREE_PLAN_ID,
      flag_predictive_insights: freePlan.predictive_insights,
      flag_multi_channel: freePlan.multi_channel_recovery,
      flag_api_access: freePlan.api_access,
      flag_white_label: freePlan.white_label_reports,
      flag_advanced_negotiation: freePlan.advanced_negotiation,
      stripe_subscription_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriberId);

  if (updateError) {
    console.error("stripe-webhook: subscriber downgrade failed", updateError);
    return;
  }

  // Audit BEFORE sending the email so the idempotency guard is armed even if the
  // email path throws — we never re-run the downgrade-and-email for this event.
  await writeAudit(subscriberId, "subscription_canceled", subscriberId, {
    stripe_event_id: eventId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    downgraded_to_plan: FREE_PLAN_ID,
    resolved_via: resolvedVia,
  });

  // ── Cancellation email. Failure must NOT fail the webhook — log separately.
  const { data: sub } = await supabase
    .from("subscribers")
    .select("email, business_name")
    .eq("id", subscriberId)
    .maybeSingle();

  if (sub?.email) {
    try {
      await sendEmail({
        to: sub.email,
        toName: sub.business_name ?? undefined,
        subject: "Your Clyintel subscription has been canceled",
        text:
          `Hi${sub.business_name ? ` ${sub.business_name}` : ""},\n\n` +
          "Your Clyintel subscription has been canceled and your account has been moved to the Free plan. " +
          "You'll keep access to Free plan features at no charge.\n\n" +
          "If this was a mistake or you'd like to resubscribe, you can upgrade again anytime from your account settings.\n\n" +
          "Thanks,\nThe Clyintel Team",
      });
    } catch (err) {
      console.error(`stripe-webhook: cancellation email failed for ${subscriberId}`, err);
    }
  } else {
    console.error(`stripe-webhook: no email on subscriber ${subscriberId}; cancellation email skipped`);
  }
}

// Capture a successful SUBSCRIPTION payment as a `payments` ledger row. This
// records the platform-billing charge only — it never writes invoice_payments
// (there is no overdue invoice to allocate against; that bridge belongs to the
// recovery flow) and never sets client_id. Idempotent and signature-verified
// (caller verifies). Unresolvable subscriber → fail loud via log, return
// normally so Stripe doesn't retry forever (caller returns 200).
async function handlePaymentSucceeded(
  invoice: Record<string, unknown>,
  eventId: string,
  eventCreated: number | undefined
) {
  const supabase = getSupabase();

  // Subscription metadata rides on the invoice's subscription_details in current
  // API versions; fall back to invoice-level metadata.
  const subscriptionDetails = invoice["subscription_details"] as
    | { metadata?: Record<string, unknown> }
    | undefined;
  const invoiceMetadata = (invoice["metadata"] as Record<string, unknown> | undefined) ?? {};
  const metaFromSub =
    typeof subscriptionDetails?.metadata?.["subscriber_id"] === "string"
      ? (subscriptionDetails.metadata["subscriber_id"] as string)
      : null;
  const metaFromInvoice =
    typeof invoiceMetadata["subscriber_id"] === "string"
      ? (invoiceMetadata["subscriber_id"] as string)
      : null;
  const metaSubscriberId = metaFromSub ?? metaFromInvoice;

  const subscriptionId =
    typeof invoice["subscription"] === "string" ? (invoice["subscription"] as string) : null;
  const customerId =
    typeof invoice["customer"] === "string" ? (invoice["customer"] as string) : null;
  const paymentIntent =
    typeof invoice["payment_intent"] === "string" ? (invoice["payment_intent"] as string) : null;
  const chargeId = typeof invoice["charge"] === "string" ? (invoice["charge"] as string) : null;
  const amountPaid =
    typeof invoice["amount_paid"] === "number" ? (invoice["amount_paid"] as number) : null;
  const currency =
    typeof invoice["currency"] === "string"
      ? (invoice["currency"] as string).toUpperCase()
      : "USD";

  // ── Resolve subscriber: metadata.subscriber_id > stripe_subscription_id > stripe_customer_id.
  let subscriberId: string | null = null;
  let resolvedVia: string | null = null;

  if (metaSubscriberId) {
    const { data } = await supabase
      .from("subscribers")
      .select("id")
      .eq("id", metaSubscriberId)
      .maybeSingle();
    if (data) {
      subscriberId = data.id;
      resolvedVia = "metadata";
    }
  }
  if (!subscriberId && subscriptionId) {
    const { data } = await supabase
      .from("subscribers")
      .select("id")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    if (data) {
      subscriberId = data.id;
      resolvedVia = "subscription_id";
    }
  }
  if (!subscriberId && customerId) {
    const { data } = await supabase
      .from("subscribers")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (data) {
      subscriberId = data.id;
      resolvedVia = "customer_id";
    }
  }

  if (!subscriberId) {
    // Fail loud, but don't 500 — Stripe would retry indefinitely. Never guessed.
    console.error(
      "stripe-webhook: UNRESOLVED subscriber for invoice.payment_succeeded " +
        `(event=${eventId} customer=${customerId} subscription=${subscriptionId} ` +
        `metadata.subscriber_id=${metaSubscriberId})`
    );
    return;
  }

  // A successful payment must carry an amount. A missing amount_paid is a
  // malformed event — log and bail rather than record a bogus $0 row. (A
  // legitimate $0 invoice, e.g. a 100%-off coupon, still passes this guard.)
  if (amountPaid === null) {
    console.error(
      `stripe-webhook: invoice.payment_succeeded missing amount_paid (event=${eventId} subscriber=${subscriberId})`
    );
    return;
  }

  const paidAt = eventCreated
    ? new Date(eventCreated * 1000).toISOString()
    : new Date().toISOString();

  // ── Insert FIRST; idempotency is DB-enforced by the UNIQUE constraint on
  // payments.stripe_event_id. A duplicate Stripe delivery hits 23505 and is
  // treated as already-processed. This avoids any premature-marker failure
  // mode: a failed insert records nothing, so Stripe's retry re-attempts
  // cleanly instead of being blocked.
  const { error: insertError } = await supabase.from("payments").insert({
    subscriber_id: subscriberId,
    client_id: null,
    stripe_payment_intent: paymentIntent,
    stripe_charge_id: chargeId,
    amount_cents: amountPaid,
    currency,
    status: "succeeded",
    payment_method: null,
    paid_at: paidAt,
    stripe_event_id: eventId,
    stripe_event_type: "invoice.payment_succeeded",
    refunded_amount_cents: null,
  });

  if (insertError) {
    // 23505 = unique_violation. The stripe_event_id (or its payment_intent)
    // is already captured → duplicate delivery. Swallow and return cleanly.
    if (insertError.code === "23505") {
      console.log(
        `stripe-webhook: duplicate event, skipping (event=${eventId} subscriber=${subscriberId} constraint=${insertError.message})`
      );
      return;
    }
    // Any other failure: log loudly and return. Nothing was recorded, so
    // Stripe's retry will re-attempt the capture.
    console.error(
      `stripe-webhook: payments insert failed for ${subscriberId} (event=${eventId})`,
      insertError
    );
    return;
  }

  // Audit AFTER a successful insert. No longer the idempotency guard (the DB
  // is). If this write fails, the payment is already captured — log loudly,
  // never roll back the captured row.
  await writeAudit(subscriberId, "payment_recorded", subscriberId, {
    stripe_event_id: eventId,
    subscriber_id: subscriberId,
    amount_cents: amountPaid,
    stripe_payment_intent: paymentIntent,
    resolved_via: resolvedVia,
  });
}

// Format integer cents as a USD dollar string (e.g. 128000 -> "$1,280.00").
function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Reconcile a refunded charge: mark the payments ledger row refunded (full or
// partial) and email the subscriber. Idempotent and signature-verified (caller
// verifies). Unresolvable payments row → fail loud via log, return normally so
// Stripe doesn't retry forever (caller returns 200).
async function handleChargeRefunded(charge: Record<string, unknown>, eventId: string) {
  const supabase = getSupabase();

  const chargeId = typeof charge["id"] === "string" ? (charge["id"] as string) : null;
  const paymentIntent =
    typeof charge["payment_intent"] === "string" ? (charge["payment_intent"] as string) : null;
  const amountRefunded =
    typeof charge["amount_refunded"] === "number" ? (charge["amount_refunded"] as number) : null;
  const pmDetails = charge["payment_method_details"] as { card?: { last4?: unknown } } | undefined;
  const last4 = typeof pmDetails?.card?.last4 === "string" ? (pmDetails.card.last4 as string) : null;

  // ── Resolve the payments row: stripe_payment_intent FIRST (the backfill row
  // has stripe_charge_id NULL), then fall back to stripe_charge_id.
  let payment: { id: string; subscriber_id: string } | null = null;

  if (paymentIntent) {
    const { data } = await supabase
      .from("payments")
      .select("id, subscriber_id")
      .eq("stripe_payment_intent", paymentIntent)
      .maybeSingle();
    if (data) payment = data;
  }
  if (!payment && chargeId) {
    const { data } = await supabase
      .from("payments")
      .select("id, subscriber_id")
      .eq("stripe_charge_id", chargeId)
      .maybeSingle();
    if (data) payment = data;
  }

  if (!payment) {
    // Fail loud, but don't 500 — Stripe would retry indefinitely. Never guessed.
    console.error(
      "stripe-webhook: UNRESOLVED payments row for charge.refunded " +
        `(event=${eventId} payment_intent=${paymentIntent} charge=${chargeId})`
    );
    return;
  }

  if (amountRefunded === null) {
    console.error(
      `stripe-webhook: charge.refunded missing amount_refunded (event=${eventId} payment=${payment.id})`
    );
    return;
  }

  // ── Idempotency: skip if this exact refund event was already processed for
  // this subscriber. A partial-then-full refund yields two DISTINCT events on
  // the same row (both must update); the event-id guard only blocks re-processing
  // the SAME event, so we don't rely on a payments-row uniqueness here.
  const { data: priorRows } = await supabase
    .from("audit_log")
    .select("payload")
    .eq("subscriber_id", payment.subscriber_id)
    .eq("action", "refund_processed");

  const alreadyProcessed = (priorRows ?? []).some(
    (row) => (row.payload as { stripe_event_id?: string } | null)?.stripe_event_id === eventId
  );
  if (alreadyProcessed) {
    console.log(`stripe-webhook: refund event ${eventId} already processed for ${payment.subscriber_id}, skipping`);
    return;
  }

  // ── Update the ledger row. A partial refund still sets status='refunded'
  // (there is no partial enum) — refunded_amount_cents vs amount_cents carries
  // the full-vs-partial distinction (derived later). Opportunistically backfill
  // stripe_charge_id when the row was created without it.
  const { error: updateError } = await supabase
    .from("payments")
    .update({
      status: "refunded",
      refunded_amount_cents: amountRefunded,
      stripe_charge_id: chargeId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payment.id);

  if (updateError) {
    console.error(
      `stripe-webhook: payments refund update failed for ${payment.id} (event=${eventId})`,
      updateError
    );
    return;
  }

  // Audit BEFORE email so the idempotency guard is armed even if email throws.
  await writeAudit(payment.subscriber_id, "refund_processed", payment.id, {
    stripe_event_id: eventId,
    subscriber_id: payment.subscriber_id,
    payments_id: payment.id,
    amount_refunded: amountRefunded,
    stripe_payment_intent: paymentIntent,
  });

  // ── Refund email. Failure must NOT fail the webhook — log separately. Amount
  // comes from amount_refunded so the copy reads correctly for full or partial
  // with no branching; the card clause degrades gracefully if last4 is absent.
  const { data: sub } = await supabase
    .from("subscribers")
    .select("email, contact_name")
    .eq("id", payment.subscriber_id)
    .maybeSingle();

  if (sub?.email) {
    const greeting = sub.contact_name ? ` ${sub.contact_name}` : "";
    const cardClause = last4 ? ` to your card ending ${last4}` : "";
    try {
      await sendEmail({
        to: sub.email,
        toName: sub.contact_name ?? undefined,
        subject: "Your Clyintel refund has been processed",
        text:
          `Hi${greeting},\n\n` +
          `We've refunded ${formatDollars(amountRefunded)}${cardClause}. ` +
          "You should see the amount returned to your original payment method within 5–10 business days.\n\n" +
          "Thanks,\nThe Clyintel Team",
      });
    } catch (err) {
      console.error(`stripe-webhook: refund email failed for ${payment.subscriber_id}`, err);
    }
  } else {
    console.error(`stripe-webhook: no email on subscriber ${payment.subscriber_id}; refund email skipped`);
  }
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
      await handleSubscriptionDeleted(object, event.id);
      break;
    }
    case "invoice.payment_succeeded": {
      // Capture the subscription payment into the payments ledger. (Subscription
      // status is reconciled separately by customer.subscription.created/updated,
      // which fire alongside renewals and past_due->active recovery.)
      await handlePaymentSucceeded(object, event.id, event.created);
      break;
    }
    case "invoice.payment_failed": {
      const customerId = object["customer"] as string;
      if (customerId) {
        await updateSubscriberStatus(customerId, "past_due", null, event.type, event.id);
      }
      break;
    }
    case "charge.refunded": {
      await handleChargeRefunded(object, event.id);
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
