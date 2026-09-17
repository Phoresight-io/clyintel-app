import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import crypto from "crypto";
import { getSupabase } from "@/lib/supabase";
import { sendEmail } from "@/lib/email";
import { handleRecoveryCheckoutCompleted } from "@/lib/recovery/handleCheckoutCompleted";

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

// ── Fee-settlement invoice reconciliation (Monthly Settlement Sweep, Prompt 5) ─
// Settlement invoices are tagged at creation (lib/settlement/chargeSettlement.ts →
// createInvoice metadata: kind='fee_settlement', settlement_id, subscriber_id,
// cycle_close). These handlers move fee_settlements between terminal states from
// the async Stripe outcome WITHOUT touching subscription state or the payments
// ledger. Service-role client (fee_settlements is service-role-write, RLS forced).
//
// Idempotency: the terminal-state guard (`status not in (paid, void)`) makes
// whichever of the synchronous charge path and this webhook lands first win — no
// transition out of a terminal state. The audit_log dedup (same pattern the
// subscription/refund handlers use) makes a redelivered Stripe event a no-op.

export function isFeeSettlementInvoice(object: Record<string, unknown>): boolean {
  const meta = object["metadata"] as Record<string, unknown> | undefined;
  return meta?.["kind"] === "fee_settlement";
}

function settlementIdFromInvoice(object: Record<string, unknown>): string | null {
  const meta = (object["metadata"] as Record<string, unknown> | undefined) ?? {};
  return typeof meta["settlement_id"] === "string" ? (meta["settlement_id"] as string) : null;
}

async function settlementEventAlreadyReconciled(
  supabase: ReturnType<typeof getSupabase>,
  subscriberId: string,
  action: string,
  eventId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("audit_log")
    .select("payload")
    .eq("subscriber_id", subscriberId)
    .eq("action", action);
  return (data ?? []).some(
    (row) => (row.payload as { stripe_event_id?: string } | null)?.stripe_event_id === eventId
  );
}

export async function handleSettlementInvoicePaid(object: Record<string, unknown>, eventId: string) {
  const supabase = getSupabase();
  const settlementId = settlementIdFromInvoice(object);
  const invoiceId = typeof object["id"] === "string" ? (object["id"] as string) : null;
  if (!settlementId) {
    console.error(`stripe-webhook: fee_settlement paid missing settlement_id (event=${eventId})`);
    return;
  }

  const { data: settlement } = await supabase
    .from("fee_settlements")
    .select("id, subscriber_id, status")
    .eq("id", settlementId)
    .maybeSingle();
  if (!settlement) {
    console.error(`stripe-webhook: settlement ${settlementId} not found (event=${eventId})`);
    return;
  }

  if (await settlementEventAlreadyReconciled(supabase, settlement.subscriber_id, "settlement_invoice_paid", eventId)) {
    console.log(`stripe-webhook: settlement paid event ${eventId} already reconciled (${settlementId}), skipping`);
    return;
  }

  // Terminal write, guarded: never move out of paid/void. Also rescues the
  // crash-between-finalize-and-write row by filling a NULL stripe_invoice_id.
  const { data: updated, error } = await supabase
    .from("fee_settlements")
    .update({ status: "paid", stripe_invoice_id: invoiceId, last_error: null })
    .eq("id", settlementId)
    .not("status", "in", "(paid,void)")
    .select("id");
  if (error) {
    console.error(`stripe-webhook: settlement paid update failed (${settlementId}, event=${eventId})`, error);
    return;
  }

  await writeAudit(settlement.subscriber_id, "settlement_invoice_paid", settlementId, {
    stripe_event_id: eventId,
    settlement_id: settlementId,
    stripe_invoice_id: invoiceId,
    applied: (updated ?? []).length > 0,
  });
}

export async function handleSettlementInvoiceFailed(object: Record<string, unknown>, eventId: string) {
  const supabase = getSupabase();
  const settlementId = settlementIdFromInvoice(object);
  const invoiceId = typeof object["id"] === "string" ? (object["id"] as string) : null;
  if (!settlementId) {
    console.error(`stripe-webhook: fee_settlement failed missing settlement_id (event=${eventId})`);
    return;
  }

  const { data: settlement } = await supabase
    .from("fee_settlements")
    .select("id, subscriber_id, status, attempts")
    .eq("id", settlementId)
    .maybeSingle();
  if (!settlement) {
    console.error(`stripe-webhook: settlement ${settlementId} not found (event=${eventId})`);
    return;
  }

  if (await settlementEventAlreadyReconciled(supabase, settlement.subscriber_id, "settlement_invoice_failed", eventId)) {
    console.log(`stripe-webhook: settlement failed event ${eventId} already reconciled (${settlementId}), skipping`);
    return;
  }

  // Guarded: never override a paid/void row (the synchronous path may have won).
  const { data: updated, error } = await supabase
    .from("fee_settlements")
    .update({
      status: "failed",
      stripe_invoice_id: invoiceId,
      last_error: "webhook_payment_failed",
    })
    .eq("id", settlementId)
    .not("status", "in", "(paid,void)")
    .select("id");
  if (error) {
    console.error(`stripe-webhook: settlement failed update errored (${settlementId}, event=${eventId})`, error);
    return;
  }

  await writeAudit(settlement.subscriber_id, "settlement_invoice_failed", settlementId, {
    stripe_event_id: eventId,
    settlement_id: settlementId,
    stripe_invoice_id: invoiceId,
    applied: (updated ?? []).length > 0,
  });
}

