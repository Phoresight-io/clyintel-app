import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/types/supabase";

// Inbound Vapi webhook: status-update and end-of-call-report events for a call
// placed by app/api/voice/call. Verifies the shared secret, then:
//   1. persists the RAW event to voice_call_events (always, before correlation)
//   2. resolves the voice_calls row (metadata.voiceCallId → id, else the Vapi
//      call id → vapi_call_id)
//   3. applies the status/end-of-call update to the resolved row (by primary key)
//
// It ALWAYS returns 200 once the secret checks out — even on a parse/DB error —
// so Vapi doesn't retry-storm; failures are logged. Auth is the only non-200
// path (401 mismatch, 500 if the secret isn't configured).
//
// Requires the Node.js runtime (service-role key never reaches the edge). POST,
// never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Service = ReturnType<typeof getSupabase>;
type VoiceCallUpdate = Database["public"]["Tables"]["voice_calls"]["Update"];

interface CallEnvelope {
  id?: string;
  metadata?: { voiceCallId?: string };
}

interface VapiMessage {
  type?: string;
  status?: string;
  endedReason?: string;
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  stereoRecordingUrl?: string;
  durationSeconds?: number;
  cost?: number;
  analysis?: {
    summary?: string;
    structuredData?: {
      paymentCommitted?: boolean;
      committedAmount?: number;
      committedDate?: string;
    };
  };
  call?: CallEnvelope;
  // Some event types nest the call (and its metadata) under `artifact` instead
  // of / in addition to the top-level `call`.
  artifact?: {
    variableValues?: { call?: CallEnvelope };
    variables?: { call?: CallEnvelope };
  };
}

// Map a Vapi endedReason onto the voice_calls.outcome enum. Only the buckets the
// spec calls for; anything that reached the callee falls through to 'connected'.
function deriveOutcome(endedReason: string | null): string {
  const r = (endedReason ?? "").toLowerCase();
  if (r.includes("voicemail")) return "voicemail";
  if (r.includes("no-answer") || r.includes("did-not-answer") || r.includes("noanswer")) {
    return "no-answer";
  }
  if (r.includes("busy")) return "busy";
  if (r.includes("error") || r.includes("fail")) return "failed";
  return "connected";
}

// Pull the app's voiceCallId out of wherever Vapi echoes our call-create
// metadata: top-level call, or the artifact-nested copies.
function extractVoiceCallId(message: VapiMessage | undefined): string | null {
  return (
    message?.call?.metadata?.voiceCallId ??
    message?.artifact?.variableValues?.call?.metadata?.voiceCallId ??
    message?.artifact?.variables?.call?.metadata?.voiceCallId ??
    null
  );
}

// Pull the Vapi call id from the body, falling back to the X-Call-Id header Vapi
// always sends.
function extractVapiCallId(message: VapiMessage | undefined, req: NextRequest): string | null {
  return (
    message?.call?.id ??
    message?.artifact?.variableValues?.call?.id ??
    message?.artifact?.variables?.call?.id ??
    req.headers.get("x-call-id") ??
    null
  );
}

// Resolve the voice_calls row: prefer our own id (from metadata), then the Vapi
// call id → vapi_call_id. Returns the matched primary-key id and which path
// matched, or nulls when nothing resolves.
async function resolveVoiceCall(
  service: Service,
  voiceCallId: string | null,
  vapiCallId: string | null,
): Promise<{ id: string | null; via: string | null }> {
  if (voiceCallId) {
    const { data, error } = await service
      .from("voice_calls")
      .select("id")
      .eq("id", voiceCallId)
      .maybeSingle();
    // supabase-js returns errors, it does not throw — inspect and log, never swallow.
    if (error) console.error("voice/webhook: voice_calls lookup by id failed", error);
    if (data) return { id: data.id, via: "metadata.voiceCallId" };
  }
  if (vapiCallId) {
    const { data, error } = await service
      .from("voice_calls")
      .select("id")
      .eq("vapi_call_id", vapiCallId)
      .maybeSingle();
    if (error) console.error("voice/webhook: voice_calls lookup by vapi_call_id failed", error);
    if (data) return { id: data.id, via: "call.id→vapi_call_id" };
  }
  return { id: null, via: null };
}

