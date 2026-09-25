// Voice → email handoff: after a Vapi end-of-call-report, send the client at most
// ONE payment-link email for that call, through the existing dunning email path
// (sendEmailStep, reused as-is; its gates are never bypassed or reordered).
//
// Called by app/api/voice/webhook only for end-of-call-report, after the
// voice_calls patch succeeded. Pure over an injected HandoffPort (same shape as
// sendEmailStep's port), so every branch is unit-testable without I/O.
//
// Rules:
//   - Mode fence, fail closed: VOICE_HANDOFF_EMAIL_MODE must be exactly "dry_run"
//     or "live". Unset/empty/anything else = OFF: return immediately and write
//     nothing (not even a claim).
//   - Send conditions, in order. The first failure records a skip with its reason:
//       persisted voice_calls.outcome === 'connected'                → not_connected
//       structuredData.sendPaymentLink === true (strict boolean)     → no_payment_link_consent
//       voice_calls.invoice_id is set (no heuristic invoice pick)    → no_invoice
//       that invoice's amount_outstanding_cents > 0                  → invoice_not_open
//       VOICE_HANDOFF_EMAIL_CLIENT_ID unset or equal to client_id    → client_fenced
//     then sendEmailStep's own gates.
//   - At most once, enforced in the DB: the only way to act on a call is a
//     conditional transition from handoff_email_status IS NULL (claim → 'claimed',
//     or skip → 'skipped'). 0 rows = another delivery owns the call → no send.
//     After a claim: sendEmailStep, then finalize to sent | would_send |
//     skipped (gate reason) | failed. 'failed' is terminal and a stuck 'claimed'
//     is never re-claimed: nothing retries automatically.
//   - NEVER throws. Errors are logged and returned as { action: "error" }.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import {
  sendEmailStep as realSendEmailStep,
  type SendEmailStepContext,
  type SendEmailStepResult,
  type SendMode,
} from "../outreach/sendEmailStep";

export type HandoffMode = SendMode; // "dry_run" | "live"

export type HandoffStatus = "claimed" | "would_send" | "sent" | "skipped" | "failed";

export type HandoffSkipReason =
  | "not_connected"
  | "no_payment_link_consent"
  | "no_invoice"
  | "invoice_not_open"
  | "client_fenced"
  // sendEmailStep gate outcomes
  | "no_primary_contact"
  | "channel_denied"
  | "no_template"
  | "no_payment_link";

export interface HandoffCall {
  id: string;
  subscriber_id: string;
  client_id: string;
  invoice_id: string | null;
  outcome: string | null;
  // The linked invoice's amount_outstanding_cents (null when no invoice).
  invoice_outstanding_cents: number | null;
}

export interface HandoffPort {
  loadCall(voiceCallId: string): Promise<HandoffCall | null>;
  // NULL-guarded transition. Returns true only when THIS call moved the row off NULL.
  claimOrRecord(
    voiceCallId: string,
    next: { status: "claimed" } | { status: "skipped"; reason: HandoffSkipReason },
    at: string,
  ): Promise<boolean>;
  finalize(
    voiceCallId: string,
    patch: { status: Exclude<HandoffStatus, "claimed">; reason: string | null; communicationId: string | null },
  ): Promise<void>;
  sendEmailStep(ctx: SendEmailStepContext, mode: HandoffMode): Promise<SendEmailStepResult>;
  now(): string;
}

export type HandoffResult =
  | { action: "off" }
  | { action: "no_call" }
  | { action: "duplicate" } // another delivery already claimed/recorded this call
  | { action: "skipped"; reason: HandoffSkipReason; communicationId?: string | null }
  | { action: "would_send"; communicationId: string | null }
  | { action: "sent"; communicationId: string | null }
  | { action: "failed"; reason: string; communicationId: string | null }
  | { action: "error"; reason: string };

const MAX_REASON = 500;

// Exactly "dry_run" or "live" (case-sensitive) → enabled. Anything else → null (OFF).
export function parseHandoffMode(raw: string | undefined | null): HandoffMode | null {
  return raw === "dry_run" || raw === "live" ? raw : null;
}

function consentGiven(structuredData: unknown): boolean {
  return (
    typeof structuredData === "object" &&
    structuredData !== null &&
    (structuredData as Record<string, unknown>).sendPaymentLink === true
  );
}

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  return (msg ?? "unknown error").slice(0, MAX_REASON);
}

