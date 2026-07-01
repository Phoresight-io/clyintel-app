import { getSupabase } from "../supabase";
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

export function createLiveCaptureDeps(): CaptureDeps {
  const service = getSupabase();

  return {
    async resolveSubscriber(ref) {
      // ref is the realmId (connectedAccountRef). Canonical join:
      // connected_accounts.external_id → subscriber_id. No uniqueness
      // constraint on external_id, so defend against >1 (no .single()).
      const { data, error } = await service
        .from("connected_accounts")
        .select("subscriber_id")
        .eq("provider", "quickbooks")
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
        .select("id")
        .eq("external_id", sourceInvoiceId)
        .eq("source", "qbo")
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
      const invId = invoices[0].id;

      // outreachSent = a sent recovery_attempt OR a sent outbound communication.
      // Short-circuit: if either has a sent_at row, we're done.
      const { data: ra, error: raErr } = await service
        .from("recovery_attempts")
        .select("id")
        .eq("invoice_id", invId)
        .not("sent_at", "is", null)
        .limit(1);
      if (raErr) {
        throw new Error(`getInvoiceAttribution recovery_attempts check failed: ${raErr.message}`);
      }
      if (ra && ra.length > 0) {
        return { found: true, outreachSent: true };
      }

      const { data: comm, error: commErr } = await service
        .from("communications")
        .select("id")
        .eq("invoice_id", invId)
        .eq("direction", "outbound")
        .not("sent_at", "is", null)
        .limit(1);
      if (commErr) {
        throw new Error(`getInvoiceAttribution communications check failed: ${commErr.message}`);
      }

      return { found: true, outreachSent: !!(comm && comm.length > 0) };
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
      const { data, error } = await service
        .from("rev_share_ledger")
        .insert(row)
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
