import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";

// Correlate a Vapi server message to our voice_calls row. Shared by the webhook
// (app/api/voice/webhook) and the in-call tool endpoint (app/api/voice/tools).
//
// Our own id rides in the call-create metadata (app/api/voice/call sets
// metadata.voiceCallId); Vapi echoes it on the top-level `call`, or on the
// artifact-nested copies for some event types. Fallback: the Vapi call id →
// voice_calls.vapi_call_id.

export interface CallEnvelope {
  id?: string;
  metadata?: { voiceCallId?: string };
}

/** The part of a Vapi server message that can carry the call. */
export interface VapiCallCarrier {
  call?: CallEnvelope;
  artifact?: {
    variableValues?: { call?: CallEnvelope };
    variables?: { call?: CallEnvelope };
  };
}

// Pull the app's voiceCallId out of wherever Vapi echoes our call-create
// metadata: top-level call, or the artifact-nested copies.
export function extractVoiceCallId(message: VapiCallCarrier | undefined): string | null {
  return (
    message?.call?.metadata?.voiceCallId ??
    message?.artifact?.variableValues?.call?.metadata?.voiceCallId ??
    message?.artifact?.variables?.call?.metadata?.voiceCallId ??
    null
  );
}

// Pull the Vapi call id from the body, falling back to the X-Call-Id header Vapi
// always sends.
export function extractVapiCallId(
  message: VapiCallCarrier | undefined,
  req: { headers: { get(name: string): string | null } },
): string | null {
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
export async function resolveVoiceCall(
  service: SupabaseClient<Database>,
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
    if (error) console.error("voice/resolveVoiceCall: voice_calls lookup by id failed", serializeError(error));
    if (data) return { id: data.id, via: "metadata.voiceCallId" };
  }
  if (vapiCallId) {
    const { data, error } = await service
      .from("voice_calls")
      .select("id")
      .eq("vapi_call_id", vapiCallId)
      .maybeSingle();
    if (error) console.error("voice/resolveVoiceCall: voice_calls lookup by vapi_call_id failed", serializeError(error));
    if (data) return { id: data.id, via: "call.id→vapi_call_id" };
  }
  return { id: null, via: null };
}

// Serialize a Supabase/PostgREST error for storage + logging. String(err) on the
// error object yields "[object Object]", which hid the real cause — pull the
// useful fields explicitly, with a JSON fallback.
export function serializeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; code?: string; details?: string; hint?: string };
    if (e.message || e.code || e.details || e.hint) {
      return JSON.stringify({ message: e.message, code: e.code, details: e.details, hint: e.hint });
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
