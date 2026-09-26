// In-call agent tool: send the payment-link email for THIS voice call, to the
// recipient the agent chose. Called by app/api/voice/tools (send_payment_email).
//
// The agent decides WHETHER and to WHOM. This function only guarantees record
// integrity: the link is always DB-resolved inside sendEmailStep (never agent-
// supplied), opt-outs are honored, and a call gets at most one email.
//
// Order:
//   1. Mode fence (VOICE_HANDOFF_EMAIL_MODE, parsed by the caller): OFF → write
//      nothing, tell the agent email isn't available.
//   2. Record gates, read-only: no_call · no_invoice · invoice_not_open ·
//      client_fenced (VOICE_HANDOFF_EMAIL_CLIENT_ID).
//   3. Already handled on this call? (read-only) → duplicate.
//      Target validation, read-only, BEFORE claiming, so a bad target costs
//      nothing and the agent can ask again: invalid email syntax · contact not on
//      this client · no address · opted out (contact or clients.opt_out_email).
//      The same pure helpers and isChannelAllowed that sendEmailStep's gate uses.
//   4. Claim (NULL-guarded). 0 rows → duplicate.
//   5. sendEmailStep with the recipient override + clients.opt_out_email.
//   6. Release vs terminal:
//        - a sendEmailStep GATE outcome (no_primary_contact · channel_denied ·
//          no_template · no_payment_link · recipient_not_found): the step returned
//          before writing a record or dispatching → RELEASE the claim to NULL so
//          the agent can retry on this call.
//        - sent / would_send → terminal.
//        - send_failed → TERMINAL. sendEmailStep's catch wraps sendEmail(), which
//          throws both before a request (missing API key) and after one may have
//          reached MailerSend (fetch network/timeout error), so a failure can't be
//          proven pre-dispatch. A communications row (status failed) also already
//          exists. Never risk a double send.
//        - sendEmailStep THROWS → TERMINAL (failed), same reasoning.
//   NEVER throws: errors come back as { action: "error" }.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import type { RecipientOverride, SendEmailOutcome } from "../outreach/sendEmailStep";
import {
  EMAIL_CHANNEL,
  resolveAddressRecipient,
  selectForChannel,
  withClientEmailOptOut,
  type ContactRow,
} from "../outreach/selectRecipients";
import { isChannelAllowed } from "../outreach/isChannelAllowed";
import { createHandoffPort, type HandoffMode, type HandoffPort } from "./handoffEmail";

const MAX_REASON = 500;

export interface ClientEmailContext {
  clientOptOutEmail: boolean | null;
  contacts: ContactRow[];
}

export interface PaymentEmailPort extends HandoffPort {
  // clients.opt_out_email + the client's contacts. null = client not found.
  loadClientEmailContext(clientId: string): Promise<ClientEmailContext | null>;
}

export type InvalidTargetReason =
  | "invalid_email"
  | "contact_not_found"
  | "no_email_on_contact"
  | "no_default_contact"
  | "opted_out"
  | "client_opted_out";

type ReleasedReason = Extract<
  SendEmailOutcome,
  "no_primary_contact" | "channel_denied" | "no_template" | "no_payment_link" | "recipient_not_found"
>;

export type PaymentEmailResult =
  | { action: "off" }
  | { action: "no_call" }
  | { action: "skipped"; reason: "no_invoice" | "invoice_not_open" | "client_fenced" }
  | { action: "invalid_target"; reason: InvalidTargetReason }
  | { action: "duplicate"; priorStatus: string | null; toAddress: string | null }
  | { action: "sent"; toAddress: string; communicationId: string | null }
  | { action: "would_send"; toAddress: string; communicationId: string | null }
  | { action: "released"; reason: ReleasedReason }
  | { action: "failed"; reason: string; communicationId: string | null }
  | { action: "error"; reason: string };

const RELEASABLE: ReadonlySet<string> = new Set<ReleasedReason>([
  "no_primary_contact",
  "channel_denied",
  "no_template",
  "no_payment_link",
  "recipient_not_found",
]);

// Deliberately loose: one @, no spaces, a dot in the domain. MailerSend is the
// real validator; this only catches a garbled spoken address before claiming.
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  return (msg ?? "unknown error").slice(0, MAX_REASON);
}

type Target = { recipient: RecipientOverride; toAddress: string };

