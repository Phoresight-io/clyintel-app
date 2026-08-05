import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { reflectPayment } from "@/lib/ledgerSync/reflectPayment";
import { getValidAccessToken } from "@/lib/qbo/tokens";
import { getInvoice } from "@/lib/qbo/client";

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
