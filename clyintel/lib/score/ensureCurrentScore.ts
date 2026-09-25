// Auto-populate core: make sure a client has a ptr_scores row for the current UTC
// month before the page renders. Replaces the manual "Score this client" button.
//
// Rules:
//   - Only runs when the client has >= 1 non-draft invoice.
//   - Writes only when the latest row is missing, or its score_month differs from
//     the current UTC 'YYYY-MM'. Otherwise it returns the existing rows untouched.
//   - Writes through scoreClient in "write" mode (ownership gate, upsert
//     onConflict client_id,score_month), so ptr_scores is the only write target.
//   - insufficient_data (422) or not owned (404) → returns the existing rows.
//   - NEVER throws: any error is logged and the existing rows are returned, so a
//     scoring failure never blocks the page render.
//
// Pure over injected deps. The real wiring (getPtrScores + makeScorePort over the
// service-role client) is ensureCurrentScore in lib/data.ts.

import type { PtrScorePair } from "../adapters";
import type { Database } from "../../types/supabase";
import { scoreClient, type ScorePort } from "./scoreClient";

type InvoiceStatus = Database["public"]["Enums"]["invoice_status"];

export interface EnsureScoreDeps {
  readScores(): Promise<PtrScorePair>;
  port: ScorePort;
  now: Date;
}

const EMPTY: PtrScorePair = { latest: null, prior: null };

export async function ensureCurrentScoreCore(
  args: { userId: string; clientId: string; invoices: { status: InvoiceStatus }[] },
  deps: EnsureScoreDeps,
): Promise<PtrScorePair> {
  let existing = EMPTY;
  try {
    existing = await deps.readScores();

    const currentMonth = deps.now.toISOString().slice(0, 7);
    if (existing.latest && existing.latest.score_month === currentMonth) return existing;
    if (!args.invoices.some((inv) => inv.status !== "draft")) return existing;

    const res = await scoreClient(
      { clientId: args.clientId, subscriberId: args.userId, mode: "write", asOf: deps.now },
      deps.port,
    );
    if (res.status !== 200 || res.body.written !== true) return existing;

    return await deps.readScores();
  } catch (e) {
    console.error("ensureCurrentScore failed", { clientId: args.clientId, error: e });
    return existing;
  }
}
