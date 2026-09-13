// Monthly Settlement Sweep — persist PENDING settlements (DB write, service-role).
//
// Writes one fee_settlements row (status 'pending') per BILLABLE plan plus its
// fee_settlement_lines. NO Stripe here — status stays 'pending'; charging is
// Prompt 3.
//
// Idempotency rests on the two unique guards from the schema, used with
// ON CONFLICT DO NOTHING (supabase-js upsert + ignoreDuplicates):
//   • unique (subscriber_id, cycle_close) on fee_settlements  — one settlement per
//     subscriber per cycle. A repeat run conflicts and inserts nothing.
//   • unique (ledger_row_id) on fee_settlement_lines          — a ledger row links
//     to at most one settlement, so a repeat run neither duplicates nor
//     double-links.
// A newly-created settlement gets its lines written in the same call; an
// already-existing settlement is left untouched (we never mutate a settlement's
// lines/total after creation — that keeps sum(lines) == total_fee_cents and is
// safe once Prompt 3 advances a settlement past 'pending'). Because selection
// only returns UNLINKED rows, the normal re-run re-selects nothing for an
// already-settled cycle. There is no cross-statement transaction (supabase-js
// has none); Prompt 3 must reconcile sum(fee_cents) == total_fee_cents before
// charging, which also catches the rare create-settlement-then-crash window.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { SettlementPlan } from "./computeSettlements";

/** Deterministic key for the Stripe call in Prompt 3 — stable per subscriber+cycle. */
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
  service: Pick<SupabaseClient, "from"> = getSupabase(),
): Promise<PersistedSettlement[]> {
  const results: PersistedSettlement[] = [];

  for (const plan of plans) {
    // 1. Create the settlement (ON CONFLICT (subscriber_id, cycle_close) DO NOTHING).
    const settlementRow = {
      subscriber_id: plan.subscriberId,
      cycle_close: plan.cycleClose,
      total_fee_cents: plan.totalFeeCents,
      currency: "USD",
      status: "pending",
      line_count: plan.lineCount,
      stripe_idempotency_key: settlementIdempotencyKey(plan.subscriberId, plan.cycleClose),
    };

    const { data: inserted, error: insErr } = await service
      .from("fee_settlements")
      .upsert(settlementRow, {
        onConflict: "subscriber_id,cycle_close",
        ignoreDuplicates: true,
      })
      .select("id");
    if (insErr) {
      throw new Error(
        `persistSettlements: settlement upsert failed for subscriber ${plan.subscriberId} ` +
          `cycle ${plan.cycleClose}: ${insErr.message}`,
      );
    }

    const created = Array.isArray(inserted) && inserted.length > 0;

    if (!created) {
      // Already existed (idempotent re-run). Do not touch its lines/total.
      const { data: existing, error: selErr } = await service
        .from("fee_settlements")
        .select("id")
        .eq("subscriber_id", plan.subscriberId)
        .eq("cycle_close", plan.cycleClose)
        .single();
      if (selErr || !existing) {
        throw new Error(
          `persistSettlements: conflict on (${plan.subscriberId}, ${plan.cycleClose}) but ` +
            `existing-row lookup failed: ${selErr?.message ?? "no row"}`,
        );
      }
      results.push({
        subscriberId: plan.subscriberId,
        cycleClose: plan.cycleClose,
        settlementId: (existing as { id: string }).id,
        created: false,
        linesInserted: 0,
      });
      continue;
    }

    const settlementId = (inserted as { id: string }[])[0].id;

    // 2. Link the ledger rows (ON CONFLICT (ledger_row_id) DO NOTHING).
    let linesInserted = 0;
    if (plan.lines.length > 0) {
      const lineRows = plan.lines.map((l) => ({
        settlement_id: settlementId,
        ledger_row_id: l.ledgerRowId,
        fee_cents: l.feeCents,
      }));
      const { data: insertedLines, error: lineErr } = await service
        .from("fee_settlement_lines")
        .upsert(lineRows, { onConflict: "ledger_row_id", ignoreDuplicates: true })
        .select("id");
      if (lineErr) {
        throw new Error(
          `persistSettlements: line upsert failed for settlement ${settlementId}: ${lineErr.message}`,
        );
      }
      linesInserted = Array.isArray(insertedLines) ? insertedLines.length : 0;
    }

    results.push({
      subscriberId: plan.subscriberId,
      cycleClose: plan.cycleClose,
      settlementId,
      created: true,
      linesInserted,
    });
  }

  return results;
}
