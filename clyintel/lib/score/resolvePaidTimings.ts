// Turns each paid invoice's payment evidence, from any source, into ONE
// normalized paid-in-full date. Pure: the loader passes in rows it has already
// read. computeClientScore only receives the normalized PaidTiming; the source
// is kept solely as an audit field (date_source).
//
// Precedence for each invoice with status 'paid':
//   a) payments.paid_at via invoice_payments (status 'succeeded'): the date of
//      the LAST succeeded payment → 'payment'
//   b) balance_events: the FIRST event (by detected_at) with
//      new_outstanding_cents = 0. Uses evidence.txnDate if present → 'qbo_txn',
//      otherwise detected_at → 'detected'
//   c) neither → no record (the invoice is "paid, undated")
// All dates are UTC 'YYYY-MM-DD'.

export type DateSource = "payment" | "qbo_txn" | "detected";

export interface PaidTiming {
  invoice_id: string;
  paid_date: string; // YYYY-MM-DD (UTC)
  date_source: DateSource;
}

export interface PaymentTimingRow {
  invoice_id: string;
  paid_at: string | null; // succeeded payments only
}

export interface BalanceEventTimingRow {
  invoice_id: string;
  detected_at: string;
  new_outstanding_cents: number;
  evidence: unknown;
}

// "YYYY-MM-DD" (UTC) for a timestamp or date string; null when unparseable.
export function utcDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function evidenceTxnDate(evidence: unknown): string | null {
  if (typeof evidence !== "object" || evidence === null) return null;
  return utcDate((evidence as Record<string, unknown>).txnDate);
}

export function resolvePaidTimings(
  paidInvoiceIds: string[],
  payments: PaymentTimingRow[],
  balanceEvents: BalanceEventTimingRow[],
): PaidTiming[] {
  const lastPayment = new Map<string, string>();
  for (const p of payments) {
    const d = utcDate(p.paid_at);
    if (!d) continue;
    const cur = lastPayment.get(p.invoice_id);
    if (!cur || d > cur) lastPayment.set(p.invoice_id, d);
  }

  const firstZero = new Map<string, BalanceEventTimingRow>();
  for (const e of balanceEvents) {
    if (e.new_outstanding_cents !== 0 || !utcDate(e.detected_at)) continue;
    const cur = firstZero.get(e.invoice_id);
    if (!cur || Date.parse(e.detected_at) < Date.parse(cur.detected_at)) firstZero.set(e.invoice_id, e);
  }

  const out: PaidTiming[] = [];
  for (const id of [...new Set(paidInvoiceIds)].sort()) {
    const pay = lastPayment.get(id);
    if (pay) {
      out.push({ invoice_id: id, paid_date: pay, date_source: "payment" });
      continue;
    }
    const ev = firstZero.get(id);
    if (ev) {
      const txn = evidenceTxnDate(ev.evidence);
      out.push(
        txn
          ? { invoice_id: id, paid_date: txn, date_source: "qbo_txn" }
          : { invoice_id: id, paid_date: utcDate(ev.detected_at) as string, date_source: "detected" },
      );
    }
  }
  return out;
}
