// Monthly Settlement Sweep — charge PENDING settlements (the money step).
//
// Drains fee_settlements (status 'pending', or 'failed' with attempts <
// max_attempts) and charges each via a Stripe Invoice on the subscriber's own
// customer. NO cron here (Prompt 4). A plain callable: drainSettlements().
//
// HARD SAFETY GATES — a real charge happens ONLY when ALL hold:
//   1. dryRun === false                        (default true — compute/log only)
//   2. kill-switch on (app_config.settlement_sweep_enabled === true)
//   3. env/live gate: VERCEL_ENV === 'production' AND STRIPE_SECRET_KEY starts
//      with 'sk_live'  (no ambient prod-detection exists — built explicitly here)
// Any gate failing ⇒ forced dry-run: we still select + reconcile + log, but make
// NO Stripe call and NO DB write. And test_user / active / has-customer are
// RE-ASSERTED at charge time, not trusted from selection.
//
// Status machine (mirrors ledger_sync's status/attempts/max_attempts/last_error):
//   pending → invoiced (finalized) → paid (payment ok) / failed (declined/error)
// On failure attempts++ and last_error is set; the settlement is retryable until
// attempts == max_attempts, then it dead-letters (stays 'failed', attempts maxed,
// so the drain query no longer re-selects it). stripe_invoice_id is stored once
// the invoice is finalized so a retry resumes at payment (never a second invoice).
//
// Webhook reconciliation (invoice.paid / invoice.payment_failed) is DEFERRED —
// see the TODO at the bottom and the PR note. Status is set from the synchronous
// finalize+pay result, which is authoritative for charge_automatically card
// invoices.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import {
  createInvoice as realCreateInvoice,
  addInvoiceItem as realAddInvoiceItem,
  finalizeInvoice as realFinalizeInvoice,
  payInvoice as realPayInvoice,
} from "@/lib/stripe";
import { reconcileSettlement } from "./reconcileSettlement";

// Charges settle in USD (fee_settlements.currency default). Stripe wants lowercase.
const CURRENCY = "usd";

/** The ONLY context in which a live Stripe charge may be created. */
export function liveChargesAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.VERCEL_ENV === "production" &&
    typeof env.STRIPE_SECRET_KEY === "string" &&
    env.STRIPE_SECRET_KEY.startsWith("sk_live")
  );
}

export interface SettlementRow {
  id: string;
  subscriberId: string;
  cycleClose: string;
  totalFeeCents: number;
  lineCount: number;
  status: string;
  attempts: number;
  maxAttempts: number;
  stripeInvoiceId: string | null;
  stripeIdempotencyKey: string;
}

export interface SubscriberRow {
  id: string;
  subscriptionStatus: string;
  testUser: boolean;
  stripeCustomerId: string | null;
}

/** A settlement line joined to its rev_share_ledger row (for the transparency line). */
export interface ChargeLine {
  ledgerRowId: string;
  feeCents: number;
  invoiceRef: string;
  invoiceNumber: string | null;
  dollarsRecovered: number;
  band: string;
  rate: number;
}

