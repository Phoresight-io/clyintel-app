import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { scoreClient, makeScorePort, type ScoreMode } from "@/lib/score/scoreClient";

// Client Score v0 route. Scores one client only; there is no batch path.
//   GET  = dry run: compute and return the ScoreResult, write nothing.
//   POST = compute and upsert ptr_scores onConflict (client_id, score_month).
// Auth mirrors app/api/clients/contacts/route.ts: session user via
// createSupabaseServer (401 if none), then subscriber-scoped ownership SELECT and
// service-role reads/writes through the port. All rules live in the pure core
// lib/score/scoreClient.ts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(params: Promise<{ id: string }>, mode: ScoreMode): Promise<NextResponse> {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const res = await scoreClient(
      { clientId: id, subscriberId: user.id, mode, asOf: new Date() },
      makeScorePort(getSupabase(), user.id),
    );
    return NextResponse.json(res.body, { status: res.status });
  } catch (e) {
    console.error("clients/score error", e);
    return NextResponse.json({ error: "Scoring failed" }, { status: 500 });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(ctx.params, "dry_run");
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(ctx.params, "write");
}
