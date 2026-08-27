// Pure, deterministic, reason-coded derivation of clients.attention_reason.
//
// Attention fires on an UNREACHABILITY EVENT — the account can no longer be
// reached the way we thought: an opt-out, a hard bounce, or a spam complaint.
// It does NOT fire on a transient soft-bounce (mailbox full, greylisting) — those
// are retryable, not attention-worthy — and it does NOT fire on a resting
// opt-out STATE (a steady, legitimate preference is not an event).
//
// SCOPE (Brick 0b): this file ships the pure function + reason codes ONLY.
// Nothing calls it yet. The webhook events that feed it and the write to
// clients.attention_reason land in Brick 1. No I/O, no LLM here.

// The events that warrant attention. `soft_bounce` is deliberately absent.
export type UnreachabilityEvent = "opt_out" | "hard_bounce" | "spam_complaint";

// Stable reason codes stored in clients.attention_reason (text). Kept as string
// constants (not a DB enum yet) so Brick 1 can settle the set before freezing it.
export const ATTENTION_REASON = {
  opt_out: "contact_opted_out",
  hard_bounce: "email_hard_bounce",
  spam_complaint: "spam_complaint",
} as const;

export type AttentionReason = (typeof ATTENTION_REASON)[keyof typeof ATTENTION_REASON];

// Severity order, most severe first — the derived reason is the most severe
// event present. spam complaint > hard bounce > opt-out.
const SEVERITY: readonly UnreachabilityEvent[] = ["spam_complaint", "hard_bounce", "opt_out"];

/**
 * Derive the attention reason from the unreachability events observed for an
 * account. Returns the most-severe reason code, or null when there is nothing
 * attention-worthy. Deterministic and order-independent (severity, not input
 * order, decides). Unknown/soft-bounce events are ignored.
 */
export function deriveAttentionReason(
  events: readonly UnreachabilityEvent[],
): AttentionReason | null {
  for (const ev of SEVERITY) {
    if (events.includes(ev)) return ATTENTION_REASON[ev];
  }
  return null;
}

/** True iff this event is attention-worthy (i.e. not a transient soft-bounce). */
export function isAttentionWorthy(event: string): event is UnreachabilityEvent {
  return (SEVERITY as readonly string[]).includes(event);
}
