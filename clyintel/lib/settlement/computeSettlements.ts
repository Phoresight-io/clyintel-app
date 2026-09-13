// Monthly Settlement Sweep — PURE computation (no I/O, no clock, no Stripe).
//
// Turns the eligible rev_share_ledger rows for a run into per-subscriber
// settlement plans. This module is deliberately side-effect-free so the
// dollars→cents rounding, grouping, and threshold/carry-forward logic can be
// unit-tested exhaustively; selection (DB read) and persistence (DB write) live
// in sibling modules.
//
// Money rule: rev_share_ledger.fee_amount is DOLLARS (numeric). We freeze each
// row to integer cents with Math.round(feeAmount * 100) — the SAME rounding
// accrualLedger.totalAccrued uses — and sum the per-line cents so that
// sum(line.feeCents) === plan.totalFeeCents exactly (round-per-line THEN sum,
// never round-the-sum).
//
// Carry-forward: a subscriber whose eligible total is below the minimum charge
// is CARRIED, not settled — no settlement is produced, so its ledger rows stay
// unlinked and are re-selected on a later run. Because a settlement is keyed to
// the RUN's close boundary and ABSORBS every eligible row (including rows with
// older cycle_close values), small prior-cycle fees fold into a later cycle
// until the running total clears the threshold. No carry-forward column needed.

/** An eligible rev_share_ledger row, as selection hands it to compute. */
export interface EligibleLedgerRow {
  /** rev_share_ledger.id — becomes fee_settlement_lines.ledger_row_id. */
  id: string;
  subscriberId: string;
  /** rev_share_ledger.fee_amount — DOLLARS (numeric). */
  feeAmount: number;
  /** The row's OWN accrual cycle (rev_share_ledger.cycle_close, YYYY-MM-DD). */
  cycleClose: string;
  /** rev_share_ledger.source ('qbo' | 'stripe_recovery' | …) — carried for logging only. */
  source: string;
}

export interface SettlementLine {
  ledgerRowId: string;
  feeCents: number;
}

export interface SettlementPlan {
  subscriberId: string;
  /** The RUN's close boundary — becomes fee_settlements.cycle_close. NOT the row's cycle. */
  cycleClose: string;
  totalFeeCents: number;
  lineCount: number;
  lines: SettlementLine[];
  /** total >= minChargeCents. Sub-threshold plans are carried, not persisted. */
  billable: boolean;
}

export interface ComputeInput {
  /** The RUN's close boundary date, YYYY-MM-DD (see selection / nextCycleCloseDate). */
  boundary: string;
  /** Minimum total to bill this cycle (cents). Below it, the subscriber is carried. */
  minChargeCents: number;
}

export interface ComputeResult {
  /** Plans at/above threshold — these get persisted (Prompt 2) and charged (Prompt 3). */
  billable: SettlementPlan[];
  /** Plans below threshold — NOT persisted; their rows roll into a later run. */
  carried: SettlementPlan[];
}

/** Freeze one ledger row's dollar fee to integer cents. Exported for testing. */
export function feeAmountToCents(feeAmount: number): number {
  return Math.round(feeAmount * 100);
}

/**
 * Group eligible rows by subscriber and build a settlement plan per subscriber,
 * split into billable (>= threshold) and carried (< threshold). Input order is
 * preserved (stable) so output is deterministic for a given input.
 */
export function computeSettlements(
  rows: readonly EligibleLedgerRow[],
  { boundary, minChargeCents }: ComputeInput,
): ComputeResult {
  // Group by subscriber, preserving first-seen order.
  const order: string[] = [];
  const bySubscriber = new Map<string, EligibleLedgerRow[]>();
  for (const row of rows) {
    let bucket = bySubscriber.get(row.subscriberId);
    if (bucket === undefined) {
      bucket = [];
      bySubscriber.set(row.subscriberId, bucket);
      order.push(row.subscriberId);
    }
    bucket.push(row);
  }

  const billable: SettlementPlan[] = [];
  const carried: SettlementPlan[] = [];

  for (const subscriberId of order) {
    const bucket = bySubscriber.get(subscriberId)!;
    const lines: SettlementLine[] = bucket.map((r) => ({
      ledgerRowId: r.id,
      feeCents: feeAmountToCents(r.feeAmount),
    }));
    // Round per line THEN sum, so sum(lines) === total exactly.
    const totalFeeCents = lines.reduce((sum, l) => sum + l.feeCents, 0);

    const plan: SettlementPlan = {
      subscriberId,
      cycleClose: boundary,
      totalFeeCents,
      lineCount: lines.length,
      lines,
      billable: totalFeeCents >= minChargeCents,
    };

    (plan.billable ? billable : carried).push(plan);
  }

  return { billable, carried };
}
