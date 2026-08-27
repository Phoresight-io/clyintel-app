import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSupabase } from "@/lib/supabase";
import {
  verifyMailersendSignature,
  extractMessageId,
  extractEventType,
  classifyMailersendEvent,
  escalateAttention,
} from "@/lib/outreach/mailersendEvents";

// MailerSend inbound webhook → per-contact opt-out + attention derivation (Brick 1b).
//
// This is the inbound feedback loop: MailerSend delivery/bounce/complaint/unsub
// events → resolve to the affected contact BY MESSAGE-ID (never by email) → write
// per-contact opt-out and derive clients.attention_reason. It sends nothing.
//
// Order (mirrors app/api/stripe-webhook): verify the HMAC signature over the RAW
// body FIRST, reject unverified with 401 before any DB read/write, then 200 + do
// the work async via waitUntil so MailerSend never sees a slow response.
//
// FAIL-CLOSED: a missing MAILERSEND_WEBHOOK_SECRET makes the route reject every
// request (cannot verify ⇒ reject). It must NEVER skip verification when the
// secret is absent — that would be the exact unauthenticated-write vector this
// route guards against.
//
// MAILERSEND_WEBHOOK_SECRET must be set in Vercel (the webhook's signing secret).
// It does not exist yet — set it before enabling the MailerSend webhook.

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // needs the raw, unparsed body

// ── Port: the DB writes/reads the processor needs. Tests inject a fake. ───────
export interface MailersendWebhookPort {
  findCommunicationByMessageId(
    messageId: string,
  ): Promise<{ id: string; client_id: string | null; subscriber_id: string | null } | null>;
  loadPrimaryContact(clientId: string): Promise<{ id: string; opt_out_email: boolean } | null>;
  loadClientAttentionReason(clientId: string): Promise<string | null>;
  setContactOptOutEmail(contactId: string): Promise<void>;
  setClientAttentionReason(clientId: string, reason: string): Promise<void>;
  updateCommunicationActivity(commId: string, eventType: string): Promise<void>;
}

export type WebhookOutcome =
  | "no_message_id"
  | "unknown_message_id"
  | "unresolved_client"
  | "activity"
  | "ignored"
  | "opt_out"
  | "attention_only";

// Deterministic processor. Never LLM. Idempotent (opt-out skipped when already
// true; attention written only when it escalates), so a replayed webhook never
// thrashes state.
export async function processMailersendEvent(
  payload: unknown,
  port: MailersendWebhookPort = createDefaultPort(),
): Promise<WebhookOutcome> {
  const messageId = extractMessageId(payload);
  if (!messageId) return "no_message_id";

  // Resolve BY MESSAGE-ID ONLY — never by email address.
  const comm = await port.findCommunicationByMessageId(messageId);
  if (!comm) return "unknown_message_id"; // unknown id → 200 ack, no write (not an error)
  if (!comm.client_id) return "unresolved_client";

  const cls = classifyMailersendEvent(extractEventType(payload));

  // Delivery/open/click: communications status only — never touch opt-out.
  if (cls.activity) {
    await port.updateCommunicationActivity(comm.id, extractEventType(payload));
    return "activity";
  }
  // soft_bounce / unknown: no state change.
  if (!cls.optOutEmail && !cls.attentionEvent) return "ignored";

  // ── RESOLUTION SITE — INVARIANT (read before touching multi-contact send) ──
  // We resolve the affected contact as: message-id → communications → client_id →
  // PRIMARY contact. This is EXACT — not a heuristic — ONLY while outreach is
  // primary-only: sendEmailStep sends solely to selectRecipients()[0] (the
  // primary), so for any real message-id there is exactly ONE contact it can
  // belong to. THE DAY selectRecipients returns more than the primary, this
  // collapses an opt-out/complaint onto the WRONG contact. At that point
  // communications MUST carry a `contact_id` and resolution MUST switch to it.
  // This invariant is the named trigger for adding communications.contact_id —
  // do not ship multi-contact send without it.
  const contact = await port.loadPrimaryContact(comm.client_id);
  if (!contact) return "ignored"; // no contact to act on

  // Per-contact opt-out — deterministic, idempotent (skip when already true).
  if (cls.optOutEmail && contact.opt_out_email !== true) {
    await port.setContactOptOutEmail(contact.id);
  }

  // Severity-monotonic attention: escalate only, never downgrade.
  if (cls.attentionEvent) {
    const current = await port.loadClientAttentionReason(comm.client_id);
    const next = escalateAttention(current, cls.attentionEvent);
    if (next !== current) {
      await port.setClientAttentionReason(comm.client_id, next);
    }
  }

  return cls.optOutEmail ? "opt_out" : "attention_only";
}

