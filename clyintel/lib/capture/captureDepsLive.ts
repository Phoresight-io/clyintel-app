import { getSupabase } from "../supabase";
import type { CaptureDeps, LedgerInsert } from "./captureDeps";
import { isOutreachBeforePayment } from "./outreachBeforePayment";

// Live, Supabase-backed CaptureDeps — the first real implementation of the
// detection core's dependency seam. The worker (later step) injects this into
// processCaptureEvent. This module ONLY implements the four seam methods; it
// never calls the core, the adapter, or the webhook route.
//
// All access uses the service-role client: rev_share_ledger is
// service-role-write-only under RLS, so anon/authenticated would be blocked.
//
// Namespacing: connected_accounts.provider is the enum value 'quickbooks';
// the capture source slug is 'qbo'. resolveSubscriber filters provider =
// 'quickbooks'; the invoice bridge filters invoices.source = 'qbo'.
//
// PAYMENT source vs INVOICE source: a recovery payment can arrive on the Stripe
// rail (CaptureEvent.source = 'stripe_recovery'), but the invoice it settles is
// still a QuickBooks invoice reached through the subscriber's QBO connection.
// Subscriber + invoice resolution therefore stay source-INDEPENDENT — always the
// QBO connection below — while only the ledger's `source` and the invoice_number
// enrichment key off the payment source.

// Invoice/connection namespace — resolution routes through the QBO connection
// regardless of which rail took the payment. Values are unchanged from the
// previous inline literals, so the 'qbo' path behaves identically.
const INVOICE_CONNECTION_PROVIDER = "quickbooks"; // connected_accounts.provider
const INVOICE_SOURCE = "qbo"; // invoices.source

// Payment-source registry slug for Stripe-mediated recovery captures. Only the
// insert path keys off this (ledger.source + invoice_number enrichment).
const STRIPE_RECOVERY_SOURCE = "stripe_recovery";

// Per-payment context for the fee gate (locked rules, 2026-09-30). The frozen
// core never passes the payment time into getInvoiceAttribution, so the caller
// builds ONE deps instance per captured payment and closes over its times here.
//   paymentRecordedAt  QBO Payment MetaData.CreateTime (preferred)
//   paymentTxnDate     QBO Payment TxnDate (date-only fallback)
// No opts (or neither time) → outreachSent is always false → no fee. That is how
// the stripe_recovery rail fails closed (recovery-link collection is off).
export interface LiveCaptureDepsOpts {
  paymentRecordedAt?: string | null;
  paymentTxnDate?: string | null;
}

