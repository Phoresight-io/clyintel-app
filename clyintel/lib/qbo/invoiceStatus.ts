import type { Database } from "../../types/supabase";

type InvoiceStatus = Database["public"]["Enums"]["invoice_status"];

// Derive an invoice's status from QBO's authoritative figures rather than letting
// the column DEFAULT ('draft') stand — a synced/paid QBO invoice has been issued,
// so 'draft' is never correct for it. QBO `Balance` is the outstanding amount and
// `TotalAmt` the face value:
//   paid    → nothing outstanding
//   partial → some paid, but a balance remains
//   overdue → outstanding and past its due date
//   sent    → outstanding, not yet due (or no due date)
// `todayIso` and QBO DueDate are both YYYY-MM-DD, so a lexicographic compare is a
// correct date comparison.
//
// Extracted from runQboSync so the full intake sync AND the capture-time invoice
// reconcile compute status with the SAME math — that identity is what makes a
// capture-time reconcile and a later full sync converge on the same value
// (idempotent-by-recompute, no double-count).
export function deriveInvoiceStatus(
  totalAmtCents: number,
  balanceCents: number,
  dueDate: string | null,
  todayIso: string,
): InvoiceStatus {
  if (balanceCents <= 0) return "paid";
  if (totalAmtCents - balanceCents > 0) return "partial";
  if (dueDate && dueDate < todayIso) return "overdue";
  return "sent";
}
