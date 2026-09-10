import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/qbo/worker";
import { runCadence } from "@/lib/outreach/runCadence";
import { type RunMode } from "@/lib/outreach/parseRunRequest";
import { createDefaultPort } from "@/app/api/outreach/run/route";

// On-demand trigger for the cadence engine. Bearer-authed via OUTREACH_CRON_SECRET
// (fail-closed, mirrors app/api/outreach/run) and ADDITIONALLY env-fenced for scope:
//
// The SCOPE GUARD is the ENV FENCE, layered on top of bearer auth:
// OUTREACH_CRON_SUBSCRIBER_ID + OUTREACH_CRON_INVOICE_ID must pin the run to
// exactly one subscriber's one invoice. Auth stops who can call; the fence bounds
// what a call can do — so:
//   ‼️ DO NOT widen this to an unfenced live run. Even behind bearer auth, a live
//      mode without both fences set would fire outreach broadly on any authed hit.
//      The live-requires-subscriber 400 below is the floor, NOT the ceiling: for the
//      test, ALSO set OUTREACH_CRON_INVOICE_ID. When the test is done, flip
//      OUTREACH_CRON_MODE off live (or remove this route) so no anonymous hit can
//      re-trigger a live run.
//
// The run port is SHARED with app/api/outreach/run/route.ts (createDefaultPort is
// exported there and imported here) — the candidate-scan + send wiring is defined
// once, not duplicated. Config comes from env, not the body:
//   OUTREACH_CRON_MODE            "live" → live send; anything else → dry_run (fail-safe default)
//   OUTREACH_CRON_SUBSCRIBER_ID   subscriber fence (REQUIRED for live)
//   OUTREACH_CRON_INVOICE_ID      single-invoice fence (set this for the test send)
//
// ⚠️ NO vercel.json cron entry — this is ON-DEMAND ONLY, not scheduled.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bearer-authed (see runOutreachCron); GET and POST are both accepted.
export async function GET(req: NextRequest) {
  return runOutreachCron(req);
}

export async function POST(req: NextRequest) {
  return runOutreachCron(req);
}

async function runOutreachCron(req: NextRequest) {
  // Fail-closed bearer auth FIRST — before any env/config read or runCadence.
  // A missing OUTREACH_CRON_SECRET rejects every request (never runs unguarded).
  const auth = checkCronAuth(req.headers.get("authorization"), process.env.OUTREACH_CRON_SECRET);
  if (auth === "missing_secret") {
    console.error("outreach/cron: OUTREACH_CRON_SECRET not configured — rejecting (fail-closed)");
    return new NextResponse("server error", { status: 500 });
  }
  if (auth === "unauthorized") {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // A. Config from env (never hardcoded). Default dry_run — a misconfigured or
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
