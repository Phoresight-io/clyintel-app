import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";

// Disconnect a subscriber's Stripe Express account from ClyIntel.
// Sets onboarding_status = 'disconnected' and records the subscriber's chosen
// link disposition. Does NOT delete the Stripe account — the provider_account_id
// is retained so the same-account reconnect path is possible.
//
// If linkDisposition is 'void', active recovery_links are immediately expired.
// If 'keep', they remain live until the subscriber reconnects with a different
// account (at which point expire-links handles cleanup).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LinkDisposition = "void" | "keep";

interface DisconnectBody {
  linkDisposition: LinkDisposition;
}

export async function POST(req: NextRequest) {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: DisconnectBody;
  try {
    body = (await req.json()) as DisconnectBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { linkDisposition } = body;
  if (linkDisposition !== "void" && linkDisposition !== "keep") {
    return NextResponse.json({ error: "linkDisposition must be 'void' or 'keep'" }, { status: 400 });
  }

  const service = getSupabase();

  const { error: updateError } = await service
    .from("payout_accounts")
    .update({
      onboarding_status: "disconnected",
      last_link_disposition: linkDisposition,
    })
    .eq("subscriber_id", user.id)
    .eq("provider", "stripe");

  if (updateError) {
    console.error("connect/disconnect: failed to update status", updateError);
    return NextResponse.json({ error: "Could not disconnect account" }, { status: 500 });
  }

  if (linkDisposition === "void") {
    const { error: expireError } = await service
      .from("recovery_links")
      .update({ link_status: "expired" })
      .eq("subscriber_id", user.id)
      .eq("link_status", "active");

    if (expireError) {
      console.error("connect/disconnect: failed to expire recovery links", expireError);
      // Non-fatal — disconnect succeeded; log but continue.
    }
  }

  await service.from("audit_log").insert({
    subscriber_id: user.id,
    actor: "subscriber",
    actor_detail: null,
    action: "disconnect_connect_account",
    entity_type: "payout_account",
    entity_id: null,
    payload: { provider: "stripe", link_disposition: linkDisposition } as never,
  });

  return NextResponse.json({ ok: true });
}
