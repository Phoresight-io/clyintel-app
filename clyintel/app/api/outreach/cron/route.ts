import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/qbo/worker";
import { runCadence } from "@/lib/outreach/runCadence";
import { type RunMode } from "@/lib/outreach/parseRunRequest";
import { createDefaultPort } from "@/app/api/outreach/run/route";

// On-demand GET/POST trigger for the cadence engine, configured entirely from env
// vars (no request body). Mirrors the qbo/worker cron pattern (GET + POST +
// checkCronAuth) so it can be fired by hitting a URL — no external API client.
//
// The run port is SHARED with app/api/outreach/run/route.ts (createDefaultPort is
// exported there and imported here) — the candidate-scan + send wiring is defined
// once, not duplicated. Config comes from env, not the body:
//   OUTREACH_CRON_MODE            "live" → live send; anything else → dry_run (fail-safe default)
//   OUTREACH_CRON_SUBSCRIBER_ID   optional subscriber fence
//   OUTREACH_CRON_INVOICE_ID      optional single-invoice fence
// A live cron run MUST be fenced to a subscriber (mirrors the run route's rule).
//
// ⚠️ NO vercel.json cron entry — this is ON-DEMAND ONLY, not scheduled. Auth reuses
// the SAME OUTREACH_RUN_SECRET as the run route (one secret), fail-closed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron (and manual triggers) issue a GET; POST accepted with the same guard.
export async function GET(req: NextRequest) {
  return runOutreachCron(req);
}

export async function POST(req: NextRequest) {
  return runOutreachCron(req);
}

async function runOutreachCron(req: NextRequest) {
  // A. Auth FIRST — never do work before it passes. Same secret as the run route.
  const auth = checkCronAuth(req.headers.get("authorization"), process.env.OUTREACH_RUN_SECRET);
  if (auth === "missing_secret") {
    console.error("outreach/cron: OUTREACH_RUN_SECRET not configured — rejecting (fail-closed)");
    return new NextResponse("server error", { status: 500 });
  }
  if (auth === "unauthorized") {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // B. Config from env (never hardcoded). Default dry_run — a misconfigured or
  // absent OUTREACH_CRON_MODE never silently goes live.
  const mode: RunMode = process.env.OUTREACH_CRON_MODE === "live" ? "live" : "dry_run";
  const subscriberId = process.env.OUTREACH_CRON_SUBSCRIBER_ID || undefined;
  const invoiceId = process.env.OUTREACH_CRON_INVOICE_ID || undefined;

  // C. A live run MUST be fenced to a subscriber (mirrors parseRunRequest's rule).
  if (mode === "live" && !subscriberId) {
    return new NextResponse("live cron requires OUTREACH_CRON_SUBSCRIBER_ID", { status: 400 });
  }

  // D. Run the engine over the shared default port.
  const summary = await runCadence(new Date(), createDefaultPort(mode, subscriberId, invoiceId));
  return NextResponse.json({ ok: true, mode, subscriberId, invoiceId, summary }, { status: 200 });
}
