import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { reflectPayment } from "@/lib/ledgerSync/reflectPayment";
import { getValidAccessToken } from "@/lib/qbo/tokens";
import { getInvoice } from "@/lib/qbo/client";
import { qboApiBaseUrl } from "@/lib/qbo/constants";

// ⚠️ D2 PHASE 1 TEST-ONLY DIAGNOSTIC ROUTE — safe to delete at D2 close-out. ⚠️
// (Same cleanup bucket as /api/ledgersync/test-reflect.)
//
// Drives STEP 3's three smoke cases against the LIVE QBO SANDBOX so they can be
// verified without a cookie-session dependency beyond the caller's own login.
// Returns raw state (invoice balance before/after, ledger_sync row, QBO Payment
// Id) rather than a pass/fail so the operator reads each transition directly.
//
// Auth: cookie-bound Supabase session (same guard as every privileged route).
// user.id IS the subscriber id — log in as the TEST subscriber
// (34205047-14e3-45bb-80e2-2fb8da2da910) so the fixture lines up.
//
// POST body: { action?: 'happy' | 'cap' | 'inspect', externalInvoiceId?,
//              sourcePaymentId?, ledgerRowId?, amountPaidCents? }
//   - 'happy'   : reflect the real fixture (invoice 145). Run it TWICE — the 2nd
//                 call is the retry/idempotency case (no 2nd QBO Payment).
//   - 'cap'     : seed a throwaway ledger_sync row with max_attempts=1, force one
//                 failure (→ 'dead'), then invoke again (→ short-circuit skip).
//   - 'inspect' : read-only — invoice balance + ledger_sync row, no reflect.
//   - 'ground-stripe-fee'   : READ-ONLY (Phase 2 STEP-1) — dump the charge's
//                 balance_transaction fee + fee_details[] on both platform and
//                 connected-account sides; books nothing.
//   - 'ground-qbo-accounts' : READ-ONLY (Phase 2 STEP-1) — dump the sandbox
//                 chart of accounts + a deliberately-failing Purchase probe to
//                 confirm the 'purchase' entityPath; books nothing.
//
// Node runtime (token decryption); never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Real D2 fixture defaults (invoice 145 / 1038, the already-written ledger row).
const DEFAULTS = {
  externalInvoiceId: "145",
  sourcePaymentId: "pi_3U0YL6P2aVnfVhOw1oiSutI0",
  ledgerRowId: "ac290e77-2c90-4e55-b3fe-504e03d38dea",
  amountPaidCents: 390000,
};
const PROVIDER = "quickbooks";
const CAP_SOURCE_PAYMENT_ID = "phase1-cap-test";
const CAP_BOGUS_INVOICE = "9999999"; // non-existent → forces a reflect failure

