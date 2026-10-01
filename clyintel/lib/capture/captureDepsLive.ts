import { getSupabase } from "../supabase";
import { outreachStartedBy } from "../balanceEvents/computeBalanceEvent";
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

// Payment-source registry slug for QuickBooks captures. QBO payments carry only
// a DATE (TxnDate), so their outreach cutoff is the end of that day (below).
const QBO_SOURCE = "qbo";

/** Per-payment context for the outreach gate. The frozen core calls
 *  getInvoiceAttribution(subscriberId, sourceInvoiceId) WITHOUT the payment time,
 *  so deps are built once per CaptureEvent and carry it here instead. */
export interface LiveCaptureDepsOptions {
  /** CaptureEvent.capturedAt of the payment being gated. */
  paymentAt: string;
  /** CaptureEvent.source — decides how paymentAt is read (date-only for 'qbo'). */
  source: string;
}

/**
 * The latest instant outreach may have started and still make THIS payment
 * billable (LOCKED RULE: outreach on any channel started before the payment →
 * billable; no time window). null = unparseable payment time → gate fails closed.
 *
 *  - qbo: capturedAt is the payment's TxnDate (a DATE, normalized to 00:00Z by the
 *    adapter). Cutoff = the END of that calendar day in UTC (23:59:59.999Z), so
 *    same-day outreach counts and outreach on any later day never does. UTC because
 *    no company/subscriber timezone is stored (the same seam runCadence documents)
 *    and the frozen QBO client exposes only TxnDate; it is also the frame capturedAt
 *    and cycle_close already use. For a company WEST of UTC (all US subscribers) the
 *    UTC day ends before the local day does, so this can never count outreach from a
 *    later local day — it can only miss same-local-day outreach sent in the local
 *    evening after 00:00Z (under-bill, never over-bill).
 *  - anything else (stripe_recovery): capturedAt is a real event timestamp → used as-is.
 */
export function outreachCutoff(source: string, paymentAt: string): string | null {
  const ms = Date.parse(paymentAt);
  if (Number.isNaN(ms)) return null;
  if (source !== QBO_SOURCE) return new Date(ms).toISOString();
  const d = new Date(ms);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  ).toISOString();
}

export function createLiveCaptureDeps(opts: LiveCaptureDepsOptions): CaptureDeps {
  const service = getSupabase();
  const cutoff = outreachCutoff(opts.source, opts.paymentAt);

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
      // lib/outreach/markOutreachStarted) is set AND at or before this payment's
      // cutoff. recovery_attempts / communications are deliberately NOT read: the
      // Brick-A SIMULATION rows there (sent_at set, no real send) must never bill.
      if (cutoff == null) {
        console.warn(
          `captureDepsLive.getInvoiceAttribution: unparseable paymentAt "${opts.paymentAt}" ` +
            `(source=${opts.source}); treating outreach as not sent`,
        );
        return { found: true, outreachSent: false };
      }
      return {
        found: true,
        outreachSent: outreachStartedBy(invoices[0].outreach_started_at ?? null, cutoff),
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
