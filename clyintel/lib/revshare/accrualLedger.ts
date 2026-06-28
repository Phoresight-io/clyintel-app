// Accrual ledger helpers — pure & deterministic, matching the D1 engine
// convention (no UI, no I/O, no hidden clock). The reference date is always
// injected so "next 15th" is testable.
//
// Off-platform rev share is billed on the 15th of each month. These helpers
// only DESCRIBE the current cycle (close date + accrued total); nothing here
// bundles, batches, or charges — that downstream build is gated on Stripe
// Connect Express and is out of scope.

import { computeRevShareFee, RevShareResult } from './computeRevShareFee';

// Prototype seed shape. A real `rev_share_ledger` table drops in behind this
// later — do NOT create it now.
export interface LedgerSeedRow {
  invoiceRef: string;
  faceValue: number;
  dollarsRecovered: number;
  detectedAt: string; // ISO date
}

export interface ComputedLedgerRow extends LedgerSeedRow {
  result: RevShareResult;
}

export interface CurrentCycle {
  cycleCloseDate: Date;          // next 15th (billing close)
  rows: readonly ComputedLedgerRow[];
  totalAccrued: number;          // dollars, cent-exact
}

// The 15th the current cycle closes on:
//   day <= 15 → the 15th of the current month
//   day  > 15 → the 15th of next month (Date.UTC rolls Dec → Jan automatically)
// UTC throughout so the result never shifts with the runner's timezone.
export function nextCycleCloseDate(reference: Date): Date {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const day = reference.getUTCDate();

  if (day <= 15) {
    return new Date(Date.UTC(year, month, 15));
  }
  return new Date(Date.UTC(year, month + 1, 15));
}

// Sum each row's computed feeAmount. Summed in integer cents so float drift
// (0.1 + 0.2) never reaches the displayed total. Fees are already floored to
// cents by the engine, so `fee * 100` is integer-valued before rounding.
export function totalAccrued(rows: readonly LedgerSeedRow[]): number {
  const cents = rows.reduce((sum, r) => {
    const { feeAmount } = computeRevShareFee({
      invoiceFaceValue: r.faceValue,
      dollarsRecovered: r.dollarsRecovered,
    });
    return sum + Math.round(feeAmount * 100);
  }, 0);
  return cents / 100;
}

// Group seed rows into the current cycle: attach each row's computed fee and
// the close date they accrue toward, plus the cycle total.
export function groupIntoCurrentCycle(
  rows: readonly LedgerSeedRow[],
  reference: Date,
): CurrentCycle {
  const computed: ComputedLedgerRow[] = rows.map((r) => ({
    ...r,
    result: computeRevShareFee({
      invoiceFaceValue: r.faceValue,
      dollarsRecovered: r.dollarsRecovered,
    }),
  }));

  return {
    cycleCloseDate: nextCycleCloseDate(reference),
    rows: computed,
    totalAccrued: totalAccrued(rows),
  };
}
