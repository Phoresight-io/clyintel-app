import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/types/supabase";

// Recipient selection seam. v1 is PRIMARY-ONLY: for a client, return its single
// is_primary=true contact. The `strategy` parameter exists so future modes plug
// into the SAME function without a new call site — but v1 returns primary-only
// regardless of strategy. No send happens here; this only chooses who would be
// contacted. The opt-out/consent gate is isChannelAllowed (applied by the caller
// at send time in Brick 1), not here.

export type ContactRow = Database["public"]["Tables"]["client_contacts"]["Row"];

// v1 honors none of these but "primary"; the rest are documented backlog seams.
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
