import type { Database } from "@/types/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// LEGAL SAFETY GATE — compliance invariant. READ BEFORE EDITING.
//
// isChannelAllowed is the single DETERMINISTIC authority on whether a given
// contact may be reached on a given channel. It exists so that consent/opt-out
// is enforced by code, not judgement.
//
//   • Deterministic & pure: a function of the data passed in only. No LLM, no
//     network, no I/O, no clock. Same inputs → same answer, always.
//   • NEVER LLM-reachable: an LLM must not decide, influence, or be able to
//     bypass this gate. Do not route this through a model, a prompt, or any
//     tool an agent can call to "reconsider". If you need a reason to message,
//     the answer still passes through here unchanged.
//   • Fail-closed: any null/missing contact, unknown channel, or opt-out flag
//     that isn't explicitly `false` → DENY. It never throws into a send path;
//     it returns false.
//
// This is distinct from lib/outreach/eligibility.ts `isContactAllowed`, which is
// the (timing / quiet-hours) permissibility seam. Both must pass before a real
// send — this one is the opt-out/consent gate.
// ─────────────────────────────────────────────────────────────────────────────

export type Channel = "email" | "sms" | "voice";

// Minimal structural shape: just the three per-channel opt-out flags. Accepting a
// structural type (not the full row) keeps the gate usable anywhere a contact's
// opt-outs are known, and keeps it trivially testable.
export type ContactOptOuts = Pick<
  Database["public"]["Tables"]["client_contacts"]["Row"],
  "opt_out_email" | "opt_out_sms" | "opt_out_voice"
>;

/**
 * Deterministic, fail-closed opt-out gate. Returns true ONLY when the contact
 * exists and its opt-out flag for `channel` is explicitly `false`. Anything else
 * — null/undefined contact, null opt-out value, unknown channel — denies.
 */
export function isChannelAllowed(
  contact: ContactOptOuts | null | undefined,
  channel: Channel,
): boolean {
  if (contact == null) return false;
  switch (channel) {
    case "email":
      return contact.opt_out_email === false;
    case "sms":
      return contact.opt_out_sms === false;
    case "voice":
      return contact.opt_out_voice === false;
    default:
      // Unknown channel → deny (fail closed). Exhaustive over Channel, but a
      // runtime value outside the union must never open a send path.
      return false;
  }
}