export function createLiveCaptureDeps(opts: LiveCaptureDepsOpts = {}): CaptureDeps {
  const service = getSupabase();
  const paymentRecordedAt = opts.paymentRecordedAt ?? null;
  const paymentTxnDate = opts.paymentTxnDate ?? null;

  return {
    async resolveSubscriber(ref) {
      // ref is the realmId (connectedAccountRef). Canonical join:
      // connected_accounts.external_id → subscriber_id. No uniqueness
      // constraint on external_id, so defend against >1 (no .single()).
      const { data, error } = await service
        .from("connected_accounts")
        .select("subscriber_id")
        .eq("provider", INVOICE_CONNECTION_PROVIDER)
        .eq("external_id", ref);

      if (error) {
        throw new Error(`resolveSubscriber lookup failed for ref ${ref}: ${error.message}`);
      }
      if (!data || data.length === 0) {
        return { ok: false, reason: "subscriber_not_found" };
      }
      if (data.length > 1) {
        return { ok: false, reason: "ambiguous_subscriber" };
      }
      return { ok: true, subscriberId: data[0].subscriber_id };
    },

    async getSource(slug) {
      const { data, error } = await service
        .from("capture_sources")
        .select("id, active")
        .eq("id", slug)
        .maybeSingle();

      if (error) {
        throw new Error(`getSource lookup failed for slug ${slug}: ${error.message}`);
      }
      if (!data) return null;
      return { id: data.id, active: data.active };
    },

    async getInvoiceAttribution(subscriberId, sourceInvoiceId) {
      // INVOICE-ID BRIDGE: sourceInvoiceId is the QBO Invoice Id (e.g. "130"),
      // NOT a local uuid. The outreach tables key on the local invoice uuid, so
      // translate QBO id → local uuid first.
      const { data: invoices, error: invErr } = await service
        .from("invoices")
        .select("id, outreach_started_at")
        .eq("external_id", sourceInvoiceId)
        .eq("source", INVOICE_SOURCE)
        .eq("subscriber_id", subscriberId);

      if (invErr) {
        throw new Error(
          `getInvoiceAttribution invoice lookup failed (${sourceInvoiceId}): ${invErr.message}`,
        );
      }
      if (!invoices || invoices.length === 0) {
        return { found: false, outreachSent: false };
      }
      if (invoices.length > 1) {
        // No uniqueness constraint on invoices.external_id — do not silently
        // pick one. Treat ambiguity as not-found so nothing is attributed.
        console.warn(
          `captureDepsLive.getInvoiceAttribution: ${invoices.length} local invoices match ` +
            `external_id=${sourceInvoiceId} source=qbo subscriber=${subscriberId}; ` +
            `treating as not found`,
        );
        return { found: false, outreachSent: false };
      }

      // outreachSent = outreach STARTED before THIS payment. The only outreach
      // source is the write-once invoices.outreach_started_at marker (stamped on
      // a live email send with a MailerSend id, or a placed voice call).
      // recovery_attempts / communications are deliberately NOT read: Brick-A
      // SIMULATION attempts carry sent_at with no real send, and neither table
      // was time-checked against the payment.
      const outreachSent = isOutreachBeforePayment(
        invoices[0].outreach_started_at ?? null,
        paymentRecordedAt,
        paymentTxnDate,
      );
      return { found: true, outreachSent };
    },

    async isSubscriberActive(subscriberId) {
      const { data, error } = await service
        .from("subscribers")
        .select("subscription_status")
        .eq("id", subscriberId)
        .maybeSingle();

      if (error) {
        throw new Error(`isSubscriberActive lookup failed for ${subscriberId}: ${error.message}`);
      }
      // Missing subscriber → not active.
      return data?.subscription_status === "active";
    },

    async insertLedgerRow(row: LedgerInsert) {
      // Enrichment seam (deps-owned — the frozen core builds `row` without an
      // invoice_number field; this layer owns the actual write and may add
      // columns). GATED to the Stripe recovery rail: for source ===
      // 'stripe_recovery' we stamp the human invoice_number onto the ledger row.
      // The QBO path is left byte-identical (no invoice_number key → column stays
      // null), so it is unaffected before or after the pending migration.
      let payload: LedgerInsert & { invoice_number?: string | null } = row;
      if (row.source === STRIPE_RECOVERY_SOURCE) {
        // Re-resolve the local invoice the same way getInvoiceAttribution does
        // (external_id + invoice source + subscriber). Stateless — no reliance on
        // an earlier call. 0 or >1 matches → leave null (never guess).
        const { data: inv, error: invErr } = await service
          .from("invoices")
          .select("invoice_number")
          .eq("external_id", row.source_invoice_id)
          .eq("source", INVOICE_SOURCE)
          .eq("subscriber_id", row.subscriber_id);
        if (invErr) {
          throw new Error(
            `insertLedgerRow invoice_number lookup failed (${row.source_invoice_id}): ${invErr.message}`,
          );
        }
        const invoiceNumber = inv && inv.length === 1 ? (inv[0].invoice_number ?? null) : null;
        payload = { ...row, invoice_number: invoiceNumber };
      }

      const { data, error } = await service
        .from("rev_share_ledger")
        .insert(payload)
        .select("id")
        .single();

      if (!error) {
        return { inserted: true, id: data.id };
      }

      // Unique-violation on (source, source_payment_id) → the payment was
      // already captured. Detect by Postgres error CODE, not message text.
      if (error.code === "23505") {
        const { data: existing, error: selErr } = await service
          .from("rev_share_ledger")
          .select("id")
          .eq("source", row.source)
          .eq("source_payment_id", row.source_payment_id)
          .single();
        if (selErr || !existing) {
          throw new Error(
            `insertLedgerRow: conflict on (${row.source}, ${row.source_payment_id}) but ` +
              `existing-row lookup failed: ${selErr?.message ?? "no row"}`,
          );
        }
        return { inserted: false, existingId: existing.id };
      }

      // Any other DB error → throw so the worker marks the event failed/retry.
      throw new Error(`insertLedgerRow failed: ${error.message}`);
    },
  };
}
