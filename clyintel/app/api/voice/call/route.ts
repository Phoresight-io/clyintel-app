import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { createSupabaseServer } from "@/lib/supabase-server";
import { serverEnv } from "@/lib/config/env.server";
import type { Database } from "@/types/supabase";
import { buildCallVariables } from "@/lib/voice/buildCallVariables";
import { markOutreachStarted } from "@/lib/outreach/markOutreachStarted";

// Outbound voice-call trigger. Creates a voice_calls row FIRST (status 'queued')
// via the service-role client — writes bypass RLS, same pattern as the other
// server-only routes (see app/api/qbo/webhook, app/api/stripe-webhook) — then
// places the call through Vapi. The DB row is the source of truth: it exists
// before the provider call so a provider failure is recorded ('failed'), never
// lost. The Vapi call carries the row id in metadata.voiceCallId so the webhook
// (app/api/voice/webhook) can correlate status/end-of-call events back to it.
//
// The assistant's variableValues are built server-side from the DB by id
// (lib/voice/buildCallVariables.ts), so a caller passing only ids still gets a
// grounded agent. body.variables, when sent, is merged OVER the built set
// (explicit caller override wins). A build failure never blocks the call: it's
// logged and the call goes out with body.variables alone.
//
// Auth and tenancy: the caller is the logged-in subscriber (session user via
// createSupabaseServer, same as app/api/clients/[id]/score; 401 if none). The
// subscriber is ALWAYS the session user: a subscriberId in the body is ignored,
// so one tenant can never place a call as another. The client and invoice must
// both belong to that subscriber (service-role ownership SELECT, 404 on any miss
// so a foreign id is indistinguishable from a missing one) before any row is
// written, any variables are built, or Vapi is called.
//
// Requires the Node.js runtime (service-role key never reaches the edge). POST,
// never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VoiceCallUpdate = Database["public"]["Tables"]["voice_calls"]["Update"];

interface CallRequestBody {
  // Not read: the subscriber comes from the session (see the header comment).
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
  // Session first: no cookie, no work. The subscriber id is the auth user id.
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const subscriberId = user.id;

  // Provider config is required — never place (or record) a call we can't
  // actually dial. Missing config is a deploy error, surfaced as 500. The
  // assistant id is resolved per-request below (production vs test).
  const apiKey = serverEnv.vapiApiKey();
  const phoneNumberId = serverEnv.vapiPhoneNumberId();
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

  const clientId = typeof body.clientId === "string" ? body.clientId : null;
  const toNumber = typeof body.toNumber === "string" ? body.toNumber : null;
  const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : null;
  const variables =
    body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
      ? (body.variables as Record<string, unknown>)
      : {};

  if (!clientId || !toNumber) {
    return NextResponse.json(
      { error: "clientId and toNumber are required" },
      { status: 400 },
    );
  }
  // Every call is about one invoice: the agent's variables and its in-call
  // payment-link email (app/api/voice/tools) both key off voice_calls.invoice_id.
  if (!invoiceId) {
    return NextResponse.json({ error: "invoiceId is required" }, { status: 400 });
  }

  // Resolve the outbound assistant: test mode routes to VAPI_ASSISTANT_ID_TEST,
  // otherwise production's VAPI_ASSISTANT_ID (unchanged default behavior).
  const test = body.test === true;
  const assistantId = test ? serverEnv.vapiAssistantIdTest() : serverEnv.vapiAssistantId();

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

  // 0. Ownership: the client and the invoice must both be this subscriber's, and
  //    the invoice must belong to that client. Any miss (or a read error) is a
  //    404 with the same body, and nothing below runs: no row, no variables, no
  //    call. The ids come from the request, so they are never trusted on their own.
  const { data: ownedClient, error: clientError } = await service
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("subscriber_id", subscriberId)
    .maybeSingle();
  const { data: ownedInvoice, error: invoiceError } = await service
    .from("invoices")
    .select("id")
    .eq("id", invoiceId)
    .eq("client_id", clientId)
    .eq("subscriber_id", subscriberId)
    .maybeSingle();
  if (clientError || invoiceError) {
    console.error("voice/call: ownership lookup failed", clientError ?? invoiceError);
  }
  if (!ownedClient || !ownedInvoice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
      // Persisted so every downstream path (in-call email, backfills) can tell a
      // test-mode call apart: test calls are never outreach.
      is_test: test,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    console.error("voice/call: failed to insert voice_calls row", insertError);
    return NextResponse.json({ error: "Failed to create voice call" }, { status: 500 });
  }

  const voiceCallId = inserted.id;

  // Build the agent's variables from the DB; caller-supplied values win.
  let built: Record<string, string> = {};
  try {
    built = await buildCallVariables(service, { subscriberId, clientId, invoiceId });
  } catch (err) {
    console.error("voice/call: buildCallVariables failed; using body.variables only", err);
  }
  const variableValues: Record<string, unknown> = { ...built, ...variables };

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
        assistantOverrides: { variableValues },
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
  const startedAt = new Date().toISOString();
  const { error: updateError } = await service
    .from("voice_calls")
    .update({
      vapi_call_id: vapiCallId,
      status: "ringing",
      started_at: startedAt,
    } satisfies VoiceCallUpdate)
    .eq("id", voiceCallId);

  if (updateError) {
    // The call is already placed — don't fail the request; log for follow-up.
    console.error("voice/call: post-dial row update failed", updateError);
  }

  // Outreach-started stamp: Vapi accepted the call = first real contact on the
  // voice channel (same started_at as the row). Write-once and never throws, so
  // a stamp failure is logged loudly and never fails the already-placed call.
  // Test-mode calls (test assistant) are NOT outreach and never stamp.
  if (!test) {
    await markOutreachStarted(service, invoiceId, startedAt, "voice");
  }

  return NextResponse.json({ voiceCallId, vapiCallId, status: "ringing" });
}
