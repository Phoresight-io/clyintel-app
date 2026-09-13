import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkCronAuth } from "@/lib/qbo/worker";
import { runSettlementSweep } from "@/lib/settlement/runSweep";
import { drainSettlements } from "@/lib/settlement/chargeSettlement";
import { mostRecentClosedCycleClose } from "@/lib/settlement/cycleBoundary";

// Monthly Settlement Sweep — scheduled entry point (Prompt 4). Runs the two
// stages back to back:
//   1. runSettlementSweep(boundary, dryRun=false) — persist PENDING settlements
//      for the most recently CLOSED cycle (gated by settlement_sweep_enabled).
//   2. drainSettlements(dryRun=false) — charge pending/retryable settlements
//      (gated by settlement_charging_enabled + the env/live gate + single-flight).
//
// dryRun=false only expresses INTENT. Whether anything is actually written or
// charged is still decided by the existing gates (app_config flags, VERCEL_ENV=
// production + sk_live). In any non-prod/preview context both stages fall back to
// compute-and-log. See lib/settlement/chargeSettlement.ts for the gate details.
//
// Auth: a dedicated SETTLEMENT_CRON_SECRET via Authorization: Bearer (constant-
// time compare in checkCronAuth). Distinct from QBO_WORKER_CRON_SECRET so the two
// crons don't share a credential. The secret is never logged or echoed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron issues a GET; POST is accepted for manual/observability triggers.
export async function GET(req: NextRequest) {
  return runSettlementCron(req);
}
export async function POST(req: NextRequest) {
  return runSettlementCron(req);
}

async function runSettlementCron(req: NextRequest) {
  // Auth FIRST — never do work before it passes.
  const auth = checkCronAuth(req.headers.get("authorization"), process.env.SETTLEMENT_CRON_SECRET);
  if (auth === "missing_secret") {
    console.error("settlement/cron: SETTLEMENT_CRON_SECRET not configured");
    return new NextResponse("server error", { status: 500 });
  }
  if (auth === "unauthorized") {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const service = getSupabase();

  // Settle the most recently CLOSED cycle — never the forward-looking next 15th.
  const boundary = mostRecentClosedCycleClose();

  // 1. Persist. dryRun=false; settlement_sweep_enabled still gates the write.
  const sweep = await runSettlementSweep({ boundary, dryRun: false }, service);

  // 2. Charge. dryRun=false; settlement_charging_enabled + env/live gate + claim
  //    still decide whether any card is touched.
  const charge = await drainSettlements({ dryRun: false }, service);

  // Compact summary — counts + gate flags only, no secrets and no PII beyond ids.
  return NextResponse.json(
    {
      boundary,
      persist: {
        sweepEnabled: sweep.sweepEnabled,
        wrote: sweep.wrote,
        eligibleRows: sweep.eligibleRowCount,
        billable: sweep.billable.length,
        carried: sweep.carried.length,
        persisted: sweep.persisted?.length ?? 0,
      },
      charge: {
        chargingEnabled: charge.chargingEnabled,
        liveEnv: charge.liveEnv,
        charging: charge.charging,
        candidates: charge.candidates,
        charged: charge.charged,
        failed: charge.failed,
        skipped: charge.skipped,
      },
    },
    { status: 200 },
  );
}
