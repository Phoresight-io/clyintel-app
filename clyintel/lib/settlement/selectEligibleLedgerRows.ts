// Monthly Settlement Sweep — selection (DB read, service-role).
//
// Returns the rev_share_ledger rows eligible to be swept for a given close
// boundary. Eligible = accrued on/before the boundary, not already folded into a
// settlement, belonging to an active (and, in live mode, non-test) subscriber.
//
// Predicates (from the settlement spec):
//   • rev_share_ledger.cycle_close <= :boundary
//   • id NOT IN (select ledger_row_id from fee_settlement_lines)   -- unlinked = eligible
//                                                                   -- (void releases lines)
//   • subscriber subscription_status = 'active'
//   • subscriber test_user = false           (live; PREVIEW may include test users)
//   • source-agnostic (qbo + stripe_recovery both land here — no source filter)
//
// Uses the service-role client (cross-subscriber; rev_share_ledger is
// service-role-write, and this reads across every subscriber). PostgREST can't
// express `NOT IN (subquery)` directly, so we resolve the linked-id set and the
// active-subscriber set in their own reads and combine in memory — the same
// separate-query style captureDepsLive uses. Data volume is small (greenfield);
// if the ledger ever outgrows a single page this becomes keyset pagination.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { EligibleLedgerRow } from "./computeSettlements";

export interface SelectOptions {
  /** Run close boundary, YYYY-MM-DD. Rows with cycle_close <= this are in scope. */
  boundary: string;
  /** PREVIEW-only escape hatch: include test_user subscribers. Default false (live). */
  includeTestUsers?: boolean;
}

export async function selectEligibleLedgerRows(
  { boundary, includeTestUsers = false }: SelectOptions,
  service: Pick<SupabaseClient, "from"> = getSupabase(),
): Promise<EligibleLedgerRow[]> {
  // 1. Active (and, in live mode, non-test) subscribers.
  let subQuery = service
    .from("subscribers")
    .select("id")
    .eq("subscription_status", "active");
  if (!includeTestUsers) {
    subQuery = subQuery.eq("test_user", false);
  }
  const { data: subs, error: subErr } = await subQuery;
  if (subErr) {
    throw new Error(`selectEligibleLedgerRows: subscribers read failed: ${subErr.message}`);
  }
  const activeSubscriberIds = new Set((subs ?? []).map((s: { id: string }) => s.id));
  if (activeSubscriberIds.size === 0) return [];

  // 2. Ledger rows already folded into a settlement (any settlement) — excluded.
  const { data: linked, error: linkedErr } = await service
    .from("fee_settlement_lines")
    .select("ledger_row_id");
  if (linkedErr) {
    throw new Error(`selectEligibleLedgerRows: fee_settlement_lines read failed: ${linkedErr.message}`);
  }
  const linkedRowIds = new Set(
    (linked ?? []).map((l: { ledger_row_id: string }) => l.ledger_row_id),
  );

  // 3. Ledger rows accrued on/before the boundary (source-agnostic).
  const { data: ledger, error: ledgerErr } = await service
    .from("rev_share_ledger")
    .select("id, subscriber_id, fee_amount, cycle_close, source")
    .lte("cycle_close", boundary);
  if (ledgerErr) {
    throw new Error(`selectEligibleLedgerRows: rev_share_ledger read failed: ${ledgerErr.message}`);
  }

  type LedgerRow = {
    id: string;
    subscriber_id: string;
    fee_amount: number | string;
    cycle_close: string;
    source: string;
  };

  return (ledger ?? [])
    .filter(
      (r: LedgerRow) => activeSubscriberIds.has(r.subscriber_id) && !linkedRowIds.has(r.id),
    )
    .map((r: LedgerRow) => ({
      id: r.id,
      subscriberId: r.subscriber_id,
      // fee_amount is numeric; PostgREST may hand it back as number or string.
      feeAmount: Number(r.fee_amount),
      cycleClose: r.cycle_close,
      source: r.source,
    }));
}
