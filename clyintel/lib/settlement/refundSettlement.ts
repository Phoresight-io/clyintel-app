// Part B — refund EXECUTION (refund a paid settlement / void an invoiced one).
//
// A plain, exported callable: refundSettlement(). NO trigger, NO webhook routing
// (Prompt 4), NO ops endpoint (Prompt 5) — Prompt 5 imports and calls this.
//
// SCOPE (this PR): FULL reversal + VOID only. No partial-amount initiation. The
// over-refund guard + sum-of-refunds read are kept (safety, and they make the
// later partial add trivial), but any caller-supplied amount is out of scope —
// the reversal is always the full remaining refundable.
//
// HARD SAFETY GATES — a real Stripe refund/void happens ONLY when ALL hold:
//   1. dryRun === false                                   (default true)
//   2. app_config.settlement_refunds_enabled === true     (DISTINCT from charging)
//   3. liveChargesAllowed()  (VERCEL_ENV==='production' AND sk_live) — reused gate
//   4. subscriber is active AND not test_user             (re-asserted at refund time)
// Any gate failing ⇒ FORCED DRY-RUN: log the intended refund/void, make NO Stripe
// call, insert NO fee_settlement_refunds row, change NO status — same shape as the
// charge dry-run.
//
// TERMINAL AUTHORITY (mirrors the synchronous charge path, per Prompt-3 decision):
//   REFUND (paid): branch on Stripe's returned refund.status —
//     succeeded              → settlement 'refunded' + row 'succeeded' (synchronous)
//     pending/non-terminal   → settlement stays 'refund_pending' + row 'pending';
//                              Prompt 4's webhook settles terminal 'refunded'
//     failed/canceled        → row 'failed' + settlement back to 'paid' + clean error
//   VOID (invoiced): synchronous terminal → settlement 'void' + row 'succeeded'.
//
// AUDIT: this function writes NO audit_log (mirrors the charge execution path — see
// grounding G6). The fee_settlement_refunds row IS the initiation provenance;
// Prompt 4's webhook owns audit_log for settle events.
//
// RESUME-SAFE / ATOMIC (mirrors the charge claim): claim the settlement into the
// in-flight 'refund_pending' state (compare-and-set, 15-min stale reclaim), write
// the fee_settlement_refunds row with the computed idempotency key BEFORE the
// Stripe call, then call Stripe with that key. A crash between the call and the DB
// write is recovered by a re-run: the settlement is 'refund_pending', the pending
// row carries the same key, and re-calling Stripe with it returns the SAME refund
// (no second money movement, no duplicate row).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import {
  retrieveInvoice as realRetrieveInvoice,
  refundCharge as realRefundCharge,
  voidInvoice as realVoidInvoice,
} from "@/lib/stripe";
import { liveChargesAllowed, STALE_CLAIM_MS } from "./chargeSettlement";
import { isRefundsEnabled } from "./config";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Injected Stripe seam so tests never hit the real API. Defaults to lib/stripe.ts. */
export interface StripeRefunding {
  retrieveInvoice(invoiceId: string): Promise<{
    id: string;
    status: string;
    payment_intent?: string | null;
    charge?: string | null;
  }>;
  refundCharge(
    target: { paymentIntent?: string | null; charge?: string | null },
    args: { amountCents: number; idempotencyKey: string },
  ): Promise<{ id: string; status: string }>;
  voidInvoice(invoiceId: string, args: { idempotencyKey: string }): Promise<{ id: string; status: string }>;
}

const defaultStripe: StripeRefunding = {
  retrieveInvoice: realRetrieveInvoice,
  refundCharge: realRefundCharge,
  voidInvoice: realVoidInvoice,
};

export interface RefundOptions {
  /** Why the reversal is happening (stored on the row). Required. */
  reason: string;
  /** Who initiated — ops identity string (stored on the row). Required. */
  actor: string;
  /** Default true — log the intended reversal only; no Stripe call, no write. */
  dryRun?: boolean;
  /** Env/live gate seam (tests inject () => true). Defaults to the real gate. */
  liveChargesAllowed?: () => boolean;
  stripe?: StripeRefunding;
  supabase?: Pick<SupabaseClient, "from">;
}

export type RefundOutcome =
  | {
      ok: true;
      action: "refunded" | "refund_pending" | "voided" | "dry_run" | "noop";
      settlementId: string;
      mechanism?: "refund" | "void";
      refundRowId?: string;
      stripeRefundId?: string | null;
      reason?: string;
    }
  | {
      ok: false;
      action: "rejected" | "error" | "failed" | "contended";
      settlementId: string;
      reason: string;
    };