// Read-only resolution of the agent's choice to a checked recipient. Priority:
// spoken email → contact_id → default emailable contact. Every branch folds in
// the client-level opt-out and runs the same isChannelAllowed gate sendEmailStep
// will run again.
export function resolveTarget(
  ctx: ClientEmailContext,
  choice: { email?: string | null; contactId?: string | null },
): Target | { invalid: InvalidTargetReason } {
  if (ctx.clientOptOutEmail !== false) return { invalid: "client_opted_out" };

  const email = typeof choice.email === "string" ? choice.email.trim() : "";
  if (email !== "") {
    if (!isPlausibleEmail(email)) return { invalid: "invalid_email" };
    const candidate = resolveAddressRecipient(ctx.contacts, ctx.clientOptOutEmail, email);
    if (!isChannelAllowed(candidate, "email")) return { invalid: "opted_out" };
    return { recipient: { email }, toAddress: email };
  }

  const contactId = typeof choice.contactId === "string" ? choice.contactId.trim() : "";
  if (contactId !== "") {
    const row = ctx.contacts.find((c) => c.id === contactId);
    if (!row) return { invalid: "contact_not_found" };
    if (!row.email || row.email.trim() === "") return { invalid: "no_email_on_contact" };
    if (!isChannelAllowed(withClientEmailOptOut(row, ctx.clientOptOutEmail), "email")) {
      return { invalid: "opted_out" };
    }
    return { recipient: { contactId: row.id }, toAddress: row.email };
  }

  // Default: the same channel-aware pick the cadence uses, passed as an explicit
  // contactId so the client-level opt-out applies to it too.
  const fallback = selectForChannel(ctx.contacts, EMAIL_CHANNEL);
  if (!fallback || !fallback.email) return { invalid: "no_default_contact" };
  return { recipient: { contactId: fallback.id }, toAddress: fallback.email };
}

export async function sendPaymentEmailForCall(
  args: {
    voiceCallId: string;
    email?: string | null;
    contactId?: string | null;
    mode: HandoffMode | null;
    clientFence?: string | null;
  },
  port: PaymentEmailPort,
): Promise<PaymentEmailResult> {
  // 1. Mode fence first: OFF writes nothing at all.
  if (args.mode === null) return { action: "off" };

  try {
    // 2. Record gates (read-only).
    const call = await port.loadCall(args.voiceCallId);
    if (!call) return { action: "no_call" };
    if (!call.invoice_id) return { action: "skipped", reason: "no_invoice" };
    if (!(typeof call.invoice_outstanding_cents === "number" && call.invoice_outstanding_cents > 0)) {
      return { action: "skipped", reason: "invoice_not_open" };
    }
    if (args.clientFence && args.clientFence !== call.client_id) {
      return { action: "skipped", reason: "client_fenced" };
    }

    // 3. Already handled on this call? Say so rather than validating a new target.
    const prior = await port.loadPriorSend(call.id);
    if (prior.status !== null) return { action: "duplicate", priorStatus: prior.status, toAddress: prior.toAddress };

    //    Target validation (read-only, before the claim).
    const emailCtx = await port.loadClientEmailContext(call.client_id);
    if (!emailCtx) return { action: "no_call" };
    const target = resolveTarget(emailCtx, { email: args.email, contactId: args.contactId });
    if ("invalid" in target) return { action: "invalid_target", reason: target.invalid };

    // 4. Claim: the only path to a send. 0 rows → someone else owns it.
    const claimed = await port.claimOrRecord(call.id, { status: "claimed" }, port.now());
    if (!claimed) {
      const again = await port.loadPriorSend(call.id);
      return { action: "duplicate", priorStatus: again.status, toAddress: again.toAddress };
    }

    // 5. Send through the dunning path; its gates run on the override.
    let result;
    try {
      result = await port.sendEmailStep(
        {
          subscriberId: call.subscriber_id,
          clientId: call.client_id,
          invoiceId: call.invoice_id,
          recipient: target.recipient,
          clientOptOutEmail: emailCtx.clientOptOutEmail ?? undefined,
        },
        args.mode,
      );
    } catch (e) {
      const reason = errorMessage(e);
      await port.finalize(call.id, { status: "failed", reason, communicationId: null });
      return { action: "failed", reason, communicationId: null };
    }

    // 6. Release (pre-dispatch gate) vs terminal.
    const communicationId = result.communicationId ?? null;
    switch (result.outcome) {
      case "sent":
        await port.finalize(call.id, { status: "sent", reason: null, communicationId });
        return { action: "sent", toAddress: target.toAddress, communicationId };
      case "would_send":
        await port.finalize(call.id, { status: "would_send", reason: null, communicationId });
        return { action: "would_send", toAddress: target.toAddress, communicationId };
      case "send_failed":
        await port.finalize(call.id, { status: "failed", reason: "send_failed", communicationId });
        return { action: "failed", reason: "send_failed", communicationId };
      default: {
        if (RELEASABLE.has(result.outcome)) {
          await port.release(call.id);
          return { action: "released", reason: result.outcome as ReleasedReason };
        }
        // Unknown outcome: fail safe — terminal, never released.
        const reason = String(result.outcome);
        await port.finalize(call.id, { status: "failed", reason, communicationId });
        return { action: "failed", reason, communicationId };
      }
    }
  } catch (e) {
    const reason = errorMessage(e);
    console.error("voice/sendPaymentEmailForCall: error", { voiceCallId: args.voiceCallId, reason });
    return { action: "error", reason };
  }
}

