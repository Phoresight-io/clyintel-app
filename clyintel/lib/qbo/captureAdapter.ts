import type { CaptureEvent } from "../capture/captureEvent";
import { getSupabase } from "../supabase";
import { getValidAccessToken } from "./tokens";
import { getPayment, getInvoice, linkedInvoiceIds } from "./client";

// QBO → CaptureEvent adapter. Turns a QBO Payment notification (realmId +
// paymentId) into the platform-agnostic CaptureEvent the detection core
// consumes. It ONLY produces the event — it does not run processCaptureEvent,
// implement CaptureDeps, or write webhook_events / rev_share_ledger. The worker
// (later step) calls this, then hands the result to the core.
//
// Namespacing caution: the connected_accounts.provider enum value is
// 'quickbooks'; the capture source slug is 'qbo'. Different namespaces — the
// realm→subscriber lookup filters on provider='quickbooks', while the emitted
// CaptureEvent.source is 'qbo'.
//
// Units: QBO returns DOLLARS. CaptureEvent is DOLLARS. No /100 conversion.

/**
 * Adapter-owned past-due rule (locked): the invoice was past-due iff it had a
 * due date that fell strictly before the payment date — "was it already overdue
 * at the moment it was paid." Reference is the PAYMENT DATE (TxnDate), not
 * today. A missing due date can't establish past-due → false. Pure + exported
 * so it's unit-testable.
 */
export function resolveInvoicePastDue(
  dueDate: string | null | undefined,
  txnDate: string,
): boolean {
  if (dueDate == null) return false;
  return new Date(dueDate) < new Date(txnDate);
}

export async function buildCaptureEventFromPayment(
  realmId: string,
  paymentId: string,
): Promise<CaptureEvent> {
  // 1. realm → subscriber. The webhook gives us realmId; getValidAccessToken
  //    needs a subscriberId. There is NO uniqueness constraint on
  //    connected_accounts.external_id, so defend against >1 (no maybeSingle).
  const service = getSupabase();
  const { data: rows, error } = await service
    .from("connected_accounts")
    .select("subscriber_id")
    .eq("provider", "quickbooks")
    .eq("external_id", realmId);

  if (error) {
    throw new Error(`connected_accounts lookup failed for realmId ${realmId}: ${error.message}`);
  }
  if (!rows || rows.length === 0) {
    throw new Error(`no subscriber for realmId ${realmId}`);
  }
  if (rows.length > 1) {
    throw new Error(`ambiguous subscriber for realmId ${realmId}`);
  }
  const subscriberId = rows[0].subscriber_id;

  // 2. token. Resolve/refresh via the locked token seam. Its realmId is derived
  //    from the same connected_accounts row, so it must equal our incoming one.
  const { accessToken, realmId: tokenRealmId } = await getValidAccessToken(subscriberId);
  if (tokenRealmId !== realmId) {
    throw new Error(
      `realmId mismatch for subscriber ${subscriberId}: webhook ${realmId} vs token ${tokenRealmId}`,
    );
  }

  // 3. fetch payment.
  const payment = await getPayment(realmId, paymentId, accessToken);

  // 4. resolve linked invoice.
  const invoiceIds = linkedInvoiceIds(payment);
  if (invoiceIds.length === 0) {
    throw new Error(`payment ${paymentId} links no invoice`);
  }
  if (invoiceIds.length > 1) {
    // D2 scope: multi-invoice payments are NOT yet split across invoices. Take
    // the first and warn rather than silently dropping the rest. Proper
    // allocation is future work.
    console.warn(
      `qbo/captureAdapter: payment ${paymentId} links ${invoiceIds.length} invoices ` +
        `(${invoiceIds.join(", ")}); D2 attributes only the first (${invoiceIds[0]}) — ` +
        `multi-invoice split not yet implemented`,
    );
  }
  const invoiceId = invoiceIds[0];

  // 5. fetch invoice.
  const invoice = await getInvoice(realmId, invoiceId, accessToken);

  // 6. resolve past-due against the payment date (adapter-owned rule).
  const invoicePastDue = resolveInvoicePastDue(invoice.DueDate, payment.TxnDate);

  // 7. assemble CaptureEvent (DOLLARS — no /100).
  const invoiceFaceValue = invoice.TotalAmt;
  const dollarsRecovered = payment.TotalAmt;
  for (const [label, value] of [
    ["invoiceFaceValue", invoiceFaceValue],
    ["dollarsRecovered", dollarsRecovered],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `QBO payment ${paymentId}/invoice ${invoiceId}: ${label} is not a finite number >= 0 (got ${value})`,
      );
    }
  }

  // TxnDate is a QBO date (YYYY-MM-DD); normalize to an ISO 8601 timestamp.
  const capturedAtMs = new Date(payment.TxnDate).getTime();
  if (Number.isNaN(capturedAtMs)) {
    throw new Error(`QBO payment ${paymentId}: unparseable TxnDate "${payment.TxnDate}"`);
  }
  const capturedAt = new Date(capturedAtMs).toISOString();

  return {
    source: "qbo",
    sourcePaymentId: payment.Id,
    sourceInvoiceId: invoice.Id,
    invoicePastDue,
    invoiceFaceValue,
    dollarsRecovered,
    capturedAt,
    // Pass realmId (NOT subscriberId): the core re-resolves the subscriber via
    // its locked resolveSubscriber seam, keeping one source of truth for the join.
    connectedAccountRef: realmId,
  };
}
