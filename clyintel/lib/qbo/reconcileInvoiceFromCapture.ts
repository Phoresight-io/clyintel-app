import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
import { deriveInvoiceStatus } from "./invoiceStatus";
import { computeBalanceEvent } from "../balanceEvents/computeBalanceEvent";

// Capture-time invoice reconciliation (Gap 1). The frozen detection core writes
// ONLY rev_share_ledger (the fee) and is invoice-blind; nothing else reconciled
// the local operational tables, so a QBO off-platform payment left the invoices
// row stale (still overdue/unpaid, in_recovery set) until the next full
// runQboSync. This step — invoked by the QBO worker AFTER a successful capture —
// writes the payment back to the local invoice + balance_events.
//
// It NEVER touches the frozen core, rev_share_ledger, or computeRevShareFee. It
// reuses the SAME pure helpers runQboSync uses (deriveInvoiceStatus,
// computeBalanceEvent) so a capture-time reconcile and a later full sync converge
// on identical values — idempotent-by-recompute, never double-counting.
//
// No clients rollup writes: the FE derives Total Outstanding / Recovered by
// read-time sum over invoices (see lib/adapters.ts), and the stored clients.total_*
// columns are unread and unwritten dead columns — writing them would add risk for
// zero benefit.
//
// Relative imports (not the @/ alias) match the capture/money-path convention so
// alias-less vitest can load and mock the seams directly.

/** QBO-derived figures the capture adapter already fetched (a typed sibling of
 *  the frozen CaptureEvent — the reconcile data rides its own channel). */
export interface ReconcileInput {
  subscriberId: string;
  /** QBO invoice Id = invoices.external_id for source='qbo'. */
  qboInvoiceId: string;
  /** round(invoice.TotalAmt * 100). */
  invoiceFaceCents: number;
  /** round(invoice.Balance * 100); face value when QBO Balance is absent. */
  invoiceBalanceCents: number;
  /** invoice.DueDate (YYYY-MM-DD) or null. */
  dueDate: string | null;
}

export type ReconcileStatus = "reconciled" | "invoice_not_found";

export interface ReconcileResult {
  status: ReconcileStatus;
  /** true iff this call recorded a balance-drop row (false on a no-op / re-run). */
  balanceEventEmitted: boolean;
}

export async function reconcileInvoiceFromCapture(
  input: ReconcileInput,
  service: Pick<SupabaseClient, "from"> = getSupabase(),
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const { subscriberId, qboInvoiceId, invoiceFaceCents, invoiceBalanceCents, dueDate } = input;

  // 1. Resolve the local invoice row (subscriber-scoped, source='qbo'). Read the
  //    CURRENT outstanding + reminder_count BEFORE overwriting them — the pre-
  //    update outstanding is the balance-drop anchor of last resort.
  const { data: inv, error: invErr } = await service
    .from("invoices")
    .select("id, amount_outstanding_cents, reminder_count")
    .eq("subscriber_id", subscriberId)
    .eq("source", "qbo")
    .eq("external_id", qboInvoiceId)
    .maybeSingle();
  if (invErr) {
    throw new Error(`reconcileInvoiceFromCapture: invoice lookup failed for ${qboInvoiceId}: ${invErr.message}`);
  }
  if (!inv) {
    // Not synced locally yet (a payment on an invoice the intake hasn't pulled).
    // Nothing to reconcile; a later runQboSync brings it in. Not an error.
    console.warn(
      `reconcileInvoiceFromCapture: no local qbo invoice for external_id ${qboInvoiceId} ` +
        `(subscriber ${subscriberId}); skipping`,
    );
    return { status: "invoice_not_found", balanceEventEmitted: false };
  }
  const invoiceId = inv.id as string;

  // 2. Recompute from QBO's authoritative figures — the SAME math runQboSync uses
  //    (clamp paid to [0, face]; amount_outstanding_cents is GENERATED = face −
  //    paid), so a later full sync writes identical values. No increment-by-delta.
  const face = invoiceFaceCents;
  const balance = invoiceBalanceCents;
  const paidCents = Math.max(0, Math.min(face, face - balance));
  const newOutstandingCents = face - paidCents; // = clamp(0, face, balance)
  const todayIso = now.toISOString().slice(0, 10);
  const status = deriveInvoiceStatus(face, balance, dueDate, todayIso);

  // 3. Balance-drop anchor, read BEFORE the invoice update: last balance_events
  //    new_outstanding for this invoice (durable monotonic ledger) overrides the
  //    invoice's current outstanding. Reading the ledger first is what keeps the
  //    co-emit idempotent across a re-run AND a later full sync (which uses the
  //    same anchor precedence): once the drop is recorded, prev == new → no
  //    further event.
  let prevOutstandingCents: number | null = inv.amount_outstanding_cents ?? null;
  const { data: lastEv, error: evErr } = await service
    .from("balance_events")
    .select("new_outstanding_cents")
    .eq("invoice_id", invoiceId)
    .order("detected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (evErr) {
    // Best-effort override; keep the invoice-seeded anchor on failure so a
    // first-observation drop still emits. Log only, never abort.
    console.error(
      `reconcileInvoiceFromCapture: balance_events anchor read failed (${invoiceId}); using invoice anchor`,
      evErr,
    );
  } else if (lastEv && typeof lastEv.new_outstanding_cents === "number") {
    prevOutstandingCents = lastEv.new_outstanding_cents;
  }

  // 4. Co-emit the balance_event FIRST, THEN update the invoice. Event-first means
  //    a mid-write failure can never advance the invoice's outstanding past an
  //    un-recorded drop (which would lose it permanently — the anchor would move).
  //    HARD REQUIREMENT: the drop must be recorded, or the monotonic ledger lies.
  const eventRow = computeBalanceEvent({
    subscriberId,
    invoiceId,
    source: "qbo",
    prevOutstandingCents,
    newOutstandingCents,
    reminderCount: inv.reminder_count ?? 0,
    syncedAt: now.toISOString(),
  });
  let balanceEventEmitted = false;
  if (eventRow) {
    const { error: emitErr } = await service.from("balance_events").insert(eventRow);
    if (emitErr) {
      throw new Error(`reconcileInvoiceFromCapture: balance_events insert failed (${invoiceId}): ${emitErr.message}`);
    }
    balanceEventEmitted = true;
  }

  // 5. Reconcile the invoice to QBO reality. amount_outstanding_cents is a
  //    GENERATED column (amount_cents − amount_paid_cents) — writing it errors, so
  //    it's omitted and self-corrects. in_recovery is cleared here — even
  //    runQboSync never clears it, so the capture-time reconcile is the only path
  //    that does.
  const { error: updErr } = await service
    .from("invoices")
    .update({
      status,
      amount_paid_cents: paidCents,
      in_recovery: false,
      updated_at: now.toISOString(),
    })
    .eq("id", invoiceId);
  if (updErr) {
    throw new Error(`reconcileInvoiceFromCapture: invoice update failed (${invoiceId}): ${updErr.message}`);
  }

  return { status: "reconciled", balanceEventEmitted };
}