export async function maybeSendVoiceHandoffEmail(
  args: {
    voiceCallId: string;
    structuredData: unknown;
    mode: HandoffMode | null;
    clientFence?: string | null;
  },
  port: HandoffPort,
): Promise<HandoffResult> {
  // Mode fence first: OFF writes nothing at all.
  if (args.mode === null) return { action: "off" };

  try {
    const call = await port.loadCall(args.voiceCallId);
    if (!call) return { action: "no_call" };

    let skip: HandoffSkipReason | null = null;
    if (call.outcome !== "connected") skip = "not_connected";
    else if (!consentGiven(args.structuredData)) skip = "no_payment_link_consent";
    else if (!call.invoice_id) skip = "no_invoice";
    else if (!(typeof call.invoice_outstanding_cents === "number" && call.invoice_outstanding_cents > 0)) {
      skip = "invoice_not_open";
    } else if (args.clientFence && args.clientFence !== call.client_id) skip = "client_fenced";

    if (skip) {
      const recorded = await port.claimOrRecord(call.id, { status: "skipped", reason: skip }, port.now());
      return recorded ? { action: "skipped", reason: skip } : { action: "duplicate" };
    }

    // Claim: the only path to a send. 0 rows → someone else owns it.
    const claimed = await port.claimOrRecord(call.id, { status: "claimed" }, port.now());
    if (!claimed) return { action: "duplicate" };

    let result: SendEmailStepResult;
    try {
      result = await port.sendEmailStep(
        { subscriberId: call.subscriber_id, clientId: call.client_id, invoiceId: call.invoice_id as string },
        args.mode,
      );
    } catch (e) {
      const reason = errorMessage(e);
      await port.finalize(call.id, { status: "failed", reason, communicationId: null });
      return { action: "failed", reason, communicationId: null };
    }

    const communicationId = result.communicationId ?? null;
    switch (result.outcome) {
      case "sent":
        await port.finalize(call.id, { status: "sent", reason: null, communicationId });
        return { action: "sent", communicationId };
      case "would_send":
        await port.finalize(call.id, { status: "would_send", reason: null, communicationId });
        return { action: "would_send", communicationId };
      case "send_failed":
        await port.finalize(call.id, { status: "failed", reason: "send_failed", communicationId });
        return { action: "failed", reason: "send_failed", communicationId };
      default: {
        // sendEmailStep gate: no_primary_contact | channel_denied | no_template | no_payment_link
        const reason = result.outcome as HandoffSkipReason;
        await port.finalize(call.id, { status: "skipped", reason, communicationId });
        return { action: "skipped", reason, communicationId };
      }
    }
  } catch (e) {
    const reason = errorMessage(e);
    console.error("voice/handoff: error", { voiceCallId: args.voiceCallId, reason });
    return { action: "error", reason };
  }
}

// Real port over the service-role client. Every write is guarded on the current
// handoff_email_status so a replay can't overwrite a terminal state.
export function createHandoffPort(service: SupabaseClient<Database>): HandoffPort {
  return {
    async loadCall(voiceCallId) {
      const { data, error } = await service
        .from("voice_calls")
        .select("id, subscriber_id, client_id, invoice_id, outcome, invoices(amount_outstanding_cents)")
        .eq("id", voiceCallId)
        .maybeSingle();
      if (error) throw new Error(`voice/handoff: voice_calls load failed: ${error.message}`);
      if (!data) return null;
      const inv = data.invoices as unknown as
        | { amount_outstanding_cents: number | null }
        | { amount_outstanding_cents: number | null }[]
        | null;
      const one = Array.isArray(inv) ? inv[0] : inv;
      return {
        id: data.id,
        subscriber_id: data.subscriber_id,
        client_id: data.client_id,
        invoice_id: data.invoice_id,
        outcome: data.outcome,
        invoice_outstanding_cents: one?.amount_outstanding_cents ?? null,
      };
    },
    async claimOrRecord(voiceCallId, next, at) {
      const { data, error } = await service
        .from("voice_calls")
        .update({
          handoff_email_status: next.status,
          handoff_email_reason: next.status === "skipped" ? next.reason : null,
          handoff_email_at: at,
        })
        .eq("id", voiceCallId)
        .is("handoff_email_status", null)
        .select("id");
      if (error) throw new Error(`voice/handoff: claim failed: ${error.message}`);
      return (data?.length ?? 0) === 1;
    },
    async finalize(voiceCallId, patch) {
      const { error } = await service
        .from("voice_calls")
        .update({
          handoff_email_status: patch.status,
          handoff_email_reason: patch.reason,
          handoff_email_communication_id: patch.communicationId,
        })
        .eq("id", voiceCallId)
        .eq("handoff_email_status", "claimed");
      if (error) throw new Error(`voice/handoff: finalize failed: ${error.message}`);
    },
    sendEmailStep: (ctx, mode) => realSendEmailStep(ctx, mode),
    now: () => new Date().toISOString(),
  };
}
