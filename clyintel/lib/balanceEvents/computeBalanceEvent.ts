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
//
// Emission-time booleans (fee-gate fix, 2026-09-30) come from the write-once
// invoices.outreach_started_at marker — NOT invoices.reminder_count, which
// nothing ever wrote:
//   - with a payment (capture-time reconcile): both booleans =
//     isOutreachBeforePayment(...) — the SAME rule the billing gate applies, so
//     balance_events agrees with rev_share_ledger;
//   - without a payment (full QBO sync): outreach_had_fired = marker set and
//     before syncedAt; fee_eligible = false (the sync path never bills).

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

  // invoices.outreach_started_at at emission time (null = no outreach yet).
  outreachStartedAt: string | null;

  // The captured payment's times, when this drop is tied to a known payment
  // (webhook capture path). null/omitted = no payment record (full sync).
  payment?: {
    recordedAt: string | null; // QBO Payment MetaData.CreateTime
    txnDate: string | null; // QBO Payment TxnDate
  } | null;

  // ISO timestamp of this sync, recorded in evidence for audit / re-derivation.
  syncedAt: string;
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
  fee_eligible: boolean;
  evidence: {
    prevOutstandingCents: number;
    newOutstandingCents: number;
    syncedAt: string;
    outreachStartedAt: string | null;
    paymentRecordedAt: string | null;
    paymentTxnDate: string | null;
  };
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
    payment,
    syncedAt,
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

  // Emission-time evaluation (see header).
  let outreachHadFired: boolean;
  let feeEligible: boolean;
  if (payment) {
    feeEligible = isOutreachBeforePayment(outreachStartedAt, payment.recordedAt, payment.txnDate);
    outreachHadFired = feeEligible;
  } else {
    const startedMs = outreachStartedAt ? new Date(outreachStartedAt).getTime() : NaN;
    const syncedMs = new Date(syncedAt).getTime();
    outreachHadFired = !Number.isNaN(startedMs) && !Number.isNaN(syncedMs) && startedMs < syncedMs;
    feeEligible = false;
  }

  return {
    subscriber_id: subscriberId,
    invoice_id: invoiceId,
    source,
    prev_outstanding_cents: prevOutstandingCents,
    new_outstanding_cents: newOutstandingCents,
    delta_cents: deltaCents,
    outreach_had_fired: outreachHadFired,
    fee_eligible: feeEligible,
    evidence: {
      prevOutstandingCents,
      newOutstandingCents,
      syncedAt,
      outreachStartedAt: outreachStartedAt ?? null,
      paymentRecordedAt: payment?.recordedAt ?? null,
      paymentTxnDate: payment?.txnDate ?? null,
    },
  };
}
