// Monthly Settlement Sweep — reconciliation gate (PURE, no I/O).
//
// Belt-and-suspenders before charging: even though persist_fee_settlement writes
// the settlement and its lines atomically, we re-verify the money adds up before
// any Stripe call. Two invariants must hold:
//   • line_count == actual number of fee_settlement_lines
//   • sum(fee_cents) == total_fee_cents   (to the cent)
// A mismatch means the settlement is corrupt (partial write, tampering, drift) —
// the caller marks it 'failed' with the returned reason and DOES NOT charge.

export interface ReconcileInput {
  /** fee_settlements.line_count (what the settlement claims). */
  lineCount: number;
  /** fee_settlements.total_fee_cents (what the settlement claims). */
  totalFeeCents: number;
  /** The actual fee_settlement_lines rows loaded for this settlement. */
  lines: readonly { feeCents: number }[];
}

export type ReconcileResult =
  | { ok: true; sumFeeCents: number; actualLineCount: number }
  | { ok: false; reason: string; sumFeeCents: number; actualLineCount: number };

export function reconcileSettlement(input: ReconcileInput): ReconcileResult {
  const actualLineCount = input.lines.length;
  const sumFeeCents = input.lines.reduce((s, l) => s + l.feeCents, 0);

  if (actualLineCount !== input.lineCount) {
    return {
      ok: false,
      reason: `reconcile: line_count ${input.lineCount} != actual lines ${actualLineCount}`,
      sumFeeCents,
      actualLineCount,
    };
  }
  if (sumFeeCents !== input.totalFeeCents) {
    return {
      ok: false,
      reason: `reconcile: total_fee_cents ${input.totalFeeCents} != sum(fee_cents) ${sumFeeCents}`,
      sumFeeCents,
      actualLineCount,
    };
  }
  return { ok: true, sumFeeCents, actualLineCount };
}
