import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { processCaptureEvent } from "@/lib/capture/processCaptureEvent";
import { createLiveCaptureDeps } from "@/lib/capture/captureDepsLive";
import { buildCaptureEventFromPayment } from "@/lib/qbo/captureAdapter";
import {
  checkCronAuth,
  parseQboPaymentEntities,
  processWebhookEventRow,
  type RowHandler,
  type WebhookEventRow,
} from "@/lib/qbo/worker";

// Queue worker: drains webhook_events and runs the detection pipeline
// (claim → parse → route by source → build CaptureEvent → run the core → mark
// the row). It WIRES the verified pieces together; it does not change the
// webhook route, adapter, client, or deps. Auth-guarded so the ledger can't be
// publicly drained. Node runtime (crypto + service-role key; never edge) and
// never cached.
//
// Concurrency: two overlapping cron invocations could double-process a row.
// That is SAFE for D2 — the ledger's (source, source_payment_id) unique index
// makes the second pass return `duplicate` with no second row. Row-locking
// (SELECT ... FOR UPDATE SKIP LOCKED) is deliberately NOT built here; future
// hardening, same posture as the tokens.ts refresh-concurrency TODO.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH_LIMIT = 25;

// Source dispatch. Adding a source later is a one-line addition here.
const HANDLERS: Record<string, RowHandler> = {
  qbo: {
    parseEntities: parseQboPaymentEntities,
    buildEvent: (realmId, paymentId) => buildCaptureEventFromPayment(realmId, paymentId),
  },
};

// Vercel Cron issues a GET to the cron target.
export async function GET(req: NextRequest) {
  return runWorker(req);
}

// Also accept POST for manual/observability invocation with the same guard.
export async function POST(req: NextRequest) {
  return runWorker(req);
}

async function runWorker(req: NextRequest) {
  // A. Auth guard FIRST — never do work before it passes.
  const auth = checkCronAuth(
    req.headers.get("authorization"),
    process.env.QBO_WORKER_CRON_SECRET,
  );
  if (auth === "missing_secret") {
    console.error("qbo/worker: QBO_WORKER_CRON_SECRET not configured");
    return new NextResponse("server error", { status: 500 });
  }
  if (auth === "unauthorized") {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const service = getSupabase();

  // B. Claim a batch: pending, or failed rows with attempts < 3, oldest first.
  const { data: rows, error: claimError } = await service
    .from("webhook_events")
    .select("id, source, raw_payload, attempts")
    .or("status.eq.pending,and(status.eq.failed,attempts.lt.3)")
    .order("received_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (claimError) {
    // The worker itself failed to claim — this IS a 500 (nothing was processed).
    console.error("qbo/worker: claim query failed", claimError);
    return new NextResponse("server error", { status: 500 });
  }

  const deps = createLiveCaptureDeps();
  const batchDeps = {
    handlers: HANDLERS,
    runCore: (event: Parameters<typeof processCaptureEvent>[0]) =>
      processCaptureEvent(event, deps),
    nowIso: () => new Date().toISOString(),
  };

  const counts: Record<string, number> = {
    claimed: rows?.length ?? 0,
    done: 0,
    failed: 0,
    dead: 0,
    written: 0,
    duplicate: 0,
    no_fee: 0,
    rejected: 0,
    skipped: 0,
  };

  // C + D. Process each row sequentially; catch per-row so one bad event can't
  // abort the batch. Mark the row from the computed update.
  for (const row of rows ?? []) {
    const { update, outcomes } = await processWebhookEventRow(row as WebhookEventRow, batchDeps);

    const { error: updateError } = await service
      .from("webhook_events")
      .update(update)
      .eq("id", row.id);
    if (updateError) {
      // Best-effort mark-back; log and keep going (the row stays claimable).
      console.error(`qbo/worker: failed to mark row ${row.id}`, updateError);
    }

    counts[update.status] = (counts[update.status] ?? 0) + 1;
    for (const outcome of outcomes) {
      const key = outcome.split(":")[0]; // 'written' | 'duplicate' | 'no_fee' | 'rejected' | 'skipped'
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  // E. 200 even if some rows failed — failures are recorded on the rows.
  return NextResponse.json(counts, { status: 200 });
}