export async function POST(req: NextRequest) {
  // Read the raw body ONCE, up front — the ENTRY diagnostic below needs it, and
  // the main handler reuses it (a second req.text() would return an empty stream).
  let bodyText = "";
  try {
    bodyText = await req.text();
  } catch {
    // Leave bodyText empty; the entry row still records reach + auth.
  }

  const parsedType = (() => {
    try {
      return (JSON.parse(bodyText) as { message?: { type?: string } })?.message?.type ?? null;
    } catch {
      return "parse-fail";
    }
  })();
  const parsedCallId = (() => {
    try {
      return (JSON.parse(bodyText) as { message?: { call?: { id?: string } } })?.message?.call?.id ?? null;
    } catch {
      return null;
    }
  })();

  // Supabase-routed diagnostics: Vercel runtime logs are unreadable from here, so
  // leave a trail in voice_call_events instead. This ENTRY row is written BEFORE
  // the auth check and before ANY early return (including the 401), so Charles can
  // read from the DB: (a) whether the function is reached, (b) the auth result,
  // (c) the event type — for every incoming event.
  try {
    const diagService = getSupabase();
    const { error: entryError } = await diagService.from("voice_call_events").insert({
      event_type: typeof parsedType === "string" ? parsedType : null,
      vapi_call_id: parsedCallId,
      raw: {
        _diag: "entry",
        secretPresentInEnv: !!process.env.VAPI_WEBHOOK_SECRET,
        hasSecretHeader: !!req.headers.get("x-vapi-secret"),
        secretMatches: req.headers.get("x-vapi-secret") === process.env.VAPI_WEBHOOK_SECRET,
        eventType: parsedType,
      } as never,
    });
    if (entryError) {
      // Capture WHY the entry insert failed into a second diagnostic row.
      await diagService.from("voice_call_events").insert({
        raw: { _diag: "entry-insert-failed", error: String(entryError) } as never,
      });
    }
  } catch (entryThrow) {
    // getSupabase() threw (no service key) or a network throw — no client to
    // record with; fall back to a log.
    console.error("voice/webhook: entry diagnostic insert threw", entryThrow);
  }

  const expectedSecret = process.env.VAPI_WEBHOOK_SECRET;
  if (!expectedSecret) {
    // Deploy misconfiguration — never accept unverified webhook traffic.
    console.error("voice/webhook: VAPI_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }
  if (req.headers.get("x-vapi-secret") !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Past auth, always ACK 200 so Vapi never retry-storms; log any failure.
  try {
    // Reuse the body read above — the stream was already consumed, so do NOT
    // call req.text() again (it would return empty).
    const rawText = bodyText;
    let parsed: ({ message?: VapiMessage } & Record<string, unknown>) | null = null;
    try {
      parsed = JSON.parse(rawText) as { message?: VapiMessage } & Record<string, unknown>;
    } catch {
      console.error("voice/webhook: body failed to parse as JSON");
    }

    const message = parsed?.message;
    const eventType = message?.type ?? null;
    const voiceCallId = extractVoiceCallId(message);
    const vapiCallId = extractVapiCallId(message, req);

    const service = getSupabase();

    // Correlate FIRST so the audit row records the match outcome.
    const match = await resolveVoiceCall(service, voiceCallId, vapiCallId);

    // 1. Persist the raw event ALWAYS, for every event type. Best-effort: an
    //    audit failure must never block the update below — but it must be LOGGED.
    //    supabase-js returns { error } (it does NOT throw on a REST error), so the
    //    returned error is inspected here; the try/catch only guards network throws.
    try {
      const { error: auditError } = await service.from("voice_call_events").insert({
        event_type: eventType,
        vapi_call_id: vapiCallId,
        matched_voice_call_id: match.id,
        raw: (parsed ?? { _unparsed: rawText.slice(0, 10000) }) as never,
      });
      if (auditError) {
        console.error("voice/webhook: voice_call_events insert error", auditError);
      }
    } catch (auditThrow) {
      console.error("voice/webhook: voice_call_events insert threw", auditThrow);
    }

    if (!match.id) {
      console.error(
        `voice/webhook: no voice_calls match (type=${eventType} ` +
          `voiceCallId=${voiceCallId} vapiCallId=${vapiCallId})`,
      );
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // 2. Apply the type-specific update, always by the resolved primary key.
    let patch: VoiceCallUpdate | null = null;

    if (eventType === "status-update") {
      if (message?.status) patch = { status: message.status };
    } else if (eventType === "end-of-call-report") {
      const endedReason = message?.endedReason ?? null;
      patch = {
        status: "ended",
        outcome: deriveOutcome(endedReason),
        ended_reason: endedReason,
        transcript: message?.transcript ?? null,
        summary: message?.analysis?.summary ?? null,
        recording_url: message?.recordingUrl ?? message?.stereoRecordingUrl ?? null,
        duration_seconds:
          typeof message?.durationSeconds === "number" ? message.durationSeconds : null,
        cost_usd: typeof message?.cost === "number" ? message.cost : null,
        ended_at: new Date().toISOString(),
      };
      const structured = message?.analysis?.structuredData;
      if (structured && structured.paymentCommitted != null) {
        patch.payment_committed = true;
        patch.committed_amount =
          typeof structured.committedAmount === "number" ? structured.committedAmount : null;
        patch.committed_date = structured.committedDate ?? null;
      }
    }

    if (patch) {
      // .select() so we can log whether the update actually hit a row — a silent
      // 0-row update is the failure mode this whole change exists to surface.
      const { data, error } = await service
        .from("voice_calls")
        .update(patch)
        .eq("id", match.id)
        .select("id");
      if (error) {
        console.error("voice/webhook: voice_calls update failed", error);
      } else {
        console.log(
          `voice/webhook: updated ${data?.length ?? 0} row(s) ` +
            `(id=${match.id} via=${match.via} type=${eventType})`,
        );
      }

      // Supabase-routed diagnostic: record the UPDATE outcome so a 0-row or
      // errored update is visible directly in voice_call_events.
      await service.from("voice_call_events").insert({
        event_type: eventType,
        vapi_call_id: vapiCallId,
        matched_voice_call_id: match.id,
        raw: {
          _diag: "update-result",
          stage: eventType,
          matchedId: match.id,
          updateError: error ? String(error) : null,
          rowcount: data?.length ?? 0,
        } as never,
      });
    }
  } catch (err) {
    console.error("voice/webhook: processing error", err);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
