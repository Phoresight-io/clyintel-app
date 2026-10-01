import { getSupabase } from "../supabase";
import { isOutreachBeforePayment } from "./outreachBeforePayment";
import type { CaptureDeps, LedgerInsert } from "./captureDeps";

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

// Payment-source registry slug for QuickBooks captures. QBO payment time is the
// Payment's MetaData.CreateTime, falling back to its date-only TxnDate (below).
const QBO_SOURCE = "qbo";

/** Per-payment context for the outreach gate. The frozen core calls
 *  getInvoiceAttribution(subscriberId, sourceInvoiceId) WITHOUT the payment time,
 *  so deps are built once per CaptureEvent and carry it here instead. */
export interface LiveCaptureDepsOptions {
  /** CaptureEvent.capturedAt of the payment being gated (qbo: TxnDate at 00:00Z). */
  paymentAt: string;
  /** CaptureEvent.source — decides how the payment time is read. */
  source: string;
  /** qbo only: QBO Payment MetaData.CreateTime (when the payment was recorded in
   *  QuickBooks), or null/omitted when absent or unparseable. */
  paymentRecordedAt?: string | null;
}

function parses(value: string | null): boolean {
  return value != null && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

/**
 * The payment times handed to isOutreachBeforePayment (LOCKED RULE, 2026-09-30:
 * fee only if the outreach timestamp is BEFORE the payment timestamp).
 *
 *  - qbo: recordedAt = MetaData.CreateTime (strict instant compare). Absent or
 *    unparseable → txnDate = capturedAt (the TxnDate): outreach's UTC date must be
 *    strictly before it, so same-day outreach is NOT billable (it may have been
 *    sent after the client paid). Neither → no fee.
 *  - anything else (stripe_recovery): capturedAt is a real event timestamp →
 *    strict instant compare against it. No date fallback.
 */
export function paymentTimesFor(opts: LiveCaptureDepsOptions): {
  recordedAt: string | null;
  txnDate: string | null;
} {
  if (opts.source === QBO_SOURCE) {
    return { recordedAt: opts.paymentRecordedAt ?? null, txnDate: opts.paymentAt };
  }
  return { recordedAt: opts.paymentAt, txnDate: null };
}

export function createLiveCaptureDeps(opts: LiveCaptureDepsOptions): CaptureDeps {
  const service = getSupabase();
  const payment = paymentTimesFor(opts);
  const paymentTimeKnown = parses(payment.recordedAt) || parses(payment.txnDate);

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
      // NOT a local uuid. Resolve the local invoice row (which carries the
      // outreach marker) by external_id + source + subscriber.
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
      // outreachSent = the invoice's write-once outreach marker (first REAL contact
      // on any channel: MailerSend-accepted email or Vapi-accepted call — see
      // lib/outreach/markOutreachStarted) is set AND strictly before this payment
      // (see paymentTimesFor). recovery_attempts / communications are deliberately
      // NOT read: the Brick-A SIMULATION rows there (sent_at set, no real send)
      // must never bill.
      if (!paymentTimeKnown) {
        console.warn(
          `captureDepsLive.getInvoiceAttribution: no usable payment time ` +
            `(paymentAt="${opts.paymentAt}", paymentRecordedAt="${opts.paymentRecordedAt ?? ""}", ` +
            `source=${opts.source}); treating outreach as not sent`,
        );
        return { found: true, outreachSent: false };
      }
      return {
        found: true,
        outreachSent: isOutreachBeforePayment(
          invoices[0].outreach_started_at ?? null,
          payment.recordedAt,
          payment.txnDate,
        ),
      };
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
