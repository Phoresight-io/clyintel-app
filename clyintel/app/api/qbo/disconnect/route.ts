import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";

// Disconnect a subscriber's QuickBooks Online connection from ClyIntel.
// SOFT-VOID (mirrors the Stripe /api/connect/disconnect auth/scope pattern):
// null the tokens + external_id and stamp disconnected_at, but KEEP the row for
// audit. The realm is preserved in meta.disconnected_external_id.
//
// Why null external_id: both GET /api/qbo/status and getValidAccessToken derive
// "connected" from external_id / access_token being present, so nulling them makes
// the connection read as disconnected with NO change to those paths. A later
// reconnect (/api/qbo/connect → callback) upserts external_id + fresh tokens on
// (subscriber_id, provider), restoring the connection.
//
// Idempotent: disconnecting an already-disconnected (or never-connected) account
// is a no-op success — the update simply matches a row whose tokens are already
// null, or matches no row.
//
// Auth: cookie-bound (createSupabaseServer → auth.getUser); user.id IS the
// subscriber id. The write uses the service-role client so it isn't gated by
// per-row RLS, but every filter is scoped to user.id so it can only touch the
// caller's own row. Node runtime (service-role key); never cached.

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

  // Read the current row (service role; scoped to the caller) so we can preserve
  // the realm in meta for audit and no-op cleanly when there's nothing to void.
  const { data: row, error: lookupError } = await service
    .from("connected_accounts")
    .select("external_id, meta")
    .eq("subscriber_id", user.id)
    .eq("provider", "quickbooks")
    .maybeSingle();

  if (lookupError) {
    console.error("qbo/disconnect: account lookup failed", lookupError);
    return NextResponse.json({ error: "Could not disconnect QuickBooks" }, { status: 500 });
  }

  // No connection (or already voided) → idempotent success.
  if (!row || !row.external_id) {
    return NextResponse.json({ disconnected: true });
  }

  const prevMeta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<
    string,
    unknown
  >;

  const { error: updateError } = await service
    .from("connected_accounts")
    .update({
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      external_id: null,
      disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      meta: { ...prevMeta, disconnected_external_id: row.external_id },
    })
    .eq("subscriber_id", user.id)
    .eq("provider", "quickbooks");

  if (updateError) {
    console.error("qbo/disconnect: failed to soft-void connection", updateError);
    return NextResponse.json({ error: "Could not disconnect QuickBooks" }, { status: 500 });
  }

  await service.from("audit_log").insert({
    subscriber_id: user.id,
    actor: "subscriber",
    actor_detail: null,
    action: "disconnect_quickbooks",
    entity_type: "connected_account",
    entity_id: null,
    payload: { provider: "quickbooks", realm_id: row.external_id } as never,
  });

  return NextResponse.json({ disconnected: true });
}
