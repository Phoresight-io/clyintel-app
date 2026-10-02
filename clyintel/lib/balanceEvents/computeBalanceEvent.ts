// Pure, dependency-free drop detector for the off-platform reconciliation
// ledger. Given an invoice's previous vs. new outstanding balance (in cents),
// decide whether this sync observed a DROP worth recording in balance_events.
//
// A "drop" = the outstanding balance fell (someone paid, off-platform or not).
// Only drops are billable events downstream; a flat or rising balance is not.
//
// The row this returns is INSERT-ready for public.balance_events and is
// constructed so it can NEVER violate the table's CHECK constraints:
//   balance_events_is_drop      → new_outstanding_cents < prev_outstanding_cents
//   balance_events_delta_matches → delta_cents = prev - new
// (both are guaranteed by the guard + arithmetic below).

import { isOutreachBeforePayment } from "../capture/outreachBeforePayment";

export interface ComputeBalanceEventInput {
  // Context passed straight through to the row.
  subscriberId: string;
  invoiceId: string;
  source: string;

  // The anchor: last known outstanding for this invoice, or null when this is
  // the first-ever observation (no prior anchor → never bill an opening balance).
  prevOutstandingCents: number | null;
  // Outstanding as of this sync.
  newOutstandingCents: number;

  // invoices.outreach_started_at at emission time (the write-once first-real-
  // contact marker, any channel), or null when no outreach has started. Drives
  // BOTH emission-time booleans.
  outreachStartedAt: string | null;

  // ISO timestamp of this sync — the moment the drop was DETECTED. Recorded in
  // evidence, and (full-sync path only) the cut-off the marker is compared against.
  syncedAt: string;

  // Capture-time path only: the times of the payment that caused this drop
  // (QBO MetaData.CreateTime + TxnDate). When present, BOTH booleans come from
  // isOutreachBeforePayment — the same rule and inputs as the billing gate — so
  // balance_events agrees with rev_share_ledger. Omitted/null = full-sync path
  // (no payment record): booleans compare the marker to syncedAt, as before.
  payment?: { recordedAt: string | null; txnDate: string | null } | null;
}

// Shape is intentionally the subset of public.balance_events["Insert"] that this
// engine populates; DB defaults (id, detected_at, created_at) are omitted.
export interface BalanceEventRow {
  subscriber_id: string;
  invoice_id: string;
  source: string;
  prev_outstanding_cents: number;
  new_outstanding_cents: number;
  delta_cents: number;
  outreach_had_fired: boolean;
  evidence: {
    prevOutstandingCents: number;
    newOutstandingCents: number;
    syncedAt: string;
    outreachStartedAt: string | null;
    paymentRecordedAt: string | null;
    paymentTxnDate: string | null;
  };
}

/**
 * LOCKED RULE: outreach on ANY channel started on the invoice before the payment
 * → billable; otherwise not. No time window. True iff the marker is set AND it is
 * at or before `cutoff`. Fail closed: a missing or unparseable timestamp on either
 * side is "not started".
 */
export function outreachStartedBy(outreachStartedAt: string | null, cutoff: string): boolean {
  if (outreachStartedAt == null) return false;
  const started = Date.parse(outreachStartedAt);
  const cut = Date.parse(cutoff);
  if (Number.isNaN(started) || Number.isNaN(cut)) return false;
  return started <= cut;
}

export function computeBalanceEvent(
  input: ComputeBalanceEventInput,
): BalanceEventRow | null {
  const {
    subscriberId,
    invoiceId,
    source,
    prevOutstandingCents,
    newOutstandingCents,
    outreachStartedAt,
    syncedAt,
    payment,
  } = input;

  // First-ever observation: no anchor, so nothing to compare against. Never
  // record the opening balance as a drop.
  if (prevOutstandingCents == null) {
    return null;
  }

  // Monotonic guard: only a strict DROP is an event. Equal → identical re-sync
  // (no-op by construction). Greater → balance rose (e.g. a credit memo / new
  // charge), which is not a payment and not billable.
  if (newOutstandingCents >= prevOutstandingCents) {
    return null;
  }

  // prev > new here, so delta > 0 and both CHECK constraints hold.
  const deltaCents = prevOutstandingCents - newOutstandingCents;

  // Emission-time evaluation (outreach_had_fired agrees with the billing gate).
  //  - capture path (payment known): outreach strictly before THIS payment, by the
  //    billing gate's own helper and inputs.
  //  - full-sync path: whether outreach had started by the time we observed this
  //    drop (detection time is the only payment-time bound available there).
  const outreachHadFired = payment
    ? isOutreachBeforePayment(outreachStartedAt, payment.recordedAt, payment.txnDate)
    : outreachStartedBy(outreachStartedAt, syncedAt);

  return {
    subscriber_id: subscriberId,
    invoice_id: invoiceId,
    source,
    prev_outstanding_cents: prevOutstandingCents,
    new_outstanding_cents: newOutstandingCents,
    delta_cents: deltaCents,
    outreach_had_fired: outreachHadFired,
    evidence: {
      prevOutstandingCents,
      newOutstandingCents,
      syncedAt,
      outreachStartedAt,
      paymentRecordedAt: payment?.recordedAt ?? null,
      paymentTxnDate: payment?.txnDate ?? null,
    },
  };
}
