// Monthly Settlement Sweep — persist PENDING settlements (DB write, service-role).
//
// Writes one fee_settlements row (status 'pending') per BILLABLE plan plus its
// fee_settlement_lines. NO Stripe here — status stays 'pending'; charging is
// Prompt 3's chargeSettlement.
//
// ATOMIC: delegates to the plpgsql RPC public.persist_fee_settlement, which does
// the settlement insert AND the line inserts in ONE transaction (honoring
// unique(subscriber_id, cycle_close) and unique(ledger_row_id) with ON CONFLICT
// DO NOTHING). This replaces Prompt 2's two-call upsert, closing the
// "settlement created, crash before lines" window. A repeat run is a no-op — the
// settlement conflict short-circuits and no line is re-linked.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { SettlementPlan } from "./computeSettlements";

/** Deterministic key for the Stripe call — stable per subscriber+cycle. */
export function settlementIdempotencyKey(subscriberId: string, cycleClose: string): string {
  return `settle_${subscriberId}_${cycleClose}`;
}

export interface PersistedSettlement {
  subscriberId: string;
  cycleClose: string;
  settlementId: string;
  /** true if this run inserted the settlement; false if it already existed (re-run). */
  created: boolean;
  linesInserted: number;
}

export async function persistSettlements(
  plans: readonly SettlementPlan[],
  service: Pick<SupabaseClient, "rpc"> = getSupabase(),
): Promise<PersistedSettlement[]> {
  const results: PersistedSettlement[] = [];

  for (const plan of plans) {
    const { data, error } = await service.rpc("persist_fee_settlement", {
      p_subscriber_id: plan.subscriberId,
      p_cycle_close: plan.cycleClose,
      p_total_fee_cents: plan.totalFeeCents,
      p_currency: "USD",
      p_line_count: plan.lineCount,
      p_stripe_idempotency_key: settlementIdempotencyKey(plan.subscriberId, plan.cycleClose),
      p_lines: plan.lines.map((l) => ({ ledger_row_id: l.ledgerRowId, fee_cents: l.feeCents })),
    });
    if (error) {
      throw new Error(
        `persistSettlements: persist_fee_settlement RPC failed for subscriber ${plan.subscriberId} ` +
          `cycle ${plan.cycleClose}: ${error.message}`,
      );
    }

    // The RPC returns a single { settlement_id, created } row.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { settlement_id: string; created: boolean }
      | undefined;
    if (!row || !row.settlement_id) {
      throw new Error(
        `persistSettlements: persist_fee_settlement returned no row for ` +
          `${plan.subscriberId}/${plan.cycleClose}`,
      );
    }

    results.push({
      subscriberId: plan.subscriberId,
      cycleClose: plan.cycleClose,
      settlementId: row.settlement_id,
      created: row.created,
      // The RPC links all lines atomically on create; none on a re-run.
      linesInserted: row.created ? plan.lines.length : 0,
    });
  }

  return results;
}
