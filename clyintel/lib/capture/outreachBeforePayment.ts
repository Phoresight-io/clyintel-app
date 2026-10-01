// Fee-gate decision (locked rules, 2026-09-30): a fee is earned only when
// outreach STARTED on the invoice before the payment. Pure + dependency-free so
// both the billing gate (captureDepsLive) and the balance_events emitter share
// ONE definition and can never disagree.
//
//   outreachStartedAt  invoices.outreach_started_at — the write-once marker
//                      stamped by a successful live email send or a placed
//                      voice call (lib/outreach/markOutreachStarted).
//   paymentRecordedAt  QBO Payment MetaData.CreateTime — when the payment was
//                      recorded in QuickBooks. Preferred: a real timestamp.
//   paymentTxnDate     QBO Payment TxnDate — date-only fallback, used ONLY when
//                      CreateTime is absent or unparseable.
//
// Every uncertain input fails CLOSED (false → no fee).

function parseMs(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// UTC calendar date (YYYY-MM-DD) of an instant.
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isOutreachBeforePayment(
  outreachStartedAt: string | null | undefined,
  paymentRecordedAt: string | null | undefined,
  paymentTxnDate: string | null | undefined,
): boolean {
  // No (or unreadable) outreach marker → outreach never started → no fee.
  const outreachMs = parseMs(outreachStartedAt);
  if (outreachMs == null) return false;

  // 1. CreateTime present and valid → strict instant comparison. Equal is NOT
  //    before.
  const recordedMs = parseMs(paymentRecordedAt);
  if (recordedMs != null) return outreachMs < recordedMs;

  // 2. Fallback: outreach's UTC date strictly before the payment's TxnDate.
  //    Same day is ambiguous (we can't order them) → no fee.
  const txnMs = parseMs(paymentTxnDate);
  if (txnMs != null) return utcDate(outreachMs) < utcDate(txnMs);

  // 3. Neither payment time is available → no fee.
  return false;
}
