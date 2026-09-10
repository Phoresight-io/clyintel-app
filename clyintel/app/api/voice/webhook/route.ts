import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/types/supabase";

// Inbound Vapi webhook: status-update and end-of-call-report events for a call
// placed by app/api/voice/call. Verifies the shared secret, correlates the event
// to its voice_calls row (metadata.voiceCallId, else the Vapi call id →
// vapi_call_id), and applies the update via the service-role client.
//
// It ALWAYS returns 200 once the secret checks out — even on a parse or DB error
// — so Vapi doesn't retry-storm; failures are logged instead. Auth is the only
// non-200 path (401 mismatch, 500 if the secret isn't configured — never accept
// unverified traffic).
//
// Requires the Node.js runtime (service-role key never reaches the edge). POST,
// never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VoiceCallUpdate = Database["public"]["Tables"]["voice_calls"]["Update"];

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
  call?: {
    id?: string;
    metadata?: { voiceCallId?: string };
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

// Apply a patch to the correlated row: by row id when metadata carried it,
// otherwise by the Vapi call id. No correlation key → log and skip.
async function applyUpdate(
  service: ReturnType<typeof getSupabase>,
  voiceCallId: string | null,
  vapiCallId: string | null,
  patch: VoiceCallUpdate,
): Promise<void> {
  const base = service.from("voice_calls").update(patch);
  const query = voiceCallId
    ? base.eq("id", voiceCallId)
    : vapiCallId
      ? base.eq("vapi_call_id", vapiCallId)
      : null;
  if (!query) {
    console.error("voice/webhook: event has no voiceCallId or call id to correlate");
    return;
  }
  const { error } = await query;
  if (error) console.error("voice/webhook: row update failed", error);
}

export async function POST(req: NextRequest) {
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
    const body = (await req.json()) as { message?: VapiMessage };
    const message = body?.message;
    if (!message) {
      console.error("voice/webhook: payload missing message");
      return NextResponse.json({ received: true }, { status: 200 });
    }

    const voiceCallId = message.call?.metadata?.voiceCallId ?? null;
    const vapiCallId = message.call?.id ?? null;
    const service = getSupabase();

    if (message.type === "status-update") {
      if (message.status) {
        await applyUpdate(service, voiceCallId, vapiCallId, { status: message.status });
      }
    } else if (message.type === "end-of-call-report") {
      const endedReason = message.endedReason ?? null;
      const patch: VoiceCallUpdate = {
        status: "ended",
        outcome: deriveOutcome(endedReason),
        ended_reason: endedReason,
        transcript: message.transcript ?? null,
        summary: message.analysis?.summary ?? null,
        recording_url: message.recordingUrl ?? message.stereoRecordingUrl ?? null,
        duration_seconds: typeof message.durationSeconds === "number" ? message.durationSeconds : null,
        cost_usd: typeof message.cost === "number" ? message.cost : null,
        ended_at: new Date().toISOString(),
      };

      // Payment commitment, when the assistant's structured analysis reports it.
      const structured = message.analysis?.structuredData;
      if (structured && structured.paymentCommitted != null) {
        patch.payment_committed = true;
        patch.committed_amount =
          typeof structured.committedAmount === "number" ? structured.committedAmount : null;
        patch.committed_date = structured.committedDate ?? null;
      }

      await applyUpdate(service, voiceCallId, vapiCallId, patch);
    }
    // Other event types are acknowledged but not acted on.
  } catch (err) {
    console.error("voice/webhook: processing error", err);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
