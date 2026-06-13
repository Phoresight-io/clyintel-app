import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";

// Called when a subscriber reconnects with a potentially different Stripe account
// and chooses to expire the kept-live recovery links. Also clears
// last_link_disposition so the reconnect warning does not re-surface.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const service = getSupabase();

  const { error: expireError } = await service
    .from("recovery_links")
    .update({ link_status: "expired" })
    .eq("subscriber_id", user.id)
    .eq("link_status", "active");

  if (expireError) {
    console.error("connect/expire-links: failed to expire recovery links", expireError);
    return NextResponse.json({ error: "Could not expire recovery links" }, { status: 500 });
  }

  await service
    .from("payout_accounts")
    .update({ last_link_disposition: null })
    .eq("subscriber_id", user.id)
    .eq("provider", "stripe");

  return NextResponse.json({ ok: true });
}
