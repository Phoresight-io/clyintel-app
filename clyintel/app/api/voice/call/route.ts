import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/types/supabase";

// Outbound voice-call trigger. Creates a voice_calls row FIRST (status 'queued')
// via the service-role client — writes bypass RLS, same pattern as the other
// server-only routes (see app/api/qbo/webhook, app/api/stripe-webhook) — then
// places the call through Vapi. The DB row is the source of truth: it exists
// before the provider call so a provider failure is recorded ('failed'), never
// lost. The Vapi call carries the row id in metadata.voiceCallId so the webhook
// (app/api/voice/webhook) can correlate status/end-of-call events back to it.
//
// Requires the Node.js runtime (service-role key never reaches the edge). POST,
// never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VoiceCallUpdate = Database["public"]["Tables"]["voice_calls"]["Update"];

interface CallRequestBody {
  subscriberId?: unknown;
  clientId?: unknown;
  invoiceId?: unknown;
  toNumber?: unknown;
  variables?: unknown;
  // When true, route to the test assistant (VAPI_ASSISTANT_ID_TEST) instead of
  // the production one (VAPI_ASSISTANT_ID).
  test?: unknown;
}

interface VapiCallResponse {
  id?: string;
  message?: string | string[];
}

// Vapi surfaces errors as { message: string | string[] }. Flatten to one line
// for the row's ended_reason; fall back to the HTTP status when absent.
function vapiErrorReason(body: VapiCallResponse | null, status: number): string {
  const m = body?.message;
  if (Array.isArray(m)) return m.join("; ");
  if (typeof m === "string" && m.length > 0) return m;
  return `Vapi returned HTTP ${status}`;
}

export async function POST(req: NextRequest) {
  // Provider config is required — never place (or record) a call we can't
  // actually dial. Missing config is a deploy error, surfaced as 500. The
  // assistant id is resolved per-request below (production vs test).
  const apiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!apiKey || !phoneNumberId) {
    console.error("voice/call: VAPI_API_KEY or VAPI_PHONE_NUMBER_ID not configured");
    return NextResponse.json({ error: "Voice calling not configured" }, { status: 500 });
  }

  let body: CallRequestBody;
  try {
    body = (await req.json()) as CallRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const subscriberId = typeof body.subscriberId === "string" ? body.subscriberId : null;
  const clientId = typeof body.clientId === "string" ? body.clientId : null;
  const toNumber = typeof body.toNumber === "string" ? body.toNumber : null;
  const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : null;
  const variables =
    body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
      ? (body.variables as Record<string, unknown>)
      : {};

  if (!subscriberId || !clientId || !toNumber) {
    return NextResponse.json(
      { error: "subscriberId, clientId and toNumber are required" },
      { status: 400 },
    );
  }

  // Resolve the outbound assistant: test mode routes to VAPI_ASSISTANT_ID_TEST,
  // otherwise production's VAPI_ASSISTANT_ID (unchanged default behavior).
  const test = body.test === true;
  const assistantId = test ? process.env.VAPI_ASSISTANT_ID_TEST : process.env.VAPI_ASSISTANT_ID;

  // Requesting test mode without a configured test assistant is a caller/config
  // error — surface it (400) rather than silently dialing the production one.
  if (test && !assistantId) {
    return NextResponse.json(
      { error: "test mode requested but VAPI_ASSISTANT_ID_TEST is not set" },
      { status: 400 },
    );
  }
  // Missing production assistant is a deploy misconfiguration (500), same as
  // the other required provider config above.
  if (!assistantId) {
    console.error("voice/call: VAPI_ASSISTANT_ID not configured");
    return NextResponse.json({ error: "Voice calling not configured" }, { status: 500 });
  }

  const service = getSupabase();

  // 1. Persist the queued row FIRST — this is the record of intent.
  const { data: inserted, error: insertError } = await service
    .from("voice_calls")
    .insert({
      subscriber_id: subscriberId,
      client_id: clientId,
      invoice_id: invoiceId,
      assistant_id: assistantId,
      to_number: toNumber,
      status: "queued",
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    console.error("voice/call: failed to insert voice_calls row", insertError);
    return NextResponse.json({ error: "Failed to create voice call" }, { status: 500 });
  }

  const voiceCallId = inserted.id;

  // 2. Place the call through Vapi. The row id rides along in metadata so the
  //    webhook can correlate later even before vapi_call_id is stored.
  let vapiResponse: Response;
  try {
    vapiResponse = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: { number: toNumber },
        assistantOverrides: { variableValues: variables },
        metadata: { voiceCallId },
      }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "network error reaching Vapi";
    await service
      .from("voice_calls")
      .update({ status: "failed", ended_reason: reason } satisfies VoiceCallUpdate)
      .eq("id", voiceCallId);
    console.error("voice/call: Vapi request failed", err);
    return NextResponse.json({ error: "Failed to place call", voiceCallId }, { status: 502 });
  }

  const vapiBody = (await vapiResponse.json().catch(() => null)) as VapiCallResponse | null;

  if (!vapiResponse.ok) {
    const reason = vapiErrorReason(vapiBody, vapiResponse.status);
    await service
      .from("voice_calls")
      .update({ status: "failed", ended_reason: reason } satisfies VoiceCallUpdate)
      .eq("id", voiceCallId);
    console.error(`voice/call: Vapi call rejected (${vapiResponse.status}): ${reason}`);
    return NextResponse.json({ error: "Failed to place call", voiceCallId }, { status: 502 });
  }

  // 3. Success — record the provider id and flip to 'ringing'.
  const vapiCallId = typeof vapiBody?.id === "string" ? vapiBody.id : null;
  const { error: updateError } = await service
    .from("voice_calls")
    .update({
      vapi_call_id: vapiCallId,
      status: "ringing",
      started_at: new Date().toISOString(),
    } satisfies VoiceCallUpdate)
    .eq("id", voiceCallId);

  if (updateError) {
    // The call is already placed — don't fail the request; log for follow-up.
    console.error("voice/call: post-dial row update failed", updateError);
  }

  return NextResponse.json({ voiceCallId, vapiCallId, status: "ringing" });
}
