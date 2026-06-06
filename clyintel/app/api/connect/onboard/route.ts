import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { createExpressAccount, createAccountOnboardingLink } from "@/lib/stripe";

// Create-or-resume Stripe Connect (Express) onboarding for the authenticated
// subscriber (PRD v2.2 §2 — Revenue Share). Creates the Express account on first
// run, then mints a fresh single-use Account Link and returns its hosted URL for
// the client to redirect to. refresh_url points back here so an expired link
// regenerates seamlessly. Account creation is the live, money-adjacent step —
// requires STRIPE_SECRET_KEY, so this is run from the local machine.
//
// Webhook sync and the per-invoice payment link are deliberately out of scope
// here (Prompts 3 and 4).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Allow both POST (button click) and GET (Stripe refresh_url redirect). On GET we
// redirect the browser straight to the regenerated Account Link rather than
// returning JSON.
async function startOnboarding(req: NextRequest): Promise<
  | { ok: true; url: string }
  | { ok: false; status: number; error: string }
> {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }

  // Cookie-bound client: RLS scopes this read to the subscriber's own row.
  const { data: existing, error: lookupError } = await authClient
    .from("stripe_connect_accounts")
    .select("id, stripe_account_id, onboarding_status")
    .eq("subscriber_id", user.id)
    .maybeSingle();

  if (lookupError) {
    console.error("connect/onboard: account lookup failed", lookupError);
    return { ok: false, status: 500, error: "Could not load connect account" };
  }

  const service = getSupabase();
  let accountId = existing?.stripe_account_id ?? null;

  // Create the Express account only when we don't already have one. If a row
  // exists with a stripe_account_id but onboarding isn't complete, we skip
  // creation and go straight to a fresh Account Link.
  if (!accountId) {
    try {
      const account = await createExpressAccount(user.email ?? "", user.id);
      accountId = account.id;
    } catch (err) {
      console.error("connect/onboard: Express account creation failed", err);
      return { ok: false, status: 502, error: "Could not create Stripe account" };
    }

    // Upsert on the unique subscriber_id: insert on first run, attach the
    // account id if a bare row somehow already exists. Service-role client,
    // explicitly scoped to user.id.
    const { error: upsertError } = await service
      .from("stripe_connect_accounts")
      .upsert(
        {
          subscriber_id: user.id,
          stripe_account_id: accountId,
          account_type: "express",
          onboarding_status: "pending",
        },
        { onConflict: "subscriber_id" }
      );

    if (upsertError) {
      console.error("connect/onboard: failed to persist connect account", upsertError);
      return { ok: false, status: 500, error: "Could not save connect account" };
    }

    // Per CONSTITUTION #10, log the account creation (service-role, scoped to
    // the subscriber) around the write.
    await service.from("audit_log").insert({
      subscriber_id: user.id,
      actor: "subscriber",
      actor_detail: user.email ?? null,
      action: "create_connect_account",
      entity_type: "stripe_connect_account",
      entity_id: accountId,
      payload: { stripe_account_id: accountId, account_type: "express" } as never,
    });
  }

  // Fresh, single-use onboarding link. return_url surfaces the Settings billing
  // view (which re-checks status server-of-truth); refresh_url regenerates the
  // link if it expired or was already visited.
  const origin = req.nextUrl.origin;
  try {
    const url = await createAccountOnboardingLink({
      accountId,
      returnUrl: `${origin}/settings?tab=billing&connect=complete`,
      refreshUrl: `${origin}/api/connect/onboard`,
    });
    return { ok: true, url };
  } catch (err) {
    console.error("connect/onboard: account link creation failed", err);
    return { ok: false, status: 502, error: "Could not start onboarding" };
  }
}

export async function POST(req: NextRequest) {
  const result = await startOnboarding(req);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ url: result.url });
}

// Stripe redirects the browser here via refresh_url when a link expires. Mint a
// new one and 303-redirect straight to it.
export async function GET(req: NextRequest) {
  const result = await startOnboarding(req);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.redirect(result.url, { status: 303 });
}