/** Injected Stripe seam so tests never hit the real API. Defaults to lib/stripe.ts. */
export interface StripeInvoicing {
  createInvoice(customerId: string, idempotencyKey: string): Promise<{ id: string }>;
  addInvoiceItem(args: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    currency: string;
    description: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  finalizeInvoice(invoiceId: string): Promise<{ id: string; status: string }>;
  payInvoice(invoiceId: string): Promise<{ id: string; status: string; paid?: boolean }>;
}

const defaultStripe: StripeInvoicing = {
  createInvoice: realCreateInvoice,
  addInvoiceItem: realAddInvoiceItem,
  finalizeInvoice: realFinalizeInvoice,
  payInvoice: realPayInvoice,
};

/** Subscriber-facing transparency statement on each invoice line. */
export function lineDescription(l: ChargeLine): string {
  const invoice = l.invoiceNumber ?? l.invoiceRef;
  const pct = Number((l.rate * 100).toFixed(2)); // 0.2200 → 22
  return (
    `Recovery fee — invoice #${invoice}: ${pct}% of ` +
    `$${l.dollarsRecovered.toFixed(2)} recovered (band ${l.band})`
  );
}

type SettlementUpdate = {
  status?: string;
  stripe_invoice_id?: string;
  attempts?: number;
  last_error?: string | null;
};

export type ChargeOutcome =
  | { action: "charged"; settlementId: string; update: SettlementUpdate } // paid
  | { action: "failed"; settlementId: string; reason: string; update: SettlementUpdate }
  | { action: "skipped"; settlementId: string; reason: string }; // test_user / inactive — no write

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Charge exactly ONE settlement. Assumes the caller has already confirmed the
 * charge gates (dryRun=false, kill-switch, env/live). Performs NO DB writes —
 * returns the update for the drainer to apply — and only Stripe calls via the
 * injected seam. Pure enough to unit-test every branch.
 */
export async function chargeOneSettlement(
  ctx: { settlement: SettlementRow; subscriber: SubscriberRow; lines: ChargeLine[] },
  stripe: StripeInvoicing = defaultStripe,
): Promise<ChargeOutcome> {
  const { settlement, subscriber, lines } = ctx;
  const nextAttempts = settlement.attempts + 1;

  // Re-assert eligibility at charge time (never trust selection alone).
  if (subscriber.testUser) {
    return { action: "skipped", settlementId: settlement.id, reason: "test_user" };
  }
  if (subscriber.subscriptionStatus !== "active") {
    return { action: "skipped", settlementId: settlement.id, reason: "subscriber_inactive" };
  }
  if (!subscriber.stripeCustomerId) {
    return {
      action: "failed",
      settlementId: settlement.id,
      reason: "no_stripe_customer",
      update: { status: "failed", attempts: nextAttempts, last_error: "no_stripe_customer" },
    };
  }

  // Reconciliation gate: line_count + sum(fee_cents) must match the stored totals
  // (this also reconciles the summed invoice-item amounts to total_fee_cents, since
  // the items ARE the lines). Mismatch ⇒ fail without charging.
  const rec = reconcileSettlement({
    lineCount: settlement.lineCount,
    totalFeeCents: settlement.totalFeeCents,
    lines,
  });
  if (!rec.ok) {
    return {
      action: "failed",
      settlementId: settlement.id,
      reason: rec.reason,
      update: { status: "failed", attempts: nextAttempts, last_error: rec.reason },
    };
  }

  const customerId = subscriber.stripeCustomerId;
  const key = settlement.stripeIdempotencyKey;

  // Build + finalize the invoice unless a prior attempt already finalized one
  // (stripe_invoice_id is stored only AFTER finalize, so its presence means the
  // invoice is finalized and we resume straight at payment — no second invoice).
  let invoiceId = settlement.stripeInvoiceId;
  if (!invoiceId) {
    try {
      const invoice = await stripe.createInvoice(customerId, key);
      for (const l of lines) {
        await stripe.addInvoiceItem({
          customerId,
          invoiceId: invoice.id,
          amountCents: l.feeCents,
          currency: CURRENCY,
          description: lineDescription(l),
          idempotencyKey: `${key}_line_${l.ledgerRowId}`,
        });
      }
      await stripe.finalizeInvoice(invoice.id);
      invoiceId = invoice.id; // only now: finalized
    } catch (e) {
      // No stripe_invoice_id stored → a retry re-creates via the idempotency key
      // (same invoice, no duplicate) and re-finalizes.
      return {
        action: "failed",
        settlementId: settlement.id,
        reason: `invoice_build: ${errMsg(e)}`,
        update: { status: "failed", attempts: nextAttempts, last_error: `invoice_build: ${errMsg(e)}` },
      };
    }
  }

  // Attempt payment. A decline makes the hand-rolled client throw (non-2xx).
  try {
    const paid = await stripe.payInvoice(invoiceId);
    if (paid.paid === true || paid.status === "paid") {
      return {
        action: "charged",
        settlementId: settlement.id,
        update: { status: "paid", stripe_invoice_id: invoiceId, last_error: null },
      };
    }
    // Finalized but not paid synchronously (retryable; invoice id retained).
    return {
      action: "failed",
      settlementId: settlement.id,
      reason: `payment_${paid.status}`,
      update: {
        status: "failed",
        stripe_invoice_id: invoiceId,
        attempts: nextAttempts,
        last_error: `payment_${paid.status}`,
      },
    };
  } catch (e) {
    return {
      action: "failed",
      settlementId: settlement.id,
      reason: `payment: ${errMsg(e)}`,
      update: {
        status: "failed",
        stripe_invoice_id: invoiceId,
        attempts: nextAttempts,
        last_error: `payment: ${errMsg(e)}`,
      },
    };
  }
}

export interface DrainOptions {
  /** Default true — select + reconcile + log, but no Stripe call and no DB write. */
  dryRun?: boolean;
  /** Max candidate settlements per run (settlements are ≤ subscribers; small). */
  limit?: number;
}

export interface DrainResult {
  dryRun: boolean;
  /** True only when the run may actually charge (all three gates pass). */
  charging: boolean;
  sweepEnabled: boolean;
  liveEnv: boolean;
  candidates: number;
  charged: number;
  failed: number;
  skipped: number;
  outcomes: { settlementId: string; action: string; reason?: string }[];
}

/**
 * Drain and (when the gates allow) charge pending/retryable settlements.
 * Reads the kill-switch from app_config; the env/live gate from process.env.
 */
export async function drainSettlements(
  options: DrainOptions = {},
  service: Pick<SupabaseClient, "from"> = getSupabase(),
  stripe: StripeInvoicing = defaultStripe,
): Promise<DrainResult> {
  const dryRun = options.dryRun ?? true;
  const limit = options.limit ?? 500;

  // Kill-switch (inline read — config.ts's isSweepEnabled needs only { from }).
  const { data: cfg } = await service
    .from("app_config")
    .select("value")
    .eq("key", "settlement_sweep_enabled")
    .maybeSingle();
  const sweepEnabled = (cfg as { value: unknown } | null)?.value === true;

  const liveEnv = liveChargesAllowed();
  const charging = dryRun === false && sweepEnabled && liveEnv;

  // 1. Candidate settlements: pending, or failed-but-retryable.
  const { data: rows, error } = await service
    .from("fee_settlements")
    .select(
      "id, subscriber_id, cycle_close, total_fee_cents, line_count, status, attempts, max_attempts, stripe_invoice_id, stripe_idempotency_key",
    )
    .in("status", ["pending", "failed"])
    .limit(limit);
  if (error) throw new Error(`drainSettlements: fee_settlements read failed: ${error.message}`);

  type Row = {
    id: string;
    subscriber_id: string;
    cycle_close: string;
    total_fee_cents: number;
    line_count: number;
    status: string;
    attempts: number;
    max_attempts: number;
    stripe_invoice_id: string | null;
    stripe_idempotency_key: string;
  };
  const candidates = (rows ?? []).filter(
    (r: Row) => r.status === "pending" || (r.status === "failed" && r.attempts < r.max_attempts),
  );

  const result: DrainResult = {
    dryRun,
    charging,
    sweepEnabled,
    liveEnv,
    candidates: candidates.length,
    charged: 0,
    failed: 0,
    skipped: 0,
    outcomes: [],
  };
  if (candidates.length === 0) return result;

  // 2. Batch-load subscribers, lines, and the lines' ledger rows.
  const subIds = [...new Set(candidates.map((r) => r.subscriber_id))];
  const { data: subs, error: subErr } = await service
    .from("subscribers")
    .select("id, subscription_status, test_user, stripe_customer_id")
    .in("id", subIds);
  if (subErr) throw new Error(`drainSettlements: subscribers read failed: ${subErr.message}`);
  const subById = new Map(
    (subs ?? []).map((s: { id: string; subscription_status: string; test_user: boolean; stripe_customer_id: string | null }) => [
      s.id,
      { id: s.id, subscriptionStatus: s.subscription_status, testUser: s.test_user, stripeCustomerId: s.stripe_customer_id },
    ]),
  );

  const settlementIds = candidates.map((r) => r.id);
  const { data: lineRows, error: lineErr } = await service
    .from("fee_settlement_lines")
    .select("settlement_id, ledger_row_id, fee_cents")
    .in("settlement_id", settlementIds);
  if (lineErr) throw new Error(`drainSettlements: fee_settlement_lines read failed: ${lineErr.message}`);
  const allLineRows = (lineRows ?? []) as { settlement_id: string; ledger_row_id: string; fee_cents: number }[];

  const ledgerIds = [...new Set(allLineRows.map((l) => l.ledger_row_id))];
  const ledgerById = new Map<string, { invoice_ref: string; invoice_number: string | null; dollars_recovered: number; band: string; rate: number }>();
  if (ledgerIds.length > 0) {
    const { data: ledger, error: ledErr } = await service
      .from("rev_share_ledger")
      .select("id, invoice_ref, invoice_number, dollars_recovered, band, rate")
      .in("id", ledgerIds);
    if (ledErr) throw new Error(`drainSettlements: rev_share_ledger read failed: ${ledErr.message}`);
    for (const r of (ledger ?? []) as {
      id: string; invoice_ref: string; invoice_number: string | null; dollars_recovered: number; band: string; rate: number;
    }[]) {
      ledgerById.set(r.id, {
        invoice_ref: r.invoice_ref,
        invoice_number: r.invoice_number,
        dollars_recovered: Number(r.dollars_recovered),
        band: r.band,
        rate: Number(r.rate),
      });
    }
  }

  const linesBySettlement = new Map<string, ChargeLine[]>();
  for (const l of allLineRows) {
    const led = ledgerById.get(l.ledger_row_id);
    const line: ChargeLine = {
      ledgerRowId: l.ledger_row_id,
      feeCents: l.fee_cents,
      invoiceRef: led?.invoice_ref ?? l.ledger_row_id,
      invoiceNumber: led?.invoice_number ?? null,
      dollarsRecovered: led?.dollars_recovered ?? 0,
      band: led?.band ?? "?",
      rate: led?.rate ?? 0,
    };
    (linesBySettlement.get(l.settlement_id) ?? linesBySettlement.set(l.settlement_id, []).get(l.settlement_id)!).push(line);
  }

  // 3. Process each candidate.
  for (const r of candidates) {
    const settlement: SettlementRow = {
      id: r.id,
      subscriberId: r.subscriber_id,
      cycleClose: r.cycle_close,
      totalFeeCents: r.total_fee_cents,
      lineCount: r.line_count,
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      stripeInvoiceId: r.stripe_invoice_id,
      stripeIdempotencyKey: r.stripe_idempotency_key,
    };
    const subscriber = subById.get(r.subscriber_id);
    const lines = linesBySettlement.get(r.id) ?? [];

    if (!subscriber) {
      // Subscriber vanished — treat as skip (never charge without a live subscriber).
      result.skipped++;
      result.outcomes.push({ settlementId: r.id, action: "skipped", reason: "subscriber_not_found" });
      continue;
    }

    if (!charging) {
      // Forced dry-run: log what WOULD happen; write nothing, call no Stripe.
      const rec = reconcileSettlement({ lineCount: settlement.lineCount, totalFeeCents: settlement.totalFeeCents, lines });
      const would = subscriber.testUser
        ? "skip(test_user)"
        : subscriber.subscriptionStatus !== "active"
          ? "skip(inactive)"
          : !subscriber.stripeCustomerId
            ? "fail(no_stripe_customer)"
            : !rec.ok
              ? "fail(reconcile)"
              : `charge($${(settlement.totalFeeCents / 100).toFixed(2)})`;
      console.log(
        `[settlement-charge] DRY-RUN settlement=${r.id} sub=${r.subscriber_id} would=${would} ` +
          `(dryRun=${dryRun} sweepEnabled=${sweepEnabled} liveEnv=${liveEnv})`,
      );
      result.outcomes.push({ settlementId: r.id, action: "dry_run", reason: would });
      continue;
    }

    const outcome = await chargeOneSettlement({ settlement, subscriber, lines }, stripe);
    if (outcome.action === "skipped") {
      result.skipped++;
      result.outcomes.push({ settlementId: r.id, action: "skipped", reason: outcome.reason });
      continue;
    }

    // Apply the DB update (charged or failed).
    const { error: updErr } = await service
      .from("fee_settlements")
      .update(outcome.update)
      .eq("id", r.id);
    if (updErr) {
      // Best-effort mark-back; the charge already happened, so log loudly.
      console.error(`drainSettlements: failed to mark settlement ${r.id}`, updErr);
    }

    if (outcome.action === "charged") {
      result.charged++;
      result.outcomes.push({ settlementId: r.id, action: "charged" });
    } else {
      result.failed++;
      const dead = settlement.attempts + 1 >= settlement.maxAttempts;
      result.outcomes.push({
        settlementId: r.id,
        action: dead ? "dead_letter" : "failed",
        reason: outcome.reason,
      });
    }
  }

  return result;
}

// TODO(prompt-4-followup): async reconciliation via the existing stripe-webhook
// route. On invoice.paid / invoice.payment_failed, look up fee_settlements by
// stripe_invoice_id and move invoiced→paid/failed. Deferred here because that
// route also serves the subscription-billing rail and would need to disambiguate
// settlement invoices from subscription invoices — meaningful added scope. The
// synchronous finalize+pay result above is authoritative for charge_automatically
// card invoices, which is the current path.
