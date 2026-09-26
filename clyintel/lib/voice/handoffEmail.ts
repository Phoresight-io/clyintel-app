// Voice → email: the per-call claim that allows AT MOST ONE payment-link email
// per voice call, plus the mode fence. Used by the in-call agent tool
// (lib/voice/sendPaymentEmailForCall.ts). The post-call end-of-call trigger that
// first used it (#140) was removed; its orchestrator is gone, these helpers stay.
//
// The claim lives on voice_calls.handoff_email_* (schema/add_voice_calls_handoff_email.sql):
//   - claimOrRecord: conditional transition from handoff_email_status IS NULL.
//     true only when THIS caller moved the row off NULL; 0 rows = someone else
//     owns the call → no send.
//   - finalize: moves a row that is still 'claimed' to its terminal state
//     (sent | would_send | skipped | failed).
//   - release: 'claimed' → NULL. ONLY for a failure where nothing left the
//     building (a sendEmailStep gate returned before any record/dispatch), so the
//     agent can retry on the same call. Never after a record or a dispatch.
//
// Mode fence, fail closed: VOICE_HANDOFF_EMAIL_MODE must be exactly "dry_run" or
// "live"; unset/empty/anything else = OFF.

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
  | "no_payment_link"
  | "recipient_not_found";

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
  // Guarded 'claimed' → NULL. Pre-dispatch failures only (see header).
  release(voiceCallId: string): Promise<void>;
  // The call's current claim state + the address its email went to (via
  // handoff_email_communication_id → communications.to_address), for a duplicate.
  loadPriorSend(voiceCallId: string): Promise<{ status: string | null; toAddress: string | null }>;
  sendEmailStep(ctx: SendEmailStepContext, mode: HandoffMode): Promise<SendEmailStepResult>;
  now(): string;
}

// Exactly "dry_run" or "live" (case-sensitive) → enabled. Anything else → null (OFF).
export function parseHandoffMode(raw: string | undefined | null): HandoffMode | null {
  return raw === "dry_run" || raw === "live" ? raw : null;
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
    async release(voiceCallId) {
      const { error } = await service
        .from("voice_calls")
        .update({ handoff_email_status: null, handoff_email_reason: null, handoff_email_at: null })
        .eq("id", voiceCallId)
        .eq("handoff_email_status", "claimed");
      if (error) throw new Error(`voice/handoff: release failed: ${error.message}`);
    },
    async loadPriorSend(voiceCallId) {
      const { data, error } = await service
        .from("voice_calls")
        .select("handoff_email_status, communications:handoff_email_communication_id(to_address)")
        .eq("id", voiceCallId)
        .maybeSingle();
      if (error) throw new Error(`voice/handoff: prior-send load failed: ${error.message}`);
      const comm = data?.communications as unknown as
        | { to_address: string | null }
        | { to_address: string | null }[]
        | null
        | undefined;
      const one = Array.isArray(comm) ? comm[0] : comm;
      return { status: data?.handoff_email_status ?? null, toAddress: one?.to_address ?? null };
    },
    sendEmailStep: (ctx, mode) => realSendEmailStep(ctx, mode),
    now: () => new Date().toISOString(),
  };
}
