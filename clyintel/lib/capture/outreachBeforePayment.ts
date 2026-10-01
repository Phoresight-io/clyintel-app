// Fee-gate decision (LOCKED RULE, Charles 2026-09-30): a fee is earned only when
// the outreach timestamp is BEFORE the payment timestamp. Pure + dependency-free
// so the billing gate (captureDepsLive) and the capture-time balance_events
// emitter share ONE definition and can never disagree.
//
//   outreachStartedAt  invoices.outreach_started_at — the write-once marker
//                      stamped by a MailerSend-accepted live email or a
//                      Vapi-accepted call (lib/outreach/markOutreachStarted).
//   paymentRecordedAt  QBO Payment MetaData.CreateTime — when the payment was
//                      recorded in QuickBooks. Preferred: a real timestamp.
//   paymentTxnDate     QBO Payment TxnDate — date-only fallback, used ONLY when
//                      CreateTime is absent or unparseable. Same UTC day is NOT
//                      before (we can't order outreach vs payment) → no fee.
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
