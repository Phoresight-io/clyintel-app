import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/qbo/worker";
import { refundSettlement } from "@/lib/settlement/refundSettlement";

// Ops refund endpoint (Part B, Prompt 5) — a thin, authenticated caller of
// refundSettlement. It ADDS no money gate and can BYPASS none: every gate
// (dryRun, settlement_refunds_enabled, prod+sk_live, active, non-test) lives in
// refundSettlement, which this route calls with the REAL gate (no
// liveChargesAllowed override). The endpoint writes NO DB directly — the
// fee_settlement_refunds row refundSettlement creates IS the request provenance
// (its `actor` column records who initiated).
//
// Auth: a DEDICATED SETTLEMENT_REFUNDS_OPS_SECRET via Authorization: Bearer
// (constant-time compare in checkCronAuth). Distinct from the cron/worker secrets
// for blast-radius isolation. The secret is a Vercel env var set out-of-band —
// never written to app_config or anywhere in the DB. Missing env → 500 (never
// runs unguarded); missing/wrong header → 401.
//
// Scope: FULL reversal only, ONE settlement per request, no amount param.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// UUID shape (version-agnostic) — settlement ids are gen_random_uuid().
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  // Auth FIRST — never parse a body or do work before it passes.
  const auth = checkCronAuth(req.headers.get("authorization"), process.env.SETTLEMENT_REFUNDS_OPS_SECRET);
  if (auth === "missing_secret") {
    console.error("settlement/refund: SETTLEMENT_REFUNDS_OPS_SECRET not configured");
    return new NextResponse("server error", { status: 500 });
  }
  if (auth === "unauthorized") {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // Parse + validate the request body. Any failure → 400 (endpoint input error).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const settlementId = typeof b.settlementId === "string" ? b.settlementId.trim() : "";
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  const actor = typeof b.actor === "string" ? b.actor.trim() : "";
  const dryRun = b.dryRun === undefined ? true : b.dryRun; // default: safe preview

  if (!UUID_RE.test(settlementId)) {
    return NextResponse.json({ error: "invalid_settlementId" }, { status: 400 });
  }
  if (!reason || reason.length > 1000) {
    return NextResponse.json({ error: "invalid_reason" }, { status: 400 });
  }
  if (!actor || actor.length > 200) {
    return NextResponse.json({ error: "invalid_actor" }, { status: 400 });
  }
  if (typeof dryRun !== "boolean") {
    return NextResponse.json({ error: "invalid_dryRun" }, { status: 400 });
  }

  // Delegate. dryRun is forwarded; the REAL env/live gate is used (no override),
  // so dryRun:false still cannot move money unless the deployment is prod+sk_live
  // AND settlement_refunds_enabled is on. A domain rejection comes back as an
  // ok:false outcome — returned verbatim as 200 (the ops caller reads the outcome;
  // internal reasons are NOT mapped to HTTP codes).
  const outcome = await refundSettlement(settlementId, { reason, actor, dryRun });
  return NextResponse.json(outcome, { status: 200 });
}

// POST only — any other method is 405.
export async function GET() {
  return new NextResponse("method not allowed", { status: 405 });
}
