import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { getRemainingBalance } from "@/lib/recovery/balance";

// Generate a stable Clyintel pay URL for an overdue invoice.
//
// Design: the URL embeds an opaque token (32 random bytes, base64url) that is
// NOT the invoice id. No Stripe call happens here — the Checkout Session is
// minted at click-time (live-resolve) so the amount is always current.
// See GET /pay/[token] for Session creation.
//
// One active link per invoice: if an active link already exists it is voided
// before the new one is inserted. The subscriber is then given the new URL.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getOrigin(req: NextRequest): string {
  return req.nextUrl.origin;
}

export async function POST(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: { invoiceId?: string };
  try {
    body = (await req.json()) as { invoiceId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { invoiceId } = body;
  if (!invoiceId) {
    return NextResponse.json({ error: "invoiceId is required" }, { status: 400 });
  }

  // ── Validate invoice ownership (RLS scopes this to the subscriber) ─────────
  const { data: invoice, error: invErr } = await authClient
    .from("invoices")
    .select("id, subscriber_id, currency, invoice_number, client_id")
    .eq("id", invoiceId)
    .eq("subscriber_id", user.id)
    .maybeSingle();

  if (invErr || !invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  // ── Validate balance ────────────────────────────────────────────────────────
  let balanceCents: number;
  try {
    balanceCents = await getRemainingBalance(invoiceId);
  } catch {
    return NextResponse.json({ error: "Could not compute invoice balance" }, { status: 500 });
  }

  if (balanceCents <= 0) {
    return NextResponse.json({ error: "Invoice has no outstanding balance" }, { status: 422 });
  }

  // ── Validate subscriber's Stripe Connect account is complete ───────────────
  const { data: payout, error: payoutErr } = await authClient
    .from("payout_accounts")
    .select("id, onboarding_status")
    .eq("subscriber_id", user.id)
    .eq("provider", "stripe")
    .maybeSingle();

  if (payoutErr || !payout || payout.onboarding_status !== "complete") {
    return NextResponse.json(
      { error: "Stripe account must be fully connected before generating payment links" },
      { status: 422 }
    );
  }

  // ── Generate token + void any existing active link ─────────────────────────
  const token = randomBytes(32).toString("base64url");
  const service = getSupabase();

  // Void existing active links for this invoice (idempotent — may void none).
  const { error: voidErr } = await service
    .from("recovery_links")
    .update({ link_status: "void", updated_at: new Date().toISOString() })
    .eq("invoice_id", invoiceId)
    .eq("subscriber_id", user.id)
    .eq("link_status", "active");

  if (voidErr) {
    console.error("payment-link: failed to void existing active links", voidErr);
    return NextResponse.json({ error: "Could not void existing link" }, { status: 500 });
  }

  // ── Insert new recovery_links row ──────────────────────────────────────────
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  const { data: link, error: insertErr } = await service
    .from("recovery_links")
    .insert({
      token,
      invoice_id: invoiceId,
      subscriber_id: user.id,
      provider: "stripe",
      link_type: "standard",   // full-balance live-resolve link; 'settlement' reserved for negotiated payoffs
      link_status: "active",
      link_expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (insertErr || !link) {
    console.error("payment-link: failed to insert recovery_links row", insertErr);
    return NextResponse.json({ error: "Could not create payment link" }, { status: 500 });
  }

  // ── Audit log ──────────────────────────────────────────────────────────────
  await service.from("audit_log").insert({
    subscriber_id: user.id,
    actor: "subscriber",
    actor_detail: user.email ?? null,
    action: "create_payment_link",
    entity_type: "recovery_link",
    entity_id: link.id,
    payload: {
      invoice_id: invoiceId,
      token_prefix: token.slice(0, 8),   // log prefix only — never the full token
      balance_cents: balanceCents,
      provider: "stripe",
    } as never,
  });

  const payUrl = `${getOrigin(req)}/pay/${token}`;
  return NextResponse.json({ payUrl });
}
