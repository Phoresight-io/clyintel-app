import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { serverEnv } from "@/lib/config/env.server";
import { parseHandoffMode } from "@/lib/voice/handoffEmail";
import {
  extractVapiCallId,
  extractVoiceCallId,
  resolveVoiceCall,
  serializeError,
  type VapiCallCarrier,
} from "@/lib/voice/resolveVoiceCall";
import { loadAccountForCall } from "@/lib/voice/accountView";
import {
  createPaymentEmailPort,
  sendPaymentEmailForCall,
  toToolResponse,
} from "@/lib/voice/sendPaymentEmailForCall";

// Vapi custom-tool endpoint for the Recovery Agent's in-call tools. Vapi POSTs
// { message: { type: "tool-calls", toolCallList: [{ id, function: { name,
// arguments } }], call: { id, metadata: { voiceCallId } } } } and speaks from our
// { results: [{ toolCallId, name, result | error }] }.
//
//   get_account         → the account for THIS call (contacts with full emails,
//                         invoice, who the default is, whether an email already
//                         went). Read-only; never the payment link.
//   send_payment_email  → args { email?, contact_id? }; priority email →
//                         contact_id → default. One email per call, DB-resolved
//                         link, opt-outs honored (lib/voice/sendPaymentEmailForCall).
//
// Auth mirrors app/api/voice/webhook: x-vapi-secret must equal VAPI_WEBHOOK_SECRET
// (set it as a header on each tool's server config in Vapi). 500 if unset, 401 on
// mismatch. Past auth it ALWAYS returns 200 with a per-item result or error, and
// writes one voice_call_events audit row per request.
//
// Requires the Node.js runtime (service-role key never reaches the edge). POST,
// never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface ToolCallsMessage extends VapiCallCarrier {
  type?: string;
  toolCallList?: ToolCall[];
}

type ToolResult = { toolCallId: string; name: string } & ({ result: string } | { error: string });

// Vapi documents arguments as a JSON string; older payloads send an object.
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

const NO_CALL = "I couldn't find the account for this call. Tell the caller the team will follow up with the payment link.";

export async function POST(req: NextRequest) {
  const expectedSecret = serverEnv.vapiWebhookSecret();
  if (!expectedSecret) {
    console.error("voice/tools: VAPI_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }
  if (req.headers.get("x-vapi-secret") !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: ToolResult[] = [];
  try {
    const rawText = await req.text();
    let parsed: { message?: ToolCallsMessage } | null = null;
    try {
      parsed = JSON.parse(rawText) as { message?: ToolCallsMessage };
    } catch {
      console.error("voice/tools: body failed to parse as JSON");
    }
    const message = parsed?.message;
    const toolCalls = Array.isArray(message?.toolCallList) ? message.toolCallList : [];

    const service = getSupabase();
    const vapiCallId = extractVapiCallId(message, req);
    const match = await resolveVoiceCall(service, extractVoiceCallId(message), vapiCallId);

    // One audit row per request (raw payload + matched id). Best-effort, logged.
    try {
      const { error: auditError } = await service.from("voice_call_events").insert({
        event_type: message?.type ?? "tool-calls",
        vapi_call_id: vapiCallId,
        matched_voice_call_id: match.id,
        raw: (parsed ?? { _unparsed: rawText.slice(0, 10000) }) as never,
      });
      if (auditError) console.error("voice/tools: voice_call_events insert error", serializeError(auditError));
    } catch (auditThrow) {
      console.error("voice/tools: voice_call_events insert threw", auditThrow);
    }

    for (const tc of toolCalls) {
      const toolCallId = typeof tc?.id === "string" ? tc.id : "";
      const name = typeof tc?.function?.name === "string" ? tc.function.name : "";
      results.push({ toolCallId, name, ...(await runTool(service, name, tc?.function?.arguments, match.id)) });
    }
  } catch (err) {
    console.error("voice/tools: processing error", err);
  }

  return NextResponse.json({ results }, { status: 200 });
}

async function runTool(
  service: ReturnType<typeof getSupabase>,
  name: string,
  rawArgs: unknown,
  voiceCallId: string | null,
): Promise<{ result: string } | { error: string }> {
  try {
    if (name === "get_account") {
      if (!voiceCallId) return { error: NO_CALL };
      const view = await loadAccountForCall(service, voiceCallId);
      return view ? { result: JSON.stringify(view) } : { error: NO_CALL };
    }

    if (name === "send_payment_email") {
      if (!voiceCallId) return { error: NO_CALL };
      const args = parseArguments(rawArgs);
      const outcome = await sendPaymentEmailForCall(
        {
          voiceCallId,
          email: str(args.email),
          contactId: str(args.contact_id),
          mode: parseHandoffMode(serverEnv.voiceHandoffEmailMode()),
          clientFence: serverEnv.voiceHandoffEmailClientId() ?? null,
        },
        createPaymentEmailPort(service),
      );
      console.log(`voice/tools: send_payment_email ${JSON.stringify(outcome)} (id=${voiceCallId})`);
      return toToolResponse(outcome);
    }

    return { error: `Unknown tool "${name}".` };
  } catch (err) {
    console.error(`voice/tools: ${name} failed`, err);
    return { error: "That didn't work. Tell the caller the team will follow up with the payment link." };
  }
}
