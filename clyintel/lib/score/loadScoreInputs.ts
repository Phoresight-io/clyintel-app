// Loader for the Client Score scorer. Uses the service-role client and filters
// every read by BOTH subscriber_id and client_id, because the service client
// bypasses RLS. The route proves ownership (clients by id + subscriber_id)
// before calling this.
//
// Reads:
//   invoices          subscriber_id + client_id
//   invoice_payments  → payments.paid_at for those invoices, status = 'succeeded'
//                       only, payments also filtered by subscriber_id
//   communications    subscriber_id + client_id
//   prior ptr_scores  latest row from an EARLIER score_month (text 'YYYY-MM')
//
// Any read error throws. The route turns that into a 500 and writes nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import type { PaidTiming, PriorScore, ScoreComm, ScoreInputs, ScoreInvoice } from "./computeClientScore";

type Db = SupabaseClient<Database>;

export async function loadScoreInputs(
  db: Db,
  subscriberId: string,
  clientId: string,
  asOf: Date,
): Promise<ScoreInputs> {
  const currentMonth = asOf.toISOString().slice(0, 7);

  const [invRes, commRes, priorRes] = await Promise.all([
    db
      .from("invoices")
      .select("id, status, due_date, issue_date, created_at, amount_cents, amount_outstanding_cents")
      .eq("subscriber_id", subscriberId)
      .eq("client_id", clientId),
    db
      .from("communications")
      .select("invoice_id, direction, sent_at, created_at, reply_received_at")
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
  if (commRes.error) throw new Error(`score: communications load failed: ${commRes.error.message}`);
  if (priorRes.error) throw new Error(`score: prior score load failed: ${priorRes.error.message}`);

  const invoices = (invRes.data ?? []) as ScoreInvoice[];

  let paidTimings: PaidTiming[] = [];
  if (invoices.length > 0) {
    const payRes = await db
      .from("invoice_payments")
      .select("invoice_id, payments!inner(paid_at, status, subscriber_id)")
      .in(
        "invoice_id",
        invoices.map((i) => i.id),
      )
      .eq("payments.status", "succeeded")
      .eq("payments.subscriber_id", subscriberId);
    if (payRes.error) throw new Error(`score: payments load failed: ${payRes.error.message}`);
    paidTimings = (payRes.data ?? []).map((r) => {
      const p = r.payments as unknown as { paid_at: string | null } | { paid_at: string | null }[] | null;
      const one = Array.isArray(p) ? p[0] : p;
      return { invoice_id: r.invoice_id, paid_at: one?.paid_at ?? null };
    });
  }

  return {
    invoices,
    paidTimings,
    comms: (commRes.data ?? []) as ScoreComm[],
    asOf,
    prior: (priorRes.data as PriorScore | null) ?? null,
  };
}
