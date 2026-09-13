// Monthly Settlement Sweep — runtime config read from public.app_config.
//
// app_config is a key / value(jsonb) / updated_at table. These helpers read the
// two settlement knobs with safe defaults so an unset key never crashes a run.
// Both use the service-role client (app_config is not subscriber-owned).
//
// Keys (jsonb value shapes):
//   settlement_sweep_enabled   boolean  — the KILL-SWITCH. Persisting settlements
//                                          requires this to be exactly `true`.
//                                          Fail-safe: unset / anything-but-true ⇒
//                                          disabled, so a real charge cycle can
//                                          never fire by accident.
//   settlement_min_charge_cents number   — minimum cycle total (cents) to bill;
//                                          below it a subscriber is carried.
//                                          Default 50 (Stripe USD card minimum).

import type { SupabaseClient } from "@supabase/supabase-js";

export const MIN_CHARGE_CENTS_KEY = "settlement_min_charge_cents";
export const SWEEP_ENABLED_KEY = "settlement_sweep_enabled";

/** Stripe's USD card minimum is 50¢; used when settlement_min_charge_cents is unset. */
export const DEFAULT_MIN_CHARGE_CENTS = 50;

// Minimal typed reader — returns the raw jsonb value or null when the key is
// absent. Uses a permissive client type so tests can inject a stub.
async function readValue(
  service: Pick<SupabaseClient, "from">,
  key: string,
): Promise<unknown> {
  const { data, error } = await service
    .from("app_config")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    throw new Error(`app_config read failed for key ${key}: ${error.message}`);
  }
  return data ? (data as { value: unknown }).value : null;
}

/** Minimum cycle total (cents) to bill. Falls back to DEFAULT_MIN_CHARGE_CENTS. */
export async function getMinChargeCents(
  service: Pick<SupabaseClient, "from">,
): Promise<number> {
  const value = await readValue(service, MIN_CHARGE_CENTS_KEY);
  // Accept a bare jsonb number; ignore anything non-numeric / non-finite / negative.
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_MIN_CHARGE_CENTS;
}

/**
 * Kill-switch. Persisting requires an EXPLICIT `true`. Unset, false, or any
 * non-true value ⇒ disabled (fail-safe), so nothing writes by accident.
 */
export async function isSweepEnabled(
  service: Pick<SupabaseClient, "from">,
): Promise<boolean> {
  const value = await readValue(service, SWEEP_ENABLED_KEY);
  return value === true;
}
