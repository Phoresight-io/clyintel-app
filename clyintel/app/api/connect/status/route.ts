import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { retrieveAccount } from "@/lib/stripe";

// Source-of-truth refresh for a subscriber's Stripe Connect (Express) state.
// Never trust the onboarding return_url redirect alone: this re-reads the live
// account from Stripe, persists the derived status, and returns it. Called by the
// Integrations UI on mount and after the ?connect=complete return.
//
// Disconnected accounts skip the Stripe API call — status is already authoritative
// from the disconnect action and there is no active account to query.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OnboardingStatus = "not_started" | "pending" | "complete" | "restricted" | "disconnected";
type LinkDisposition = "void" | "keep";

export async function GET() {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Cookie-bound read — RLS scopes to the subscriber's own row.
  const { data: row, error: lookupError } = await authClient
    .from("payout_accounts")
    .select("provider_account_id, charges_enabled, payouts_enabled, onboarding_status, last_link_disposition")
    .eq("subscriber_id", user.id)
    .eq("provider", "stripe")
    .maybeSingle();

  if (lookupError) {
    console.error("connect/status: account lookup failed", lookupError);
    return NextResponse.json({ error: "Could not load connect account" }, { status: 500 });
  }

  if (!row || !row.provider_account_id) {
    return NextResponse.json({
      connected: false,
      charges_enabled: false,
      payouts_enabled: false,
      onboarding_status: "not_started" as OnboardingStatus,
      last_link_disposition: null,
    });
  }

  // Disconnected accounts are authoritative from the disconnect action — don't
  // call Stripe (the account may still be active there; the subscriber chose to
  // detach it from ClyIntel).
  if (row.onboarding_status === "disconnected") {
    return NextResponse.json({
      connected: false,
      charges_enabled: false,
      payouts_enabled: false,
      onboarding_status: "disconnected" as OnboardingStatus,
      last_link_disposition: (row.last_link_disposition as LinkDisposition | null) ?? null,
    });
  }

  let account;
  try {
    account = await retrieveAccount(row.provider_account_id);
  } catch (err) {
    console.error("connect/status: Stripe account retrieve failed", err);
    return NextResponse.json({ error: "Could not retrieve Stripe account" }, { status: 502 });
  }

  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const disabledReason = account.requirements?.disabled_reason ?? null;

  let onboardingStatus: OnboardingStatus;
  if (account.details_submitted && chargesEnabled) {
    onboardingStatus = "complete";
  } else if (disabledReason || (account.details_submitted && !chargesEnabled)) {
    onboardingStatus = "restricted";
  } else {
    onboardingStatus = "pending";
  }

  // Persist the fresh values if anything changed (service-role, scoped to
  // user.id). Audit-log only on a real transition.
  const changed =
    row.charges_enabled !== chargesEnabled ||
    row.payouts_enabled !== payoutsEnabled ||
    row.onboarding_status !== onboardingStatus;

  if (changed) {
    const service = getSupabase();
    const { error: updateError } = await service
      .from("payout_accounts")
      .update({
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        onboarding_status: onboardingStatus,
      })
      .eq("subscriber_id", user.id)
      .eq("provider", "stripe");

    if (updateError) {
      console.error("connect/status: failed to persist refreshed status", updateError);
      // Non-fatal: still return the live values we computed.
    } else {
      await service.from("audit_log").insert({
        subscriber_id: user.id,
        actor: "system",
        actor_detail: "connect-status-refresh",
        action: "update_connect_status",
        entity_type: "payout_account",
        entity_id: row.provider_account_id,
        payload: {
          from: {
            charges_enabled: row.charges_enabled,
            payouts_enabled: row.payouts_enabled,
            onboarding_status: row.onboarding_status,
          },
          to: {
            charges_enabled: chargesEnabled,
            payouts_enabled: payoutsEnabled,
            onboarding_status: onboardingStatus,
          },
        } as never,
      });
    }
  }

  return NextResponse.json({
    connected: chargesEnabled && payoutsEnabled,
    charges_enabled: chargesEnabled,
    payouts_enabled: payoutsEnabled,
    onboarding_status: onboardingStatus,
    last_link_disposition: (row.last_link_disposition as LinkDisposition | null) ?? null,
  });
}
