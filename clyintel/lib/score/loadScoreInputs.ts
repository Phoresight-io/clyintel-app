// Loader for the Client Score scorer. Uses the service-role client, which
// bypasses RLS, so every read filters by subscriber_id explicitly. The route
// proves ownership (clients by id + subscriber_id) before calling this.
//
// Reads:
//   invoices          subscriber_id + client_id
//   paid timings      loadPaidTimings (payments + balance_events) for the client's
//                       PAID invoices: one PaidTiming per invoice, so the scorer
//                       never sees where a date came from
//   prior ptr_scores  latest row from an EARLIER score_month (text 'YYYY-MM')
//
// Any read error throws. The route turns that into a 500 and writes nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import type { PriorScore, ScoreInputs, ScoreInvoice } from "./computeClientScore";
import { loadPaidTimings } from "./loadPaidTimings";

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

  return {
    invoices,
    paidTimings: await loadPaidTimings(db, subscriberId, paidIds),
    asOf,
    prior: (priorRes.data as PriorScore | null) ?? null,
  };
}
