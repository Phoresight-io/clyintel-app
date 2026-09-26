// Auto-populate core: make sure a client's score is fresh before the page renders.
// Replaces the manual "Score this client" button.
//
// Rules:
//   - Only runs when the client has >= 1 non-draft invoice.
//   - The stored score is stale (and gets rewritten) when:
//       no latest row
//       || latest.score_date !== today's UTC date      (daily refresh)
//       || latest.inputs.version !== SCORER_VERSION    (scorer changed)
//     A row with no version counts as stale, so every pre-version row is rescored
//     once. Otherwise the existing rows are returned untouched.
//   - Writes through scoreClient in "write" mode (ownership gate, upsert
//     onConflict client_id,score_month), so ptr_scores is the only write target.
//     A daily rescore in the same month overwrites that month's row: each month
//     keeps its last score, and the prior-month trend is unaffected.
//   - insufficient_data (422) or not owned (404) → returns the existing rows.
//   - NEVER throws: any error is logged and the existing rows are returned, so a
//     scoring failure never blocks the page render.
//
// Pure over injected deps. The real wiring (getPtrScores + makeScorePort over the
// service-role client) is ensureCurrentScore in lib/data.ts.

import type { PtrScorePair } from "../adapters";
import type { Database } from "../../types/supabase";
import { scoreClient, type ScorePort } from "./scoreClient";
import { SCORER_VERSION } from "./scoreBands";
import { utcYmd } from "./dates";

type InvoiceStatus = Database["public"]["Enums"]["invoice_status"];

export interface EnsureScoreDeps {
  readScores(): Promise<PtrScorePair>;
  port: ScorePort;
  now: Date;
}

const EMPTY: PtrScorePair = { latest: null, prior: null };

function storedVersion(inputs: unknown): unknown {
  return typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
    ? (inputs as Record<string, unknown>).version
    : undefined;
}

// True when the stored score must be recomputed (see the rules above).
export function isScoreStale(latest: PtrScorePair["latest"], now: Date): boolean {
  return (
    !latest ||
    latest.score_date !== utcYmd(now) ||
    storedVersion(latest.inputs) !== SCORER_VERSION
  );
}

export async function ensureCurrentScoreCore(
  args: { userId: string; clientId: string; invoices: { status: InvoiceStatus }[] },
  deps: EnsureScoreDeps,
): Promise<PtrScorePair> {
  let existing = EMPTY;
  try {
    existing = await deps.readScores();

    if (!isScoreStale(existing.latest, deps.now)) return existing;
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
