import { NextRequest, NextResponse } from "next/server";
import { runCadence } from "@/lib/outreach/runCadence";
import { type RunMode } from "@/lib/outreach/parseRunRequest";
import { createDefaultPort } from "@/app/api/outreach/run/route";

// ⚠️ UNAUTHENTICATED, TEST-ONLY on-demand trigger for the cadence engine. There is
// deliberately NO auth here — it can be fired by a plain browser GET (no
// Authorization header) so a single test send can be triggered by hitting the URL.
//
// The SCOPE GUARD is the ENV FENCE, not a secret: OUTREACH_CRON_SUBSCRIBER_ID +
// OUTREACH_CRON_INVOICE_ID must pin the run to exactly one subscriber's one
// invoice. That fence is what keeps this endpoint safe while public — so:
//   ‼️ DO NOT widen this to an unfenced live run. A live mode without both fences
//      set would let an anonymous GET fire outreach broadly. The
//      live-requires-subscriber 400 below is the floor, NOT the ceiling: for the
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

// Fireable by a plain browser GET (no auth); POST accepted too.
export async function GET(req: NextRequest) {
  return runOutreachCron(req);
}

export async function POST(req: NextRequest) {
  return runOutreachCron(req);
}

async function runOutreachCron(req: NextRequest) {
  void req; // unauthenticated (test-only) — no header/auth check by design.

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
