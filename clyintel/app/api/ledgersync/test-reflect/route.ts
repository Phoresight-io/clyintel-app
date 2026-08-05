import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { reflectPayment } from "@/lib/ledgerSync/reflectPayment";

// ⚠️ PHASE 0 TEST-ONLY PROVING ROUTE — safe to delete after the E2E proof. ⚠️
//
// Dashboard-triggerable hook (D2, §3 deliverable #4) that lets Charles prove the
// whole payment-writeback chain end-to-end WITHOUT a real payment. It calls the
// neutral seam reflectPayment() for the authenticated subscriber against the QBO
// sandbox. A successful response — { ok:true, provider:'quickbooks',
// probe:'read-verified' } — proves, in one call: session auth worked, the seam
// dispatched on the real enum value 'quickbooks', getValidAccessToken
// refreshed/validated the token, and the sandbox GET round-trip on the invoice
// succeeded. ZERO writes to books.
//
// NOT wired into handleCheckoutCompleted. No Payment write, no fee logic, no
// idempotency — the seam/adapter are read-only in Phase 0.
//
// Node runtime (token decryption is Node-only); never cached — mirrors qbo/sync.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Auth first — the cookie-bound Supabase session IS the guard (same pattern as
  // every other privileged route: qbo/sync, connect/expire-links). No env flag,
  // no header secret.
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const subscriberId = user.id; // user.id IS the subscriber id (session-derived).

  // Optional override of the sandbox invoice to probe; defaults to txnId 145.
  let body: { externalInvoiceId?: string } = {};
  try {
    body = (await request.json()) as { externalInvoiceId?: string };
  } catch {
    // No/invalid JSON body → use defaults. A bare POST is a valid probe.
  }

  // The LOCKED neutral contract. Provider is fixed to 'quickbooks' for this
  // Phase 0 probe; the remaining fields are placeholders because nothing writes.
  const input = {
    subscriberId,
    provider: "quickbooks",
    externalInvoiceId: body.externalInvoiceId ?? "145",
    amountPaidCents: 0, // placeholder — Phase 0 does not write
    currency: "USD",
    capturePaymentId: "phase0-test-hook",
    ledgerRowId: "phase0-test-hook",
  };

  // The seam returns typed results and never throws — surface it verbatim (always
  // 200) so the dashboard can read probe:'read-verified' or the skip/error reason.
  const result = await reflectPayment(input);
  return NextResponse.json(result);
}
