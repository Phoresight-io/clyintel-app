import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { classifyWebhookRequest } from "@/lib/qbo/classifyWebhookRequest";

// Inbound QuickBooks Online webhook. This route ONLY verifies the Intuit
// signature, persists the raw verified event to webhook_events, and ACKs 200.
// It does NOT process the event, call the QBO API, build a CaptureEvent, or
// touch the detection core — the worker (later step) drains the queue and runs
// the core. Idempotency is handled downstream (the ledger's
// (source, source_payment_id) unique index), so every delivery persists its own
// row here by design — that's the audit trail.
//
// Requires the Node.js runtime: HMAC verification uses `crypto` and the insert
// uses the service-role key (never available to edge). Not cached (POST).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 1. Read the RAW body BEFORE any JSON parse — re-stringifying would change
  //    key ordering/whitespace and break the HMAC.
  const raw = await req.text();

  // 2. The signature header Intuit sends (base64 HMAC-SHA256 of the raw body).
  const signature = req.headers.get("intuit-signature");

  // 3 + 4. Verify, then (only if verified) parse. Pure, unit-tested classifier.
  const token = process.env.QBO_WEBHOOK_VERIFIER_TOKEN;
  const outcome = classifyWebhookRequest(raw, signature, token);

  switch (outcome.kind) {
    case "misconfigured":
      // Missing verifier token is a deploy misconfiguration — never silently
      // accept unverified traffic. No secret contents in the log.
      console.error("qbo/webhook: QBO_WEBHOOK_VERIFIER_TOKEN not configured");
      return new NextResponse("server error", { status: 500 });

    case "unauthorized":
      // Signature invalid or missing — do NOT persist unverified events.
      return new NextResponse("unauthorized", { status: 401 });

    case "malformed":
      // Verified but the body isn't JSON — a real edge; don't persist something
      // we can't parse.
      console.error("qbo/webhook: verified body failed to parse as JSON");
      return new NextResponse("bad request", { status: 400 });
  }

  // 5. Persist one webhook_events row via the service-role client (RLS blocks
  //    anon writes). Defaults fill status='pending', attempts=0, received_at=now().
  const service = getSupabase();
  const { error: insertError } = await service.from("webhook_events").insert({
    source: "qbo",
    raw_payload: outcome.payload,
    signature,
  });

  if (insertError) {
    // Failing to persist must NOT be ACKed as success — return 500 so Intuit
    // retries the delivery.
    console.error("qbo/webhook: failed to persist webhook_events row", insertError);
    return new NextResponse("server error", { status: 500 });
  }

  // 6. ACK as soon as the row is written — no processing here.
  return new NextResponse("ok", { status: 200 });
}