// ── Fee-settlement REFUND reconciliation (Part B, refund webhook) ─────────────
// A refund of a settlement charge carries NO fee_settlement metadata on the
// charge/refund object (refundSettlement sends none), so — unlike invoice events —
// these are matched by fee_settlement_refunds.stripe_refund_id (the id
// refundSettlement captured on the row). This webhook OWNS ONLY the ASYNC terminal
// transition of a refund that was created 'pending' (settlement 'refund_pending').
// Sync succeeded/void already settled inline. A NULL stripe_refund_id row (Prompt 3
// crashed before capturing the id) finds no match here and is completed by
// refundSettlement's RESUME path — NOT by an invoice-hop fallback.
//
// POSITIVE per-transition guard (`.eq("status","refund_pending")`) — NOT the charge
// path's `.not(paid,void)`: succeeded→refunded and failed→paid fire ONLY from
// refund_pending, so a replay or a late event on an already-terminal settlement
// matches 0 rows and no-ops. Returns whether a settlement refund row matched (so
// the charge.refunded caller knows whether to fall through to the payments rail).
export async function handleSettlementRefundEvent(
  refundId: string,
  stripeStatus: string,
  eventId: string
): Promise<boolean> {
  const supabase = getSupabase();

  const { data: refundRow } = await supabase
    .from("fee_settlement_refunds")
    .select("id, settlement_id, status")
    .eq("stripe_refund_id", refundId)
    .maybeSingle();
  if (!refundRow) return false; // not a settlement refund → caller may fall through

  const isSucceeded = stripeStatus === "succeeded";
  const isFailed = stripeStatus === "failed" || stripeStatus === "canceled";
  if (!isSucceeded && !isFailed) return true; // non-terminal (pending/requires_action) → nothing to settle yet

  const settlementId = refundRow.settlement_id as string;
  const { data: settlement } = await supabase
    .from("fee_settlements")
    .select("id, subscriber_id, status")
    .eq("id", settlementId)
    .maybeSingle();
  if (!settlement) {
    console.error(`stripe-webhook: settlement ${settlementId} not found for refund ${refundId} (event=${eventId})`);
    return true;
  }

  const action = isSucceeded ? "settlement_refund_succeeded" : "settlement_refund_failed";
  if (await settlementEventAlreadyReconciled(supabase, settlement.subscriber_id, action, eventId)) {
    console.log(`stripe-webhook: ${action} event ${eventId} already reconciled (${settlementId}), skipping`);
    return true;
  }

  // Settle the settlement FIRST (the positive guard is the authority); a
  // 'failed'/'canceled' refund frees the reservation (over-refund guard excludes
  // 'failed' rows). Move the refund row only when the settlement actually transitioned.
  const next = isSucceeded
    ? { status: "refunded", last_error: null }
    : { status: "paid", last_error: "webhook_refund_failed" };
  const { data: updated, error } = await supabase
    .from("fee_settlements")
    .update(next)
    .eq("id", settlementId)
    .eq("status", "refund_pending")
    .select("id");
  if (error) {
    console.error(`stripe-webhook: ${action} settlement update failed (${settlementId}, event=${eventId})`, error);
    return true;
  }
  const applied = (updated ?? []).length > 0;
  if (applied) {
    await supabase
      .from("fee_settlement_refunds")
      .update({ status: isSucceeded ? "succeeded" : "failed" })
      .eq("id", refundRow.id);
  }

  await writeAudit(settlement.subscriber_id, action, settlementId, {
    stripe_event_id: eventId,
    refund_id: refundId,
    settlement_id: settlementId,
    applied,
  });
  return true;
}