export async function POST(req: NextRequest) {
  // Condition 3 — missing secret ⇒ reject (cannot verify, never skip).
  const secret = process.env.MAILERSEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      "mailersend-webhook: MAILERSEND_WEBHOOK_SECRET is not set — rejecting all requests (fail-closed)",
    );
    return NextResponse.json({ error: "not configured" }, { status: 401 });
  }

  const raw = await req.text();
  if (!verifyMailersendSignature(raw, req.headers.get("signature"), secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Signature verified but body is not JSON — ack (don't trigger retries on a
    // body we already trust-verified) and log.
    console.error("mailersend-webhook: verified body was not valid JSON");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  waitUntil(
    processMailersendEvent(payload).catch((e) =>
      console.error("mailersend-webhook: processing failed", e),
    ),
  );
  return NextResponse.json({ received: true }, { status: 200 });
}

// ── Default (real) port over Supabase ────────────────────────────────────────
function createDefaultPort(): MailersendWebhookPort {
  const service = getSupabase();
  return {
    async findCommunicationByMessageId(messageId) {
      const { data, error } = await service
        .from("communications")
        .select("id, client_id, subscriber_id")
        .eq("mailersend_message_id", messageId)
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error("mailersend-webhook: communications lookup failed", error);
        return null;
      }
      return data ?? null;
    },
    async loadPrimaryContact(clientId) {
      const { data, error } = await service
        .from("client_contacts")
        .select("id, is_primary, opt_out_email")
        .eq("client_id", clientId);
      if (error) {
        console.error("mailersend-webhook: client_contacts read failed", error);
        return null;
      }
      // Primary-pick mirrors selectFromContacts (one is_primary per client).
      const primary = (data ?? []).find((c) => c.is_primary);
      return primary ? { id: primary.id, opt_out_email: primary.opt_out_email } : null;
    },
    async loadClientAttentionReason(clientId) {
      const { data, error } = await service
        .from("clients")
        .select("attention_reason")
        .eq("id", clientId)
        .maybeSingle();
      if (error) {
        console.error("mailersend-webhook: attention_reason read failed", error);
        return null;
      }
      return data?.attention_reason ?? null;
    },
    async setContactOptOutEmail(contactId) {
      const { error } = await service
        .from("client_contacts")
        .update({ opt_out_email: true })
        .eq("id", contactId);
      if (error) {
        throw new Error(`mailersend-webhook: opt-out write failed: ${error.message}`);
      }
    },
    async setClientAttentionReason(clientId, reason) {
      const { error } = await service
        .from("clients")
        .update({ attention_reason: reason })
        .eq("id", clientId);
      if (error) {
        throw new Error(`mailersend-webhook: attention_reason write failed: ${error.message}`);
      }
    },
    async updateCommunicationActivity(commId, eventType) {
      const t = eventType.toLowerCase();
      const patch: { status?: string; delivered_at?: string } = {};
      if (t.includes("deliver")) {
        patch.status = "delivered";
        patch.delivered_at = new Date().toISOString();
      } else if (t.includes("open")) {
        patch.status = "opened";
      } else if (t.includes("click")) {
        patch.status = "clicked";
      }
      if (Object.keys(patch).length === 0) return;
      const { error } = await service.from("communications").update(patch).eq("id", commId);
      if (error) {
        console.error(`mailersend-webhook: communications activity update failed: ${error.message}`);
      }
    },
  };
}
