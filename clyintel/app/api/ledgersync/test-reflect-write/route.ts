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
// POST body: { action?: 'happy' | 'cap' | 'inspect' | 'ground-stripe-fee' |
//              'ground-qbo-accounts' | 'probe-purchase', externalInvoiceId?,
//              sourcePaymentId?, ledgerRowId?, amountPaidCents? }
//   - 'happy'   : reflect the real fixture (invoice 145). Run it TWICE — the 2nd
//                 call is the retry/idempotency case (no 2nd QBO Payment).
//   - 'cap'     : seed a throwaway ledger_sync row with max_attempts=1, force one
//                 failure (→ 'dead'), then invoke again (→ short-circuit skip).
//   - 'inspect' : read-only — invoice balance + ledger_sync row, no reflect.
//   - 'ground-stripe-fee'    : (Phase 2 Step-1 READ 1, read-only) the Stripe
//                 processing fee + fee_details[] on the fixture charge, from the
//                 platform AND connected-account (Stripe-Account) views.
//   - 'ground-qbo-accounts'  : (Phase 2 Step-1 READ 2, read-only) the QBO chart
//                 of accounts with Expense + Bank candidate lists.
//   - 'probe-purchase'       : (Phase 2, read-only) POST an empty Purchase to
//                 read QBO's validation Fault — confirms entityPath + required
//                 fields WITHOUT creating anything.
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

// ── D2 PHASE 2 GROUNDING (read-only) ───────────────────────────────────────
// These actions perform the two §Step-1 live reads (Stripe fee_details shape +
// QBO chart of accounts) plus a Purchase entityPath probe, so the shapes can be
// verified against the live sandbox BEFORE any Phase 2 migration/adapter code is
// written. Nothing here writes to the books or the DB. Same cleanup bucket as the
// rest of this route (delete at D2 close-out).

const STRIPE_API = "https://api.stripe.com/v1";

function stripeKey(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error("STRIPE_SECRET_KEY is not set");
  return k;
}

