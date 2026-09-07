import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/types/supabase";

// Recipient selection seam. Two ORTHOGONAL axes live here:
//
//   • CHANNEL axis (selectForChannel, below) — WHICH single contact to reach on a
//     given channel: channel-aware + opt-out-aware, dunning(rank 1)→poc fallback.
//     This is what the send path uses (email is the only wired channel today).
//   • STRATEGY axis (selectFromContacts / RecipientStrategy, further down) — HOW
//     MANY recipients (primary / all / ai_escalation). v1 is primary-only; kept
//     as a documented backlog seam, NOT wired to sends.
//
// No send happens here; this only chooses who would be contacted. selectForChannel
// already filters opt-out + address, but isChannelAllowed still runs at the caller
// as a final fail-closed check on the chosen contact.

export type ContactRow = Database["public"]["Tables"]["client_contacts"]["Row"];

// ── CHANNEL axis: descriptor + per-channel selection ─────────────────────────
// A ChannelDescriptor makes selection REPEATABLE: adding a channel = add its
// descriptor + a call, no rewrite. Email is the first (and only wired) instance;
// SMS/voice descriptors are deliberately NOT defined yet (future bricks).
export type ChannelDescriptor = {
  channel: "email" | "sms" | "voice";
  rankColumn: "email_rank" | "sms_rank" | "voice_rank";
  optOutField: "opt_out_email" | "opt_out_sms" | "opt_out_voice";
  addressField: "email" | "phone";
};

export const EMAIL_CHANNEL: ChannelDescriptor = {
  channel: "email",
  rankColumn: "email_rank",
  optOutField: "opt_out_email",
  addressField: "email",
};

/**
 * Channel-aware, opt-out-aware selection of the ONE contact to reach on `ch`.
 * A contact is eligible for the channel only if it has that channel's address
 * (non-empty, trimmed) AND is not opted out of that channel. Precedence (v1, NO
 * rank-walking — deferred to Agent-2 escalation per D3):
 *   a. contact_type='dunning' with rankColumn===1 AND eligible → that contact
 *   b. else contact_type='poc' AND eligible → that contact
 *   c. else null (unsendable on this channel)
 * An INELIGIBLE rank-1 dunning falls straight to poc — never to a rank-2 dunning.
 * Pure, no I/O. There is at most one rank-1 per (client, channel) via the partial
 * unique index, but `find` is defensive regardless.
 */
export function selectForChannel(
  contacts: ContactRow[],
  ch: ChannelDescriptor,
): ContactRow | null {
  const eligible = (c: ContactRow): boolean => {
    const addr = c[ch.addressField];
    return typeof addr === "string" && addr.trim() !== "" && c[ch.optOutField] === false;
  };
  const dunning = contacts.find(
    (c) => c.contact_type === "dunning" && c[ch.rankColumn] === 1 && eligible(c),
  );
  if (dunning) return dunning;
  const poc = contacts.find((c) => c.contact_type === "poc" && eligible(c));
  return poc ?? null;
}

// ── STRATEGY axis: how-many-recipients (backlog seam, NOT wired to sends) ─────
// Orthogonal to the channel axis above. v1 honors none of these but "primary";
// the rest are documented backlog seams. Still keyed on is_primary — retired with
// the is_primary column in a later brick.
//   - "all":          every contact (multi-recipient outreach).           [backlog c]
//   - "ai_escalation": start with primary, widen to all on non-response.  [backlog c]
export type RecipientStrategy = "primary" | "all" | "ai_escalation";

/**
 * Pure selection over already-fetched contacts (no I/O — the unit-testable core).
 * v1: the primary contact only. Empty array = no primary → caller treats the
 * client as unsendable (e.g. the 1 email-less client that got no primary in 0a).
 */
export function selectFromContacts(
  contacts: ContactRow[],
  strategy: RecipientStrategy = "primary",
): ContactRow[] {
  // Deferred branches (all fall through to primary-only in v1):
  //   if (strategy === "all") return contacts;
  //   if (strategy === "ai_escalation") return /* primary now, widen later */;
  void strategy;
  const primary = contacts.find((c) => c.is_primary);
  return primary ? [primary] : [];
}

/**
 * Fetch the client's contacts and apply the v1 selection. Returns [] on a read
 * error (fail-closed → unsendable) or when the client has no primary contact.
 */
export async function selectRecipients(
  clientId: string,
  strategy: RecipientStrategy = "primary",
): Promise<ContactRow[]> {
  const service = getSupabase();
  const { data, error } = await service
    .from("client_contacts")
    .select("*")
    .eq("client_id", clientId);

  if (error) {
    console.error("selectRecipients: client_contacts read failed", error);
    return []; // fail closed → unsendable
  }

  return selectFromContacts(data ?? [], strategy);
}
