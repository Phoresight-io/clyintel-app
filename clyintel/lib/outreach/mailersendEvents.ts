import crypto from "crypto";
import {
  deriveAttentionReason,
  ATTENTION_REASON,
  type AttentionReason,
  type UnreachabilityEvent,
} from "@/lib/outreach/deriveAttentionReason";

// Pure, deterministic helpers for the MailerSend inbound webhook. No I/O, no LLM.
// Everything here is the mechanical mapping of MailerSend event payloads onto the
// codebase's existing contracts (deriveAttentionReason, the opt-out flags).

// ── Signature verification ───────────────────────────────────────────────────
// MailerSend signs the webhook with HMAC-SHA256 over the RAW request body, hex,
// in the `Signature` header (no timestamp component, unlike Stripe). Fail-closed:
// missing/malformed header → false. timingSafeEqual to avoid a timing oracle.
export function verifyMailersendSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  let headerBuf: Buffer;
  try {
    headerBuf = Buffer.from(header, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length !== headerBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, headerBuf);
}

// ── Payload extraction ───────────────────────────────────────────────────────
// The message id that matches communications.mailersend_message_id (the send's
// X-Message-Id) appears in the activity webhook at data.email.message.id.
export function extractMessageId(payload: unknown): string | null {
  const p = payload as { data?: { email?: { message?: { id?: unknown }; id?: unknown } } };
  const msg = p?.data?.email?.message?.id;
  if (typeof msg === "string" && msg) return msg;
  const emailId = p?.data?.email?.id;
  if (typeof emailId === "string" && emailId) return emailId;
  return null;
}

export function extractEventType(payload: unknown): string {
  const p = payload as { type?: unknown; data?: { type?: unknown } };
  if (typeof p?.type === "string") return p.type;
  if (typeof p?.data?.type === "string") return p.data.type;
  return "";
}

// ── Event classification (deterministic, never-LLM) ──────────────────────────
export interface EventClass {
  optOutEmail: boolean; // set opt_out_email=true on the resolved contact
  attentionEvent: UnreachabilityEvent | null; // feed deriveAttentionReason
  activity: boolean; // delivered/open/click → communications status only
}

/**
 * Map a MailerSend event type (e.g. "activity.hard_bounced") to its action.
 *   spam         → opt-out + attention(spam_complaint)
 *   unsubscribe  → opt-out + attention(opt_out)
 *   hard_bounce  → attention(hard_bounce) ONLY — no opt-out (we follow
 *                  deriveAttentionReason; a bounce is unreachable, not a consent
 *                  withdrawal, so we never hardcode a parallel opt-out rule)
 *   soft_bounce  → ignore (transient; not an unreachability event)
 *   delivered/open/click/sent → activity (communications status), never opt-out
 *   anything else → no-op
 */
export function classifyMailersendEvent(rawType: string): EventClass {
  const t = rawType.toLowerCase();
  if (t.includes("spam")) return { optOutEmail: true, attentionEvent: "spam_complaint", activity: false };
  if (t.includes("unsubscrib")) return { optOutEmail: true, attentionEvent: "opt_out", activity: false };
  if (t.includes("hard_bounc") || t.includes("hard-bounc") || t.includes("hardbounce")) {
    return { optOutEmail: false, attentionEvent: "hard_bounce", activity: false };
  }
  if (t.includes("soft_bounc") || t.includes("soft-bounc") || t.includes("softbounce")) {
    return { optOutEmail: false, attentionEvent: null, activity: false }; // ignore
  }
  if (t.includes("deliver") || t.includes("open") || t.includes("click") || t.endsWith(".sent") || t === "sent") {
    return { optOutEmail: false, attentionEvent: null, activity: true };
  }
  return { optOutEmail: false, attentionEvent: null, activity: false }; // unknown → no-op
}

// ── Severity-monotonic attention escalation ──────────────────────────────────
// Forward (reason→event) and inverse are COLOCATED here so they cannot drift.
// Total over the three reason codes. deriveAttentionReason remains the SINGLE
// authority on severity ordering — we never compare severities here.
const REASON_TO_EVENT: Record<AttentionReason, UnreachabilityEvent> = {
  [ATTENTION_REASON.opt_out]: "opt_out",
  [ATTENTION_REASON.hard_bounce]: "hard_bounce",
  [ATTENTION_REASON.spam_complaint]: "spam_complaint",
};

/**
 * Combine the account's CURRENT attention_reason (mapped back to its event) with
 * the INCOMING event, then re-derive. The stored reason only ever escalates: a
 * later hard_bounce can never downgrade an existing spam_complaint. Null-safe:
 * a null/unknown current reason contributes no phantom prior event. `incoming`
 * is always attention-worthy at the call site, so the result is never null.
 */
export function escalateAttention(
  current: string | null,
  incoming: UnreachabilityEvent,
): AttentionReason {
  const events: UnreachabilityEvent[] = [incoming];
  if (current != null && Object.prototype.hasOwnProperty.call(REASON_TO_EVENT, current)) {
    events.push(REASON_TO_EVENT[current as AttentionReason]);
  }
  // Non-null: `events` always contains `incoming` (an attention-worthy event).
  return deriveAttentionReason(events) as AttentionReason;
}