async function readInvoice(subscriberId: string, externalInvoiceId: string) {
  try {
    const { accessToken, realmId } = await getValidAccessToken(subscriberId);
    const inv = await getInvoice(realmId, externalInvoiceId, accessToken);
    return { id: inv.Id, totalAmt: inv.TotalAmt, balance: inv.Balance ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function readLedgerSync(sourcePaymentId: string) {
  const service = getSupabase();
  const { data } = await service
    .from("ledger_sync")
    .select("*")
    .eq("source_payment_id", sourcePaymentId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  return data;
}

// ── D2 Phase 2 STEP-1 grounding helpers (READ-ONLY) ─────────────────────────
// These do NOT write books. They exist so the two §1 unknowns (Stripe fee shape
// + QBO chart-of-accounts / Purchase entityPath) can be observed against the
// LIVE sandbox from a logged-in session, then reported verbatim before any
// migration/adapter is built. Deleted at D2 close-out with the rest of the route.

const STRIPE_API = "https://api.stripe.com/v1";

/** Raw authenticated Stripe GET. Optional Stripe-Account header for connected-
 *  account context (destination-charge fee lives on the connected acct). The
 *  key is read at call time and NEVER returned/logged. */
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

/** The connected Stripe account (acct_…) for the subscriber, from payout_accounts. */
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

/** Reduce a Stripe balance_transaction to the fields the reconciliation needs. */
function summarizeBalanceTxn(bt: Record<string, unknown> | null | undefined) {
  if (!bt || typeof bt !== "object") return null;
  return {
    id: bt.id ?? null,
    currency: bt.currency ?? null,
    amount: bt.amount ?? null,
    fee: bt.fee ?? null,
    net: bt.net ?? null,
    fee_details: bt.fee_details ?? null, // VERBATIM — the shape we must ground
  };
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

  let body: {
    action?: string;
    externalInvoiceId?: string;
    sourcePaymentId?: string;
    ledgerRowId?: string;
    amountPaidCents?: number;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // bare POST → defaults ('happy')
  }
  const action = body.action ?? "happy";

  // ── inspect: read-only state dump ─────────────────────────────────────────
  if (action === "inspect") {
    const externalInvoiceId = body.externalInvoiceId ?? DEFAULTS.externalInvoiceId;
    const sourcePaymentId = body.sourcePaymentId ?? DEFAULTS.sourcePaymentId;
    return NextResponse.json({
      action,
      invoice: await readInvoice(subscriberId, externalInvoiceId),
      ledgerSync: await readLedgerSync(sourcePaymentId),
    });
  }

  // ── ground-stripe-fee: READ-ONLY. Observe the charge's balance_transaction
  //    fee + fee_details[] on BOTH the platform side and the connected-account
  //    side (destination charge), so we can see which carries the real fee and
  //    which LOCKED-DECISION-5 case (native split vs single combined) we hit. ──
  if (action === "ground-stripe-fee") {
    const sourcePaymentId = body.sourcePaymentId ?? DEFAULTS.sourcePaymentId;
    try {
      const connectedAccount = await connectedStripeAccount(subscriberId);

      // Platform side: PI → latest_charge → balance_transaction + transfer.
      const pi = await stripeGet(`/payment_intents/${sourcePaymentId}`, {
        expand: [
          "latest_charge",
          "latest_charge.balance_transaction",
          "latest_charge.transfer",
        ],
      });
      const charge = pi.latest_charge as Record<string, unknown> | undefined;
      const platformBt = summarizeBalanceTxn(
        charge?.balance_transaction as Record<string, unknown> | undefined,
      );
      const transfer = charge?.transfer as Record<string, unknown> | undefined;
      const destinationPayment =
        (transfer?.destination_payment as string | undefined) ?? null;

      // Connected-account side: read the destination payment's balance_transaction
      // WITH Stripe-Account context (this is where the fee lives if on_behalf_of
      // / settlement is the connected acct).
      let connectedBt: ReturnType<typeof summarizeBalanceTxn> = null;
      let connectedError: string | null = null;
      if (connectedAccount && destinationPayment) {
        try {
          const connCharge = await stripeGet(
            `/charges/${destinationPayment}`,
            { expand: ["balance_transaction"] },
            connectedAccount,
          );
          connectedBt = summarizeBalanceTxn(
            connCharge.balance_transaction as Record<string, unknown> | undefined,
          );
        } catch (e) {
          connectedError = e instanceof Error ? e.message : String(e);
        }
      }

      // Which side carries a non-zero fee → the one we read for the adapter.
      const platformFee = (platformBt?.fee as number | null) ?? null;
      const connectedFee = (connectedBt?.fee as number | null) ?? null;
      const feeSide =
        connectedFee && connectedFee !== 0
          ? "connected"
          : platformFee && platformFee !== 0
            ? "platform"
            : "none";
      const chosen = feeSide === "connected" ? connectedBt : platformBt;
      const details = (chosen?.fee_details as unknown[] | null) ?? null;
      const feeCase =
        !details || details.length === 0
          ? "no-fee-details"
          : details.length === 1
            ? "single-combined (LOCKED DECISION 5 → derive the split)"
            : "multi-line (native split)";
      const zeroFeeFlag =
        feeSide === "none"
          ? "⚠ FEE IS 0/NULL ON BOTH SIDES — STOP: reconciliation needs a real non-zero fee (LOCKED DECISION, do not invent)."
          : null;

      return NextResponse.json({
        action,
        sourcePaymentId,
        connectedAccount,
        charge: {
          id: charge?.id ?? null,
          amount: charge?.amount ?? null,
          currency: charge?.currency ?? null,
          application_fee_amount: charge?.application_fee_amount ?? null,
          on_behalf_of: charge?.on_behalf_of ?? null,
        },
        transfer: transfer
          ? {
              id: transfer.id ?? null,
              amount: transfer.amount ?? null,
              destination: transfer.destination ?? null,
              destination_payment: destinationPayment,
            }
          : null,
        platformBalanceTxn: platformBt,
        connectedBalanceTxn: connectedBt,
        connectedError,
        feeSide, // 'connected' | 'platform' | 'none'
        feeCase, // native split vs single-combined vs none
        zeroFeeFlag,
      });
    } catch (err) {
      return NextResponse.json(
        { action, error: err instanceof Error ? err.message : String(err) },
        { status: 200 },
      );
    }
  }

  // ── ground-qbo-accounts: READ-ONLY (+ a deliberately-failing Purchase probe).
  //    GET the sandbox chart of accounts so we can map the three fee lines +
  //    funding account to EXISTING accounts (path A), and confirm the Purchase
  //    entityPath by POSTing an empty body and reading the validation error (no
  //    Purchase is booked — the probe is designed to 4xx). ──
  if (action === "ground-qbo-accounts") {
    try {
      const { accessToken, realmId } = await getValidAccessToken(subscriberId);

      // Chart of accounts via the QBO query API.
      const q = encodeURIComponent(
        "SELECT Id, Name, AccountType, AccountSubType, Classification, Active FROM Account MAXRESULTS 500",
      );
      const acctRes = await fetch(
        `${qboApiBaseUrl()}/v3/company/${realmId}/query?query=${q}`,
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
      );
      const acctJson = (await acctRes.json()) as {
        QueryResponse?: { Account?: Array<Record<string, unknown>> };
      };
      const accounts = (acctJson.QueryResponse?.Account ?? []).map((a) => ({
        Id: a.Id,
        Name: a.Name,
        AccountType: a.AccountType,
        AccountSubType: a.AccountSubType,
        Classification: a.Classification,
        Active: a.Active,
      }));
      const expenseAccounts = accounts.filter((a) => a.AccountType === "Expense");
      const bankAccounts = accounts.filter(
        (a) => a.AccountType === "Bank" || a.AccountType === "Other Current Asset",
      );

      // Purchase entityPath probe: POST an empty body; QBO should 4xx with a
      // required-fields error, confirming the route accepts POST without booking
      // anything.
      const probeRes = await fetch(
        `${qboApiBaseUrl()}/v3/company/${realmId}/purchase`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      const probeText = await probeRes.text();

      return NextResponse.json({
        action,
        realmId,
        accountCount: accounts.length,
        expenseAccounts,
        bankAccounts,
        allAccounts: accounts,
        purchaseProbe: {
          entityPath: "purchase",
          httpStatus: probeRes.status, // expect 4xx (empty body) → confirms path, books nothing
          body: probeText.slice(0, 2000),
        },
      });
    } catch (err) {
      return NextResponse.json(
        { action, error: err instanceof Error ? err.message : String(err) },
        { status: 200 },
      );
    }
  }

  // ── cap → dead: seed max_attempts=1, force a failure, prove terminal skip ──
  if (action === "cap") {
    const service = getSupabase();
    const ledgerRowId = body.ledgerRowId ?? DEFAULTS.ledgerRowId;

    // Fresh throwaway fixture row (delete any prior run, seed max_attempts=1).
    await service
      .from("ledger_sync")
      .delete()
      .eq("source_payment_id", CAP_SOURCE_PAYMENT_ID)
      .eq("provider", PROVIDER);
    const { error: seedErr } = await service.from("ledger_sync").insert({
      ledger_row_id: ledgerRowId,
      source_payment_id: CAP_SOURCE_PAYMENT_ID,
      provider: PROVIDER,
      status: "pending",
      attempts: 0,
      max_attempts: 1,
    });
    if (seedErr) {
      return NextResponse.json({ action, error: `seed failed: ${seedErr.message}` }, { status: 200 });
    }

    const capInput = {
      subscriberId,
      provider: PROVIDER,
      externalInvoiceId: CAP_BOGUS_INVOICE, // forces the attempt to fail
      amountPaidCents: DEFAULTS.amountPaidCents,
      currency: "USD",
      capturePaymentId: CAP_SOURCE_PAYMENT_ID,
      ledgerRowId,
    };

    const firstResult = await reflectPayment(capInput); // attempt → fail → dead (cap=1)
    const rowAfterFirst = await readLedgerSync(CAP_SOURCE_PAYMENT_ID);
    const secondResult = await reflectPayment(capInput); // short-circuit: dead skip
    const rowAfterSecond = await readLedgerSync(CAP_SOURCE_PAYMENT_ID);

    return NextResponse.json({
      action,
      firstResult, // expect { ok:false, error: ... }
      rowAfterFirst, // expect status='dead', attempts=1
      secondResult, // expect { ok:false, skipped:true, reason:'dead' } (no POST)
      rowAfterSecond, // expect status='dead', attempts still 1
    });
  }

  // ── happy (default): reflect the real fixture; run twice for the retry case ─
  const externalInvoiceId = body.externalInvoiceId ?? DEFAULTS.externalInvoiceId;
  const sourcePaymentId = body.sourcePaymentId ?? DEFAULTS.sourcePaymentId;
  const ledgerRowId = body.ledgerRowId ?? DEFAULTS.ledgerRowId;
  const amountPaidCents = body.amountPaidCents ?? DEFAULTS.amountPaidCents;

  const invoiceBefore = await readInvoice(subscriberId, externalInvoiceId);
  const reflectResult = await reflectPayment({
    subscriberId,
    provider: PROVIDER,
    externalInvoiceId,
    amountPaidCents,
    currency: "USD",
    capturePaymentId: sourcePaymentId,
    ledgerRowId,
  });
  const invoiceAfter = await readInvoice(subscriberId, externalInvoiceId);
  const ledgerSync = await readLedgerSync(sourcePaymentId);

  return NextResponse.json({
    action: "happy",
    invoiceBefore, // balance ~3900 before
    reflectResult, // 1st run: {ok:true, status:'done', externalPaymentId, alreadyReflected:false}
    invoiceAfter, // balance 0 after → Paid in Full
    ledgerSync, // status='done', external_payment_id stamped
    note: "Run this action AGAIN to exercise the retry case: expect alreadyReflected:true, no new Payment, attempts unchanged.",
  });
}
