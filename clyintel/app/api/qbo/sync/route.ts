import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { runQboSync } from "@/lib/qbo/runQboSync";

// QuickBooks Online full intake sync. On POST, for the authenticated subscriber:
// pull every Customer + Invoice from QBO and upsert them into clients / invoices.
//
// Thin HTTP wrapper: auth resolution lives here, the sync work lives in
// lib/qbo/runQboSync (shared with the OAuth callback's auto-sync). Observable
// behavior is unchanged from when the body was inline — same auth gate, same
// QboSyncResult JSON on success, same { error } 500 on failure.
//
// Auth: cookie-bound (createSupabaseServer → auth.getUser); user.id IS the
// subscriber id, passed straight to runQboSync. Node runtime (service-role key +
// token decryption); never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  // Auth first — never touch QBO or the DB without an authenticated subscriber.
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    return NextResponse.json(await runQboSync(user.id));
  } catch (err) {
    // The QBO client strips access tokens from its error messages, so echoing
    // the message here is safe. Any throw (token lookup, QBO fetch, upsert) → 500.
    const message = err instanceof Error ? err.message : "QBO sync failed";
    console.error("qbo/sync: failed", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
