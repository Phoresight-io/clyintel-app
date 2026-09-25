// Loader for the Client Score scorer. Uses the service-role client, which
// bypasses RLS, so every read filters by subscriber_id explicitly. The route
// proves ownership (clients by id + subscriber_id) before calling this.
//
// Reads:
//   invoices          subscriber_id + client_id
//   invoice_payments  → payments.paid_at for the client's PAID invoices,
//                       status = 'succeeded', payments filtered by subscriber_id
//   balance_events    subscriber_id + invoice_id IN the client's paid invoices,
//                       new_outstanding_cents = 0 (balance_events has no client_id)
//   prior ptr_scores  latest row from an EARLIER score_month (text 'YYYY-MM')
// resolvePaidTimings turns the payment and balance-event rows into one
// PaidTiming per paid invoice, so the scorer never sees where a date came from.
//
// Any read error throws. The route turns that into a 500 and writes nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import type { PriorScore, ScoreInputs, ScoreInvoice } from "./computeClientScore";
import {
  resolvePaidTimings,
  type BalanceEventTimingRow,
  type PaymentTimingRow,
} from "./resolvePaidTimings";

type Db = SupabaseClient<Database>;

export async function loadScoreInputs(
  db: Db,
  subscriberId: string,
  clientId: string,
  asOf: Date,
): Promise<ScoreInputs> {
  const currentMonth = asOf.toISOString().slice(0, 7);

  const [invRes, priorRes] = await Promise.all([
    db
      .from("invoices")
      .select("id, status, due_date, issue_date, created_at, amount_cents, amount_outstanding_cents")
      .eq("subscriber_id", subscriberId)
      .eq("client_id", clientId),
    db
      .from("ptr_scores")
      .select("composite_score, score_date")
      .eq("subscriber_id", subscriberId)
      .eq("client_id", clientId)
      .lt("score_month", currentMonth)
      .order("score_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (invRes.error) throw new Error(`score: invoices load failed: ${invRes.error.message}`);
  if (priorRes.error) throw new Error(`score: prior score load failed: ${priorRes.error.message}`);

  const invoices = (invRes.data ?? []) as ScoreInvoice[];
  const paidIds = invoices.filter((i) => i.status === "paid").map((i) => i.id);

  let payments: PaymentTimingRow[] = [];
  let balanceEvents: BalanceEventTimingRow[] = [];
  if (paidIds.length > 0) {
    const [payRes, evRes] = await Promise.all([
      db
        .from("invoice_payments")
        .select("invoice_id, payments!inner(paid_at, status, subscriber_id)")
        .in("invoice_id", paidIds)
        .eq("payments.status", "succeeded")
        .eq("payments.subscriber_id", subscriberId),
      db
        .from("balance_events")
        .select("invoice_id, detected_at, new_outstanding_cents, evidence")
        .eq("subscriber_id", subscriberId)
        .in("invoice_id", paidIds)
        .eq("new_outstanding_cents", 0),
    ]);
    if (payRes.error) throw new Error(`score: payments load failed: ${payRes.error.message}`);
    if (evRes.error) throw new Error(`score: balance_events load failed: ${evRes.error.message}`);
    payments = (payRes.data ?? []).map((r) => {
      const p = r.payments as unknown as { paid_at: string | null } | { paid_at: string | null }[] | null;
      const one = Array.isArray(p) ? p[0] : p;
      return { invoice_id: r.invoice_id, paid_at: one?.paid_at ?? null };
    });
    balanceEvents = (evRes.data ?? []) as BalanceEventTimingRow[];
  }

  return {
    invoices,
    paidTimings: resolvePaidTimings(paidIds, payments, balanceEvents),
    asOf,
    prior: (priorRes.data as PriorScore | null) ?? null,
  };
}
