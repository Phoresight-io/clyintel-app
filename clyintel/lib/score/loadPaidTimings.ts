// Shared reader for normalized paid-in-full dates. Used by the scorer's loader
// (loadScoreInputs) and by the client page's Paid-date column, so both show the
// same date for an invoice.
//
// Uses the service-role client, which bypasses RLS, so every read filters by
// subscriber_id explicitly:
//   invoice_payments → payments.paid_at, status = 'succeeded', payments.subscriber_id
//   balance_events   subscriber_id + invoice_id IN paidInvoiceIds,
//                    new_outstanding_cents = 0 (balance_events has no client_id)
// resolvePaidTimings applies the source precedence. Any read error throws.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import {
  resolvePaidTimings,
  type BalanceEventTimingRow,
  type PaidTiming,
  type PaymentTimingRow,
} from "./resolvePaidTimings";

export async function loadPaidTimings(
  db: SupabaseClient<Database>,
  subscriberId: string,
  paidInvoiceIds: string[],
): Promise<PaidTiming[]> {
  if (paidInvoiceIds.length === 0) return [];

  const [payRes, evRes] = await Promise.all([
    db
      .from("invoice_payments")
      .select("invoice_id, payments!inner(paid_at, status, subscriber_id)")
      .in("invoice_id", paidInvoiceIds)
      .eq("payments.status", "succeeded")
      .eq("payments.subscriber_id", subscriberId),
    db
      .from("balance_events")
      .select("invoice_id, detected_at, new_outstanding_cents, evidence")
      .eq("subscriber_id", subscriberId)
      .in("invoice_id", paidInvoiceIds)
      .eq("new_outstanding_cents", 0),
  ]);
  if (payRes.error) throw new Error(`score: payments load failed: ${payRes.error.message}`);
  if (evRes.error) throw new Error(`score: balance_events load failed: ${evRes.error.message}`);

  const payments: PaymentTimingRow[] = (payRes.data ?? []).map((r) => {
    const p = r.payments as unknown as { paid_at: string | null } | { paid_at: string | null }[] | null;
    const one = Array.isArray(p) ? p[0] : p;
    return { invoice_id: r.invoice_id, paid_at: one?.paid_at ?? null };
  });
  const balanceEvents = (evRes.data ?? []) as BalanceEventTimingRow[];

  return resolvePaidTimings(paidInvoiceIds, payments, balanceEvents);
}
