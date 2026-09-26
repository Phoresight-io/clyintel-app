import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";

// subscribers.business_name — the name the subscriber CHOOSES for their
// customers. The Recovery Agent says it on calls ("calling from …") and it signs
// payment/cadence emails (lib/voice/buildCallVariables.ts,
// lib/outreach/sendEmailStep.ts; both fall back to "our team" when empty).
//
// Set by the subscriber in Settings → Profile. QuickBooks' CompanyName is only a
// suggestion: on QBO connect it pre-fills an EMPTY name and never overwrites one.

export const BUSINESS_NAME_MAX = 120;

export type ValidateBusinessNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: string };

/** Pure: trim; reject empty; max 120 characters. Client- and server-safe. */
export function validateBusinessName(raw: unknown): ValidateBusinessNameResult {
  if (typeof raw !== "string") return { ok: false, reason: "Enter a business name." };
  const name = raw.trim();
  if (name === "") return { ok: false, reason: "Enter a business name." };
  if (name.length > BUSINESS_NAME_MAX) {
    return { ok: false, reason: `Business name must be ${BUSINESS_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, name };
}

export type PrefillResult =
  | { action: "set"; name: string }
  | { action: "kept_existing" } // the subscriber already has a name: never overwritten
  | { action: "no_company_name" } // QBO returned nothing usable
  | { action: "error"; reason: string };

/**
 * On QuickBooks connect: if the subscriber's business_name is empty, set it to
 * QBO's CompanyName. Never overwrites a non-empty value. The update is guarded
 * on the value just read, so a name saved concurrently in Settings still wins.
 * NEVER throws: a CompanyInfo or DB failure is returned (and logged by the
 * caller) so it can't fail the connect flow.
 */
export async function prefillBusinessNameFromQbo(
  service: SupabaseClient<Database>,
  subscriberId: string,
  fetchCompanyName: () => Promise<string | null>,
): Promise<PrefillResult> {
  try {
    const { data: row, error: readError } = await service
      .from("subscribers")
      .select("business_name")
      .eq("id", subscriberId)
      .maybeSingle();
    if (readError) return { action: "error", reason: `subscriber read failed: ${readError.message}` };
    if (!row) return { action: "error", reason: "subscriber not found" };
    const current = row.business_name ?? "";
    if (current.trim() !== "") return { action: "kept_existing" };

    const suggested = validateBusinessName((await fetchCompanyName()) ?? "");
    if (!suggested.ok) return { action: "no_company_name" };

    const { data: updated, error: updateError } = await service
      .from("subscribers")
      .update({ business_name: suggested.name })
      .eq("id", subscriberId)
      .eq("business_name", current)
      .select("id");
    if (updateError) return { action: "error", reason: `subscriber update failed: ${updateError.message}` };
    // 0 rows: the name changed since the read (set in Settings) — leave it.
    return (updated?.length ?? 0) === 1 ? { action: "set", name: suggested.name } : { action: "kept_existing" };
  } catch (e) {
    return { action: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}
