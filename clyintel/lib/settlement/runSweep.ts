// Monthly Settlement Sweep — orchestrator (a plain callable function).
//
// Selection → compute → (dry-run log | persist PENDING). NO Stripe, NO cron. The
// route/cron wiring is Prompt 4; this exposes runSettlementSweep() only.
//
// Two independent gates protect the shared DB:
//   • dryRun (DEFAULT true) — computes + logs the would-be settlements and writes
//     NOTHING, so a real cycle can be eyeballed before any record exists.
//   • kill-switch (app_config settlement_sweep_enabled) — persisting requires it
//     to be explicitly true.
// A write happens only when dryRun === false AND the kill-switch is enabled.
//
// The run's close boundary defaults to the current cycle close from
// nextCycleCloseDate (the SAME "next 15th", UTC rule the frozen capture core
// stamps onto rev_share_ledger.cycle_close), so the run boundary always lines up
// with ledger cycle_close values instead of inventing a competing cadence.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import { nextCycleCloseDate } from "@/lib/revshare/accrualLedger";
import { getMinChargeCents, isSweepEnabled } from "./config";
import { selectEligibleLedgerRows } from "./selectEligibleLedgerRows";
import { computeSettlements, type SettlementPlan } from "./computeSettlements";
import { persistSettlements, type PersistedSettlement } from "./persistSettlements";

/** YYYY-MM-DD, matching how the capture core formats cycle_close. */
function toBoundaryString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface RunSweepOptions {
  /** Close boundary (YYYY-MM-DD or Date). Default: current cycle via nextCycleCloseDate(now). */
  boundary?: string | Date;
  /** Default true — compute + log only, write nothing. Set false to persist PENDING rows. */
  dryRun?: boolean;
  /** PREVIEW-only: include test_user subscribers. Default false (live). */
  includeTestUsers?: boolean;
}

export interface PlanSummary {
  subscriberId: string;
  totalFeeCents: number;
  lineCount: number;
}

export interface RunSweepResult {
  boundary: string;
  dryRun: boolean;
  sweepEnabled: boolean;
  /** True only when the run actually persisted (i.e. !dryRun && sweepEnabled). */
  wrote: boolean;
  minChargeCents: number;
  eligibleRowCount: number;
  billable: PlanSummary[];
  carried: PlanSummary[];
  /** Present only when wrote === true. */
  persisted?: PersistedSettlement[];
}

const summarize = (p: SettlementPlan): PlanSummary => ({
  subscriberId: p.subscriberId,
  totalFeeCents: p.totalFeeCents,
  lineCount: p.lineCount,
});

export async function runSettlementSweep(
  options: RunSweepOptions = {},
  service: Pick<SupabaseClient, "from" | "rpc"> = getSupabase(),
): Promise<RunSweepResult> {
  const dryRun = options.dryRun ?? true;
  const boundary =
    options.boundary === undefined
      ? toBoundaryString(nextCycleCloseDate(new Date()))
      : typeof options.boundary === "string"
        ? options.boundary
        : toBoundaryString(options.boundary);

  const [minChargeCents, sweepEnabled] = await Promise.all([
    getMinChargeCents(service),
    isSweepEnabled(service),
  ]);

  const rows = await selectEligibleLedgerRows(
    { boundary, includeTestUsers: options.includeTestUsers ?? false },
    service,
  );
  const { billable, carried } = computeSettlements(rows, { boundary, minChargeCents });

  const wrote = dryRun === false && sweepEnabled === true;

  // Always log the would-be outcome (dry-run visibility on the shared DB).
  console.log(
    `[settlement-sweep] boundary=${boundary} dryRun=${dryRun} sweepEnabled=${sweepEnabled} ` +
      `wrote=${wrote} eligibleRows=${rows.length} billable=${billable.length} carried=${carried.length}`,
  );
  for (const p of billable) {
    console.log(
      `[settlement-sweep] BILLABLE subscriber=${p.subscriberId} total=${p.totalFeeCents}c lines=${p.lineCount}`,
    );
  }
  for (const p of carried) {
    console.log(
      `[settlement-sweep] CARRIED  subscriber=${p.subscriberId} total=${p.totalFeeCents}c lines=${p.lineCount} (< ${minChargeCents}c)`,
    );
  }

  const result: RunSweepResult = {
    boundary,
    dryRun,
    sweepEnabled,
    wrote,
    minChargeCents,
    eligibleRowCount: rows.length,
    billable: billable.map(summarize),
    carried: carried.map(summarize),
  };

  if (wrote) {
    result.persisted = await persistSettlements(billable, service);
  }

  return result;
}