type SettlementRow = {
  id: string;
  subscriber_id: string;
  status: string;
  total_fee_cents: number;
  stripe_invoice_id: string | null;
};

type RefundRow = {
  id: string;
  kind: string;
  amount_cents: number;
  status: string;
  stripe_idempotency_key: string | null;
};

/**
 * Single-flight claim for a reversal: compare-and-set the settlement into the
 * in-flight 'refund_pending' state. Succeeds only if the row is still claimable —
 * at `fromStatus` (paid for a refund, invoiced for a void) OR a STALE
 * 'refund_pending' (a crashed run). Mirrors chargeSettlement.claimForCharge.
 */
export async function claimForRefund(
  service: Pick<SupabaseClient, "from">,
  id: string,
  fromStatus: "paid" | "invoiced",
  nowMs: number = Date.now(),
): Promise<boolean> {
  const claimIso = new Date(nowMs).toISOString();
  const staleCutoff = new Date(nowMs - STALE_CLAIM_MS).toISOString();
  const { data, error } = await service
    .from("fee_settlements")
    .update({ status: "refund_pending", claimed_at: claimIso })
    .eq("id", id)
    .or(`status.eq.${fromStatus},and(status.eq.refund_pending,claimed_at.lt.${staleCutoff})`)
    .select("id");
  if (error) throw new Error(`claimForRefund failed for ${id}: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Sum of amount_cents for this settlement's refund rows that hold a reservation
 * (status pending or succeeded). A 'failed' row frees its reservation. */
async function sumReservedRefunds(
  service: Pick<SupabaseClient, "from">,
  settlementId: string,
): Promise<number> {
  const { data, error } = await service
    .from("fee_settlement_refunds")
    .select("amount_cents, status")
    .eq("settlement_id", settlementId)
    .in("status", ["pending", "succeeded"]);
  if (error) throw new Error(`refundSettlement: refund-sum read failed: ${error.message}`);
  return ((data ?? []) as { amount_cents: number }[]).reduce((s, r) => s + Number(r.amount_cents), 0);
}

/** The single in-flight (pending) refund row for a settlement, if any. */
async function findInflightRow(
  service: Pick<SupabaseClient, "from">,
  settlementId: string,
): Promise<RefundRow | null> {
  const { data, error } = await service
    .from("fee_settlement_refunds")
    .select("id, kind, amount_cents, status, stripe_idempotency_key")
    .eq("settlement_id", settlementId)
    .eq("status", "pending");
  if (error) throw new Error(`refundSettlement: in-flight row read failed: ${error.message}`);
  const rows = (data ?? []) as RefundRow[];
  return rows[0] ?? null;
}

/**
 * Reverse a settlement. See the file header for the full state machine and gates.
 */
export async function refundSettlement(
  settlementId: string,
  options: RefundOptions,
): Promise<RefundOutcome> {
  const {
    reason,
    actor,
    dryRun = true,
    liveChargesAllowed: liveGate = liveChargesAllowed,
    stripe = defaultStripe,
    supabase = getSupabase(),
  } = options;

  if (!reason) return { ok: false, action: "error", settlementId, reason: "reason_required" };
  if (!actor) return { ok: false, action: "error", settlementId, reason: "actor_required" };

  // 1. Load the settlement.
  const { data: sData, error: sErr } = await supabase
    .from("fee_settlements")
    .select("id, subscriber_id, status, total_fee_cents, stripe_invoice_id")
    .eq("id", settlementId)
    .maybeSingle();
  if (sErr) throw new Error(`refundSettlement: settlement read failed: ${sErr.message}`);
  if (!sData) return { ok: false, action: "error", settlementId, reason: "settlement_not_found" };
  const s = sData as SettlementRow;
  const status = s.status;
  const totalFeeCents = Number(s.total_fee_cents);

  // 2. Status branch (terminal / not-reversible first — no Stripe, no write).
  if (status === "refunded" || status === "void") {
    return { ok: true, action: "noop", settlementId, reason: `already_${status}` };
  }
  if (status === "pending" || status === "charging" || status === "failed") {
    // Nothing was captured to reverse.
    return { ok: false, action: "rejected", settlementId, reason: `nothing_to_reverse:${status}` };
  }
  // status ∈ { paid, invoiced, refund_pending }.
  const mechanism: "refund" | "void" = status === "invoiced" ? "void" : "refund";

  // 3. Re-assert the subscriber (active AND not test_user) at refund time.
  const { data: sub } = await supabase
    .from("subscribers")
    .select("id, subscription_status, test_user")
    .eq("id", s.subscriber_id)
    .maybeSingle();
  const isTest = (sub as { test_user?: boolean } | null)?.test_user === true;
  const isActive = (sub as { subscription_status?: string } | null)?.subscription_status === "active";

  // 4. GATE. A real reversal needs all four to hold; anything else ⇒ forced dry-run.
  const refundsEnabled = await isRefundsEnabled(supabase);
  const liveEnv = liveGate();
  const realAllowed = dryRun === false && refundsEnabled && liveEnv && !isTest && isActive;

  if (!realAllowed) {
    const why = isTest
      ? "test_user"
      : !isActive
        ? "subscriber_inactive"
        : "gated";
    console.log(
      `[settlement-refund] DRY-RUN settlement=${settlementId} mechanism=${mechanism} ` +
        `amount=$${(totalFeeCents / 100).toFixed(2)} would=${mechanism} ` +
        `(dryRun=${dryRun} refundsEnabled=${refundsEnabled} liveEnv=${liveEnv} testUser=${isTest} active=${isActive})`,
    );
    return { ok: true, action: "dry_run", settlementId, mechanism, reason: why };
  }

  // 5. RESUME: settlement already in-flight → re-drive from the existing pending row
  //    with the SAME idempotency key (Stripe replays; no second money movement).
  if (status === "refund_pending") {
    const row = await findInflightRow(supabase, settlementId);
    if (!row) {
      // 'refund_pending' with no in-flight row is anomalous; never guess a Stripe call.
      return { ok: false, action: "error", settlementId, reason: "refund_pending_without_row" };
    }
    const key = row.stripe_idempotency_key ?? `refund_${settlementId}`;
    const rowMechanism: "refund" | "void" = row.kind === "void" ? "void" : "refund";
    return driveStripeAndSettle(supabase, stripe, s, row, rowMechanism, key);
  }

  // 6. FRESH initiation (paid → refund, invoiced → void).
  // Over-refund guard (positive-only; no negative rows). Full-only in this PR.
  const reserved = await sumReservedRefunds(supabase, settlementId);
  const remaining = totalFeeCents - reserved;
  if (remaining <= 0) {
    return { ok: false, action: "rejected", settlementId, reason: "nothing_refundable" };
  }
  if (remaining !== totalFeeCents) {
    // A prior reservation exists but is < total: only a partial would remain, and
    // partial initiation is out of scope for this PR.
    return { ok: false, action: "rejected", settlementId, reason: "partial_not_supported" };
  }
  const amountCents = remaining; // == totalFeeCents, > 0
  const key = mechanism === "void" ? `void_${settlementId}` : `refund_${settlementId}`;

  // Claim: compare-and-set (paid|invoiced) → refund_pending. Lost race ⇒ contended.
  const claimed = await claimForRefund(supabase, settlementId, mechanism === "void" ? "invoiced" : "paid");
  if (!claimed) return { ok: false, action: "contended", settlementId, reason: "claim_lost" };

  // Insert the in-flight refund row (with the key) BEFORE the Stripe call.
  const { data: inserted, error: insErr } = await supabase
    .from("fee_settlement_refunds")
    .insert({
      settlement_id: settlementId,
      kind: mechanism,
      amount_cents: amountCents,
      status: "pending",
      stripe_idempotency_key: key,
      reason,
      actor,
    })
    .select("id, kind, amount_cents, status, stripe_idempotency_key")
    .maybeSingle();
  if (insErr) throw new Error(`refundSettlement: refund row insert failed: ${insErr.message}`);
  const row = inserted as RefundRow;

  return driveStripeAndSettle(supabase, stripe, s, row, mechanism, key);
}

/**
 * Call Stripe (refund or void) with the row's idempotency key, then update the
 * refund row and settle the settlement per the resolved terminal authority.
 */
async function driveStripeAndSettle(
  supabase: Pick<SupabaseClient, "from">,
  stripe: StripeRefunding,
  s: SettlementRow,
  row: RefundRow,
  mechanism: "refund" | "void",
  key: string,
): Promise<RefundOutcome> {
  const settlementId = s.id;
  const rowId = row.id;

  // ── VOID (invoiced): synchronous terminal. ────────────────────────────────
  if (mechanism === "void") {
    if (!s.stripe_invoice_id) {
      await supabase.from("fee_settlement_refunds").update({ status: "failed" }).eq("id", rowId);
      await supabase.from("fee_settlements").update({ status: "invoiced" }).eq("id", settlementId);
      return { ok: false, action: "failed", settlementId, reason: "no_stripe_invoice" };
    }
    try {
      await stripe.voidInvoice(s.stripe_invoice_id, { idempotencyKey: key });
    } catch (e) {
      await supabase.from("fee_settlement_refunds").update({ status: "failed" }).eq("id", rowId);
      await supabase.from("fee_settlements").update({ status: "invoiced" }).eq("id", settlementId);
      return { ok: false, action: "failed", settlementId, reason: `void_error: ${errMsg(e)}` };
    }
    // A void has no refund id; stripe_refund_id stays null.
    await supabase.from("fee_settlement_refunds").update({ status: "succeeded" }).eq("id", rowId);
    await supabase.from("fee_settlements").update({ status: "void", last_error: null }).eq("id", settlementId);
    return { ok: true, action: "voided", settlementId, mechanism, refundRowId: rowId, stripeRefundId: null };
  }

  // ── REFUND (paid): branch on Stripe's returned refund.status. ─────────────
  if (!s.stripe_invoice_id) {
    await supabase.from("fee_settlement_refunds").update({ status: "failed" }).eq("id", rowId);
    await supabase.from("fee_settlements").update({ status: "paid" }).eq("id", settlementId);
    return { ok: false, action: "failed", settlementId, reason: "no_stripe_invoice" };
  }

  let target: { paymentIntent?: string | null; charge?: string | null };
  try {
    const invoice = await stripe.retrieveInvoice(s.stripe_invoice_id);
    target = { paymentIntent: invoice.payment_intent ?? null, charge: invoice.charge ?? null };
  } catch (e) {
    await supabase.from("fee_settlement_refunds").update({ status: "failed" }).eq("id", rowId);
    await supabase.from("fee_settlements").update({ status: "paid" }).eq("id", settlementId);
    return { ok: false, action: "failed", settlementId, reason: `retrieve_error: ${errMsg(e)}` };
  }
  if (!target.paymentIntent && !target.charge) {
    await supabase.from("fee_settlement_refunds").update({ status: "failed" }).eq("id", rowId);
    await supabase.from("fee_settlements").update({ status: "paid" }).eq("id", settlementId);
    return { ok: false, action: "failed", settlementId, reason: "no_refund_target" };
  }

  let refund: { id: string; status: string };
  try {
    refund = await stripe.refundCharge(target, { amountCents: Number(row.amount_cents), idempotencyKey: key });
  } catch (e) {
    await supabase.from("fee_settlement_refunds").update({ status: "failed" }).eq("id", rowId);
    await supabase.from("fee_settlements").update({ status: "paid" }).eq("id", settlementId);
    return { ok: false, action: "failed", settlementId, reason: `refund_error: ${errMsg(e)}` };
  }

  if (refund.status === "succeeded") {
    await supabase
      .from("fee_settlement_refunds")
      .update({ status: "succeeded", stripe_refund_id: refund.id })
      .eq("id", rowId);
    await supabase.from("fee_settlements").update({ status: "refunded", last_error: null }).eq("id", settlementId);
    return { ok: true, action: "refunded", settlementId, mechanism, refundRowId: rowId, stripeRefundId: refund.id };
  }

  if (refund.status === "failed" || refund.status === "canceled") {
    await supabase
      .from("fee_settlement_refunds")
      .update({ status: "failed", stripe_refund_id: refund.id })
      .eq("id", rowId);
    await supabase.from("fee_settlements").update({ status: "paid" }).eq("id", settlementId);
    return { ok: false, action: "failed", settlementId, reason: `refund_${refund.status}` };
  }

  // pending / requires_action / any other non-terminal → leave settlement
  // 'refund_pending'; Prompt 4's webhook settles terminal 'refunded'.
  await supabase
    .from("fee_settlement_refunds")
    .update({ status: "pending", stripe_refund_id: refund.id })
    .eq("id", rowId);
  return {
    ok: true,
    action: "refund_pending",
    settlementId,
    mechanism,
    refundRowId: rowId,
    stripeRefundId: refund.id,
  };
}
