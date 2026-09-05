import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkCronAuth } from "@/lib/qbo/worker";
import type { Database } from "@/types/supabase";
import { sendEmailStep } from "@/lib/outreach/sendEmailStep";
import { parseRunRequest, type RunMode } from "@/lib/outreach/parseRunRequest";
import {
  runCadence,
  type RunCadencePort,
  type CadenceDef,
  type CadenceInvoice,
} from "@/lib/outreach/runCadence";

// Cadence trigger engine endpoint (Brick 1c; live-send plumbing added in C4a) —
// MANUAL INVOKE ONLY.
//
// Walks the active cadence over candidate invoices and fires due steps via
// sendEmailStep. DEFAULT (body-less request) is DRY-RUN over all subscribers —
// unchanged from 1c, sends nothing. C4a adds an optional request body
// { mode?: "dry_run" | "live", subscriberId?: string }: `mode: "live"` actually
// sends, and a live run MUST be fenced to a subscriberId (see parseRunRequest).
// Nothing in the repo passes "live" — that is a deliberate C4b request only.
//
// ⚠️ NO CRON. This route is intentionally absent from vercel.json. Cron
// registration is a DELIBERATE later switch, gated on Preview/Prod Supabase
// separation: the project is shared, so any cron would write the LIVE DB on every
// tick (`/api/qbo/worker` is live proof this is real). Until that separation
// exists, this engine runs only when invoked by hand.
//
// Auth: reuses checkCronAuth (fail-closed). A missing OUTREACH_RUN_SECRET rejects
// ALL requests — the endpoint writes dry-run rows to the shared live DB, so it is
// never left publicly open. Set OUTREACH_RUN_SECRET in Vercel before invoking; it
// does not exist yet and no value is invented here.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Coarse candidate pre-filter — statuses that could plausibly still be dunned. The
// authoritative terminus + past-due checks live in the pure engine; this only
// bounds the row scan. `draft` (not yet issued) and the terminal statuses are
// excluded here; the engine re-verifies terminus regardless.
const CANDIDATE_STATUSES: Database["public"]["Enums"]["invoice_status"][] = [
  "sent",
  "partial",
  "overdue",
  "in_recovery",
];

export async function POST(req: NextRequest) {
  const auth = checkCronAuth(req.headers.get("authorization"), process.env.OUTREACH_RUN_SECRET);
  if (auth === "missing_secret") {
    console.error("outreach/run: OUTREACH_RUN_SECRET not configured — rejecting (fail-closed)");
    return new NextResponse("server error", { status: 500 });
  }
  if (auth === "unauthorized") {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // Optional body: { mode?, subscriberId? }. Body-less → dry-run, unfenced (as
  // before). Malformed / invalid / unfenced-live → 400 (fail safe; never a
  // silent live default). Auth above is untouched and stays first.
  const parsed = parseRunRequest(await req.text());
  if (!parsed.ok) {
    return new NextResponse(parsed.error, { status: parsed.status });
  }

  const summary = await runCadence(
    new Date(),
    createDefaultPort(parsed.mode, parsed.subscriberId),
  );
  return NextResponse.json({ ok: true, summary }, { status: 200 });
}

// ── Default (real) port over Supabase + the send seam ────────────────────────
// `mode` is threaded into sendEmailStep (default "dry_run" behaves as before);
// `subscriberId`, when set, fences the candidate scan to that subscriber.
function createDefaultPort(mode: RunMode, subscriberId: string | undefined): RunCadencePort {
  const service = getSupabase();
  return {
    async loadActiveCadence(): Promise<CadenceDef | null> {
      // Deterministic pick: oldest active cadence. A single global active cadence is
      // the 1c simplification; Agent 2's per-client selection supersedes it later.
      const { data: cad, error: cadErr } = await service
        .from("cadences")
        .select("id")
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (cadErr || !cad) {
        if (cadErr) console.error("outreach/run: cadences read failed", cadErr);
        return null;
      }
      const { data: steps, error: stepErr } = await service
        .from("cadence_steps")
        .select("step_number, channel, offset_business_days")
        .eq("cadence_id", cad.id)
        .order("step_number", { ascending: true });
      if (stepErr) {
        console.error("outreach/run: cadence_steps read failed", stepErr);
        return null;
      }
      return {
        id: cad.id,
        steps: (steps ?? []).map((s) => ({
          step_number: s.step_number,
          channel: s.channel,
          offset_business_days: s.offset_business_days,
        })),
      };
    },
    async loadCandidateInvoices(): Promise<CadenceInvoice[]> {
      let query = service
        .from("invoices")
        .select("id, subscriber_id, client_id, status, due_date, amount_outstanding_cents")
        .in("status", CANDIDATE_STATUSES)
        .not("due_date", "is", null);
      // Opt-in subscriber fence: absent → unchanged (all subscribers).
      if (subscriberId) {
        query = query.eq("subscriber_id", subscriberId);
      }
      const { data, error } = await query;
      if (error) {
        console.error("outreach/run: invoices read failed", error);
        return [];
      }
      return (data ?? []) as CadenceInvoice[];
    },
    async loadRecordedStepNumbers(invoiceId: string): Promise<number[]> {
      const { data, error } = await service
        .from("invoice_cadence_progress")
        .select("step_number")
        .eq("invoice_id", invoiceId);
      if (error) {
        console.error("outreach/run: progress read failed", error);
        return [];
      }
      return (data ?? []).map((r) => r.step_number);
    },
    async runSendStep(ctx) {
      // mode is "dry_run" by default (unchanged from 1c); "live" only when a
      // deliberate request passed it — and that request was required to be fenced.
      const res = await sendEmailStep(ctx, mode);
      return {
        outcome: res.outcome,
        communicationId: res.communicationId,
        recoveryAttemptId: res.recoveryAttemptId,
      };
    },
    async claimStep(row) {
      // Insert the claim with null links. A 23505 unique violation on
      // (invoice_id, step_number) means another run already claimed this step —
      // surfaced distinctly (never swallowed by a blanket catch); any other error
      // is a real failure and throws.
      const { error } = await service.from("invoice_cadence_progress").insert({
        subscriber_id: row.subscriber_id,
        invoice_id: row.invoice_id,
        cadence_id: row.cadence_id,
        step_number: row.step_number,
        communication_id: null,
        recovery_attempt_id: null,
      });
      if (error) {
        if (error.code === "23505") return "already_claimed";
        throw new Error(`outreach/run: claim insert failed: ${error.message}`);
      }
      return "claimed";
    },
    async finalizeProgress(key, links) {
      const { error } = await service
        .from("invoice_cadence_progress")
        .update({
          communication_id: links.communication_id,
          recovery_attempt_id: links.recovery_attempt_id,
        })
        .eq("invoice_id", key.invoice_id)
        .eq("step_number", key.step_number);
      if (error) {
        throw new Error(`outreach/run: progress finalize failed: ${error.message}`);
      }
    },
    async releaseProgress(key) {
      const { error } = await service
        .from("invoice_cadence_progress")
        .delete()
        .eq("invoice_id", key.invoice_id)
        .eq("step_number", key.step_number);
      if (error) {
        throw new Error(`outreach/run: progress release failed: ${error.message}`);
      }
    },
  };
}
