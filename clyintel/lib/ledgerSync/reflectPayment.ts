import { getSupabase } from "../supabase";
import type { Database } from "../../types/supabase";
import {
  qboReflectPayment,
  type ReflectPaymentInput,
  type QboReflectProbeResult,
} from "./adapters/qboAdapter";

/** The connected_accounts.provider enum (source of truth: generated types). */
type IntegrationProvider = Database["public"]["Enums"]["integration_provider"];

const KNOWN_PROVIDERS: readonly IntegrationProvider[] = [
  "stripe",
  "quickbooks",
  "twilio",
  "mailersend",
];

/**
 * Narrow a free-form contract string to the connected_accounts.provider enum.
 * The neutral contract carries `provider` as a plain string; the DB column is
 * enum-typed, so we validate before querying (and a string that isn't a known
 * integration can have no connected row anyway).
 */
function isIntegrationProvider(p: string): p is IntegrationProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(p);
}

// Provider-neutral ledger-sync SEAM + dispatcher (D2, §3 deliverable #1).
//
// This is the single neutral entry point the webhook will call in Phase 1
// ("capture succeeded → reflect this payment"). It knows nothing about any
// specific accounting system: it validates the subscriber's connection, then
// dispatches to the matching provider adapter (<platform>ReflectPayment).
//
// Naming convention (LOCKED): this public entry is UNPREFIXED (reflectPayment);
// provider implementations are PREFIXED (qboReflectPayment, …).
//
// Safety contract: this function NEVER throws. It is designed to be called from
// inside a webhook handler, where a thrown error would break the money path — so
// every failure (missing connection, unsupported provider, adapter throw) is
// returned as a typed result the caller can switch on.
//
// Relative imports (not the @/ alias) match the capture/money-path convention
// (see handleCheckoutCompleted.ts / qboAdapter.ts) so vitest — which runs
// without the alias — can mock the supabase + adapter seams.
//
// Phase 0 scope: dispatch + validation only. NOT wired into
// handleCheckoutCompleted (Phase 1), no Payment write, no fee logic, no
// idempotency enforcement, no second adapter. The ledgerRowId dedupe key flows
// through the contract unchanged so Phase 1 can enforce idempotency downstream.

/** Typed skip reasons — a skip is a VALID outcome, not an error. */
export type ReflectPaymentSkipReason = "no_connected_account" | "unsupported_provider";

/**
 * Discriminated result of the seam. Phase 1's webhook wiring switches on it:
 *   - `ok: true`                → success passthrough (the adapter's result).
 *   - `ok: false, skipped:true` → a typed, expected skip (do nothing).
 *   - `ok: false` (no skipped)  → a typed error (log; the payment still happened).
 */
export type ReflectPaymentResult =
  | QboReflectProbeResult
  | { ok: false; skipped: true; reason: ReflectPaymentSkipReason }
  | { ok: false; error: string };

/**
 * Neutral seam. Validates the subscriber's connected account for the passed-in
 * provider, then dispatches to that provider's adapter. Never throws.
 */
export async function reflectPayment(
  input: ReflectPaymentInput,
): Promise<ReflectPaymentResult> {
  const supabase = getSupabase();

  // A provider string that isn't even a known integration enum value can have no
  // connected_accounts row — treat it as a missing connection (and it keeps the
  // enum-typed .eq() below sound).
  if (!isIntegrationProvider(input.provider)) {
    return { ok: false, skipped: true, reason: "no_connected_account" };
  }
  const provider = input.provider; // narrowed to IntegrationProvider

  // Validate the passed-in provider against the DB: the row must exist for THIS
  // subscriber AND THIS provider (the enum-typed connected_accounts.provider).
  const { data: row, error } = await supabase
    .from("connected_accounts")
    .select("id, provider")
    .eq("subscriber_id", input.subscriberId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) {
    // A lookup failure is infra, not a business skip — surface as a typed error
    // rather than throwing into the webhook.
    return { ok: false, error: `connected_accounts lookup failed: ${error.message}` };
  }
  if (!row) {
    return { ok: false, skipped: true, reason: "no_connected_account" };
  }

  // Only 'quickbooks' has an adapter in Phase 0. Any other (valid, connected)
  // provider is a typed skip until its adapter lands.
  if (provider !== "quickbooks") {
    return { ok: false, skipped: true, reason: "unsupported_provider" };
  }

  // Dispatch. The adapter's result is returned UNCHANGED (passthrough). The
  // ledgerRowId dedupe key travels inside `input` untouched.
  try {
    return await qboReflectPayment(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