// invoice.voided rescue: refundSettlement claims the settlement into 'refund_pending'
// before voiding (GD1), so a crash after Stripe voided the invoice but before the
// terminal write leaves the settlement 'refund_pending' with a 'pending' kind='void'
// row. Positive guard fires ONLY from 'refund_pending' → 'void'; an already-'void'
// settlement matches 0 rows (no-op). This closes the POST-Stripe void crash window
// only; the PRE-Stripe one is Prompt 5's resume item.
export async function handleSettlementInvoiceVoided(object: Record<string, unknown>, eventId: string) {
  const supabase = getSupabase();
  const settlementId = settlementIdFromInvoice(object);
  if (!settlementId) {
    console.error(`stripe-webhook: fee_settlement voided missing settlement_id (event=${eventId})`);
    return;
  }
  const { data: settlement } = await supabase
    .from("fee_settlements")
    .select("id, subscriber_id, status")
    .eq("id", settlementId)
    .maybeSingle();
  if (!settlement) {
    console.error(`stripe-webhook: settlement ${settlementId} not found (event=${eventId})`);
    return;
  }
  if (await settlementEventAlreadyReconciled(supabase, settlement.subscriber_id, "settlement_void_reconciled", eventId)) {
    console.log(`stripe-webhook: settlement voided event ${eventId} already reconciled (${settlementId}), skipping`);
    return;
  }

  const { data: updated, error } = await supabase
    .from("fee_settlements")
    .update({ status: "void", last_error: null })
    .eq("id", settlementId)
    .eq("status", "refund_pending")
    .select("id");
  if (error) {
    console.error(`stripe-webhook: settlement voided update failed (${settlementId}, event=${eventId})`, error);
    return;
  }
  const applied = (updated ?? []).length > 0;
  if (applied) {
    // The in-flight kind='void' refund row → succeeded (a void has no refund id).
    await supabase
      .from("fee_settlement_refunds")
      .update({ status: "succeeded" })
      .eq("settlement_id", settlementId)
      .eq("kind", "void")
      .eq("status", "pending");
  }
  await writeAudit(settlement.subscriber_id, "settlement_void_reconciled", settlementId, {
    stripe_event_id: eventId,
    settlement_id: settlementId,
    applied,
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
      await handleSubscriptionDeleted(object, event.id);
      break;
    }
    case "invoice.payment_succeeded": {
      // Fee-settlement invoices (tagged metadata.kind='fee_settlement' at creation)
      // reconcile to fee_settlements — NOT the subscription payments ledger, and
      // NOT via the stripe_customer_id fallback in handlePaymentSucceeded.
      if (isFeeSettlementInvoice(object)) {
        await handleSettlementInvoicePaid(object, event.id);
        break;
      }
      // Capture the subscription payment into the payments ledger. (Subscription
      // status is reconciled separately by customer.subscription.created/updated,
      // which fire alongside renewals and past_due->active recovery.)
      await handlePaymentSucceeded(object, event.id, event.created);
      break;
    }
    case "invoice.payment_failed": {
      // Fee-settlement invoices reconcile to fee_settlements and must NOT flip the
      // subscriber to past_due.
      if (isFeeSettlementInvoice(object)) {
        await handleSettlementInvoiceFailed(object, event.id);
        break;
      }
      const customerId = object["customer"] as string;
      if (customerId) {
        await updateSubscriberStatus(customerId, "past_due", null, event.type, event.id);
      }
      break;
    }
    case "charge.refunded": {
      // Settlement-first: a refund of a fee-settlement charge carries no
      // fee_settlement metadata, so match each refund by
      // fee_settlement_refunds.stripe_refund_id. If any matches, settle it and do
      // NOT run the subscription-payments handler (whose behavior is unchanged for
      // non-settlement charges — this stops settlement charges logging "UNRESOLVED
      // payments row").
      const refundList = ((object["refunds"] as { data?: unknown[] } | undefined)?.data) ?? [];
      let matchedSettlement = false;
      for (const r of refundList) {
        const rr = r as { id?: unknown; status?: unknown };
        if (typeof rr.id !== "string") continue;
        const rstatus = typeof rr.status === "string" ? rr.status : "succeeded";
        if (await handleSettlementRefundEvent(rr.id, rstatus, event.id)) matchedSettlement = true;
      }
      if (matchedSettlement) break;
      await handleChargeRefunded(object, event.id);
      break;
    }
    case "refund.updated": {
      // PRIMARY async settle for a fee-settlement refund. object = the Refund.
      const refundId = typeof object["id"] === "string" ? (object["id"] as string) : null;
      const rstatus = typeof object["status"] === "string" ? (object["status"] as string) : null;
      if (refundId && rstatus) await handleSettlementRefundEvent(refundId, rstatus, event.id);
      break;
    }
    case "invoice.voided": {
      // Rescue the post-Stripe void crash for a fee-settlement invoice. Non-
      // settlement invoice.voided has no existing behavior (acknowledged + ignored).
      if (isFeeSettlementInvoice(object)) {
        await handleSettlementInvoiceVoided(object, event.id);
      }
      break;
    }
    case "checkout.session.completed": {
      // Recovery-payment capture bridge. Only sessions that match a recovery_links
      // row are acted on; subscription/other sessions fall through as a no-op.
      await handleRecoveryCheckoutCompleted(object, event.id, event.created);
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