/** Raw Stripe GET with optional connected-account (Stripe-Account) context. */
async function stripeGet(
  path: string,
  params: Record<string, string | string[]>,
  stripeAccount?: string,
): Promise<{ status: number; ok: boolean; json: unknown }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else qs.append(k, v);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${stripeKey()}` };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
  const url = qs.toString() ? `${STRIPE_API}${path}?${qs.toString()}` : `${STRIPE_API}${path}`;
  const res = await fetch(url, { headers });
  const json = (await res.json()) as unknown;
  return { status: res.status, ok: res.ok, json };
}

/** Pull `{ fee, currency, fee_details }` off a balance_transaction-ish object. */
function summarizeBt(bt: unknown): {
  fee: number | null;
  currency: string | null;
  fee_details: Array<{ type?: string; amount?: number; currency?: string; description?: string }>;
} {
  if (bt == null || typeof bt !== "object") return { fee: null, currency: null, fee_details: [] };
  const o = bt as Record<string, unknown>;
  return {
    fee: typeof o.fee === "number" ? o.fee : null,
    currency: typeof o.currency === "string" ? o.currency : null,
    fee_details: Array.isArray(o.fee_details)
      ? (o.fee_details as Array<Record<string, unknown>>).map((d) => ({
          type: typeof d.type === "string" ? d.type : undefined,
          amount: typeof d.amount === "number" ? d.amount : undefined,
          currency: typeof d.currency === "string" ? d.currency : undefined,
          description: typeof d.description === "string" ? d.description : undefined,
        }))
      : [],
  };
}

/**
 * READ 1 — resolve the connected account, then read the Stripe processing fee on
 * the fixture charge from BOTH the platform view and the connected-account view
 * (Stripe-Account header), following the transfer to the destination payment.
 * Returns fee + fee_details verbatim for each view so the real shape is visible.
 */
async function groundStripeFee(subscriberId: string, sourcePaymentId: string) {
  const service = getSupabase();
  const { data: payout } = await service
    .from("payout_accounts")
    .select("provider_account_id")
    .eq("subscriber_id", subscriberId)
    .maybeSingle();
  const connectedAccount = payout?.provider_account_id ?? null;

  // Platform view: PI → latest_charge → balance_transaction (+ transfer).
  const platformPi = await stripeGet(`/payment_intents/${sourcePaymentId}`, {
    "expand[]": ["latest_charge.balance_transaction", "latest_charge.transfer"],
  });

  const pi = platformPi.json as Record<string, unknown> | undefined;
  const platformCharge = (pi?.latest_charge ?? null) as Record<string, unknown> | null;
  const platformBt = platformCharge?.balance_transaction ?? null;
  const transfer = (platformCharge?.transfer ?? null) as Record<string, unknown> | string | null;
  const applicationFeeAmount =
    typeof platformCharge?.application_fee_amount === "number"
      ? (platformCharge.application_fee_amount as number)
      : null;

  // Follow the transfer to the connected account's destination payment/charge.
  const destinationPayment =
    transfer && typeof transfer === "object" && typeof transfer.destination_payment === "string"
      ? transfer.destination_payment
      : null;

  let connectedView: unknown = null;
  let connectedBtSummary: ReturnType<typeof summarizeBt> | null = null;
  if (connectedAccount && destinationPayment) {
    const connCharge = await stripeGet(
      `/charges/${destinationPayment}`,
      { "expand[]": ["balance_transaction"] },
      connectedAccount,
    );
    connectedView = { status: connCharge.status, ok: connCharge.ok, json: connCharge.json };
    const cc = connCharge.json as Record<string, unknown> | undefined;
    connectedBtSummary = summarizeBt(cc?.balance_transaction ?? null);
  }

  const platformBtSummary = summarizeBt(platformBt);
  return {
    read: "stripe-fee",
    connectedAccount,
    sourcePaymentId,
    applicationFeeAmount, // Phoresight rev-share (sanity: expect 85800 cents)
    platform: {
      httpStatus: platformPi.status,
      balanceTransaction: platformBtSummary,
    },
    transferDestinationPayment: destinationPayment,
    connected: {
      balanceTransaction: connectedBtSummary,
      rawCharge: connectedView,
    },
    // Grounding verdict is computed by the reader, but pre-flag the danger case:
    flags: {
      platformFeeZeroOrNull:
        platformBtSummary.fee == null || platformBtSummary.fee === 0,
      connectedFeeZeroOrNull:
        connectedBtSummary == null ||
        connectedBtSummary.fee == null ||
        connectedBtSummary.fee === 0,
    },
    rawPlatformPi: platformPi.json,
  };
}

/**
 * READ 2 — the QBO chart of accounts. Returns every Account (Id/Name/type) plus
 * pre-filtered Expense and Bank candidate lists for the fee-line + funding
 * mappings (LOCKED DECISION 6, path A — map to EXISTING accounts, create none).
 */
async function groundQboAccounts(subscriberId: string) {
  const { accessToken, realmId } = await getValidAccessToken(subscriberId);
  const url = `${qboApiBaseUrl()}/v3/company/${realmId}/query?query=${encodeURIComponent(
    "select * from Account maxresults 1000",
  )}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const body = (await res.json()) as { QueryResponse?: { Account?: Array<Record<string, unknown>> } };
  const accounts = (body.QueryResponse?.Account ?? []).map((a) => ({
    Id: a.Id as string,
    Name: a.Name as string,
    AccountType: a.AccountType as string,
    AccountSubType: a.AccountSubType as string | undefined,
    Classification: a.Classification as string | undefined,
    Active: a.Active as boolean | undefined,
  }));
  return {
    read: "qbo-accounts",
    realmId,
    httpStatus: res.status,
    total: accounts.length,
    expenseCandidates: accounts.filter((a) => a.AccountType === "Expense"),
    bankCandidates: accounts.filter(
      (a) => a.AccountType === "Bank" || a.AccountType === "Other Current Asset",
    ),
    all: accounts,
  };
}

/**
 * PROBE — confirm the Purchase entityPath ('purchase') + required-field shape by
 * POSTing a deliberately-empty body and reading QBO's validation Fault. An empty
 * body 400s, so NOTHING is created; the Fault lists what a valid Purchase needs.
 */
async function probePurchase(subscriberId: string) {
  const { accessToken, realmId } = await getValidAccessToken(subscriberId);
  const url = `${qboApiBaseUrl()}/v3/company/${realmId}/purchase`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}), // intentionally invalid → read the Fault, create nothing
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { probe: "purchase", entityPath: "purchase", httpStatus: res.status, fault: json };
}

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

  // ── D2 Phase 2 grounding (read-only): the two Step-1 live reads + probe ─────
  if (action === "ground-stripe-fee") {
    const sourcePaymentId = body.sourcePaymentId ?? DEFAULTS.sourcePaymentId;
    try {
      return NextResponse.json(await groundStripeFee(subscriberId, sourcePaymentId));
    } catch (err) {
      return NextResponse.json(
        { action, error: err instanceof Error ? err.message : String(err) },
        { status: 200 },
      );
    }
  }
  if (action === "ground-qbo-accounts") {
    try {
      return NextResponse.json(await groundQboAccounts(subscriberId));
    } catch (err) {
      return NextResponse.json(
        { action, error: err instanceof Error ? err.message : String(err) },
        { status: 200 },
      );
    }
  }
  if (action === "probe-purchase") {
    try {
      return NextResponse.json(await probePurchase(subscriberId));
    } catch (err) {
      return NextResponse.json(
        { action, error: err instanceof Error ? err.message : String(err) },
        { status: 200 },
      );
    }
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