// What the agent hears back. `result` for outcomes the agent should relay as
// done/known; `error` for something it should act on. Never contains the link.
export function toToolResponse(r: PaymentEmailResult): { result: string } | { error: string } {
  const followUp = "Tell the caller the team will follow up with the payment link.";
  switch (r.action) {
    case "off":
      return { result: `Email isn't available right now. ${followUp}` };
    case "no_call":
      return { error: `I couldn't find the account for this call. ${followUp}` };
    case "skipped":
      if (r.reason === "no_invoice") return { error: `No invoice is linked to this call, so no payment link can be sent. ${followUp}` };
      if (r.reason === "invoice_not_open") return { error: "This invoice has no balance outstanding, so no payment link was sent." };
      return { error: `Email isn't available for this account right now. ${followUp}` };
    case "invalid_target":
      switch (r.reason) {
        case "invalid_email":
          return { error: "That doesn't look like a valid email address. Ask the caller to spell it again, read it back, then send." };
        case "contact_not_found":
          return { error: "That contact isn't on this account. Use a contact_id from get_account, or ask the caller for an address." };
        case "no_email_on_contact":
          return { error: "That contact has no email on file. Ask the caller for an address, read it back, then send." };
        case "no_default_contact":
          return { error: "There's no email on file for this account. Ask the caller for an address, read it back, then send." };
        case "opted_out":
          return { error: "That address is opted out of email, so I can't send to it. Is there another address?" };
        case "client_opted_out":
          return { error: `This account has opted out of email, so no payment link can be emailed. ${followUp}` };
      }
      break;
    case "duplicate":
      if (r.priorStatus === "sent") {
        return { result: `already_sent: a payment link was already emailed on this call${r.toAddress ? ` to ${r.toAddress}` : ""}.` };
      }
      if (r.priorStatus === "would_send") {
        return {
          result: `already_sent: a payment link was already recorded in test mode on this call${r.toAddress ? ` (to ${r.toAddress})` : ""}, not delivered.`,
        };
      }
      return { result: `already_attempted: a payment email was already attempted on this call. Don't retry. ${followUp}` };
    case "sent":
      return { result: `sent to ${r.toAddress}. Tell the caller to check their inbox.` };
    case "would_send":
      return { result: `recorded in test mode, not delivered (would have gone to ${r.toAddress}).` };
    case "released":
      if (r.reason === "channel_denied") return { error: "That address is opted out of email. Is there another address?" };
      if (r.reason === "recipient_not_found") {
        return { error: "That contact isn't on this account. Use a contact_id from get_account, or ask the caller for an address." };
      }
      if (r.reason === "no_primary_contact") {
        return { error: "There's no email on file for this account. Ask the caller for an address, read it back, then send." };
      }
      return { error: `The payment email can't be sent right now. ${followUp}` };
    case "failed":
    case "error":
      return { error: `The email didn't go through. Don't retry. ${followUp}` };
  }
  return { error: `The email didn't go through. Don't retry. ${followUp}` };
}

// Real port: the handoff claim port + the client email context.
export function createPaymentEmailPort(service: SupabaseClient<Database>): PaymentEmailPort {
  return {
    ...createHandoffPort(service),
    async loadClientEmailContext(clientId) {
      const [clientRes, contactsRes] = await Promise.all([
        service.from("clients").select("opt_out_email").eq("id", clientId).maybeSingle(),
        service.from("client_contacts").select("*").eq("client_id", clientId),
      ]);
      if (clientRes.error) throw new Error(`voice/paymentEmail: client read failed: ${clientRes.error.message}`);
      if (contactsRes.error) throw new Error(`voice/paymentEmail: contacts read failed: ${contactsRes.error.message}`);
      if (!clientRes.data) return null;
      return { clientOptOutEmail: clientRes.data.opt_out_email, contacts: contactsRes.data ?? [] };
    },
  };
}
