import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";

// ⚠️ D2 PHASE 2a TEST-ONLY DIAGNOSTIC ROUTE — delete at Phase 2a close-out. ⚠️
//
// READ-ONLY Stripe grounding for the on_behalf_of proof (Step 3). Given a
// PaymentIntent id, it retrieves the PI → its charge → the platform AND connected
// balance transactions, and reports the balance-transaction `type` + fee_details
// on each side so we can see WHERE the Stripe processing fee (fee_details.type =
// 'stripe_fee') settles: platform BT = old/bad behavior; connected BT = correct
// (subscriber bears it). It also reports the application_fee and the computed
// net-to-subscriber.
//
// STRICTLY READS ONLY — GET requests to the Stripe API. No reflectPayment(), no
// QBO writeback, no Stripe mutation, no DB writes. The Stripe key is read at call
// time and never returned/logged.
//
// Auth: cookie-bound Supabase session (user.id IS the subscriber id). Node
// runtime; never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRIPE_API = "https://api.stripe.com/v1";

/** Raw authenticated Stripe GET. Optional Stripe-Account header for connected-
 *  account context. Key read at call time; never returned/logged. */
async function stripeGet(
  path: string,
  query: Record<string, string[] | string> = {},
  stripeAccount?: string,
): Promise<Record<string, unknown>> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach((x, i) => parts.push(`${k}[${i}]=${encodeURIComponent(x)}`));
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const url = parts.length ? `${STRIPE_API}${path}?${parts.join("&")}` : `${STRIPE_API}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
  const res = await fetch(url, { headers });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = json.error as { message?: string } | undefined;
    throw new Error(err?.message ?? `Stripe GET ${path} failed (${res.status})`);
  }
  return json;
}

interface FeeDetail {
  type?: string;
  amount?: number;
}

/** Reduce a Stripe balance_transaction to the fields the proof needs (verbatim
 *  type + fee_details), plus the fee/net scalars. */
function summarizeBt(bt: Record<string, unknown> | null | undefined) {
  if (!bt || typeof bt !== "object") return null;
  const feeDetails = (bt.fee_details as FeeDetail[] | undefined) ?? [];
  return {
    id: (bt.id as string) ?? null,
    type: (bt.type as string) ?? null, // e.g. 'charge'
    currency: (bt.currency as string) ?? null,
    amount: (bt.amount as number | null) ?? null,
    fee: (bt.fee as number | null) ?? null,
    net: (bt.net as number | null) ?? null,
    // Verbatim breakdown — the entry with type 'stripe_fee' is the processing fee.
    fee_details: feeDetails.map((d) => ({ type: d.type ?? null, amount: d.amount ?? null })),
  };
}

/** Sum of fee_details entries whose type is 'stripe_fee'. */
function stripeFeeCents(bt: ReturnType<typeof summarizeBt>): number {
  if (!bt) return 0;
  return bt.fee_details
    .filter((d) => d.type === "stripe_fee")
    .reduce((s, d) => s + (d.amount ?? 0), 0);
}

async function connectedStripeAccount(subscriberId: string): Promise<string | null> {
  const service = getSupabase();
  const { data } = await service
    .from("payout_accounts")
    .select("provider_account_id")
    .eq("subscriber_id", subscriberId)
    .eq("provider", "stripe")
    .maybeSingle();
  return (data?.provider_account_id as string | undefined) ?? null;
}

export async function POST(request: Request) {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const subscriberId = user.id;

  // PI id from JSON body { pi } or ?pi= query param.
  let pi: string | undefined;
  try {
    pi = ((await request.json()) as { pi?: string }).pi;
  } catch {
    /* no body */
  }
  pi = pi ?? new URL(request.url).searchParams.get("pi") ?? undefined;
  if (!pi) {
    return NextResponse.json({ error: "Missing PaymentIntent id (body { pi } or ?pi=)" }, { status: 400 });
  }

  try {
    const connectedAccount = await connectedStripeAccount(subscriberId);

    // Platform side: PI → latest_charge → balance_transaction + transfer.
    const intent = await stripeGet(`/payment_intents/${pi}`, {
      expand: ["latest_charge", "latest_charge.balance_transaction", "latest_charge.transfer"],
    });
    const charge = intent.latest_charge as Record<string, unknown> | undefined;
    const platformBt = summarizeBt(charge?.balance_transaction as Record<string, unknown> | undefined);
    const transfer = charge?.transfer as Record<string, unknown> | undefined;
    const destinationPayment = (transfer?.destination_payment as string | undefined) ?? null;
    const applicationFeeAmount = (charge?.application_fee_amount as number | null) ?? null;
    const onBehalfOf = (charge?.on_behalf_of as string | null) ?? null;
    const amountCents = (charge?.amount as number | null) ?? null;

    // Connected side: the destination payment's balance_transaction, read WITH
    // connected-account context (this is where the fee lands under on_behalf_of).
    let connectedBt: ReturnType<typeof summarizeBt> = null;
    let connectedError: string | null = null;
    if (connectedAccount && destinationPayment) {
      try {
        const connCharge = await stripeGet(
          `/charges/${destinationPayment}`,
          { expand: ["balance_transaction"] },
          connectedAccount,
        );
        connectedBt = summarizeBt(connCharge.balance_transaction as Record<string, unknown> | undefined);
      } catch (e) {
        connectedError = e instanceof Error ? e.message : String(e);
      }
    }

    // Which side carries the stripe_fee (fee_details.type === 'stripe_fee').
    const platformStripeFee = stripeFeeCents(platformBt);
    const connectedStripeFee = stripeFeeCents(connectedBt);
    const stripeFeeSide =
      connectedStripeFee > 0 ? "connected" : platformStripeFee > 0 ? "platform" : "none";
    const stripeFeeTotalCents = connectedStripeFee || platformStripeFee || 0;

    // Net to the subscriber = face − application_fee − stripe_fee.
    const netToSubscriberCents =
      amountCents != null && applicationFeeAmount != null
        ? amountCents - applicationFeeAmount - stripeFeeTotalCents
        : null;

    return NextResponse.json({
      paymentIntent: pi,
      chargeId: (charge?.id as string) ?? null,
      onBehalfOf, // expect the connected account (NOT null) on the corrected charge
      connectedAccount,
      amountCents,
      applicationFeeAmount, // rev-share fee → platform (expect 85800)
      // The three balance-transaction lines the proof reports:
      platformBalanceTxn: platformBt, // type + fee_details (should NOT carry stripe_fee once fixed)
      connectedBalanceTxn: connectedBt, // type + fee_details (SHOULD carry stripe_fee)
      connectedError,
      stripeFeeSide, // 'connected' (correct) | 'platform' (old/bad) | 'none'
      stripeFeeTotalCents,
      netToSubscriberCents, // expect ~292860 ($2,928.60) for the $3,900 fixture
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
}
