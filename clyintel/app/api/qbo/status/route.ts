import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";

// Read-only QuickBooks connection status for the connections UI. Mirrors
// /api/connect/status (Stripe). Never returns token values — only the masked
// realmId, last-updated, and refresh-token expiry from meta.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function maskRealmId(realmId: string): string {
  const last4 = realmId.slice(-4);
  return `••••${last4}`;
}

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
    .from("connected_accounts")
    .select("external_id, updated_at, meta")
    .eq("subscriber_id", user.id)
    .eq("provider", "quickbooks")
    .maybeSingle();

  if (lookupError) {
    console.error("qbo/status: account lookup failed", lookupError);
    return NextResponse.json({ error: "Could not load QuickBooks status" }, { status: 500 });
  }

  if (!row || !row.external_id) {
    return NextResponse.json({
      connected: false,
      external_id: null,
      updated_at: null,
      refresh_expires_at: null,
    });
  }

  const meta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<
    string,
    unknown
  >;
  const refreshExpiresAt =
    typeof meta.refresh_expires_at === "string" ? meta.refresh_expires_at : null;

  return NextResponse.json({
    connected: true,
    external_id: maskRealmId(row.external_id),
    updated_at: row.updated_at,
    refresh_expires_at: refreshExpiresAt,
  });
}
