import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";

// Authenticated manual invoice entry.
//
// Extracts the user from the session, creates or matches a client by name for
// that subscriber, creates the invoice scoped to `auth.uid()`, and writes an
// audit_log row (actor = 'subscriber', action = 'create_invoice') before
// returning the new invoice id.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateInvoiceBody {
  client?: string;
  invoice?: string;
  amount?: string | number;
  dueDate?: string;
  terms?: string;
  notes?: string;
}

export async function POST(req: NextRequest) {
  // Authenticate against the cookie-bound session.
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: CreateInvoiceBody;
  try {
    body = (await req.json()) as CreateInvoiceBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const clientName = (body.client ?? "").trim();
  if (!clientName) {
    return NextResponse.json({ error: "Client name is required" }, { status: 400 });
  }

  const amountValue = typeof body.amount === "string" ? parseFloat(body.amount) : body.amount;
  const amountCents = Number.isFinite(amountValue) ? Math.round((amountValue as number) * 100) : 0;

  // Service-role client: writes are explicitly scoped to the authenticated
  // user via subscriber_id = user.id. audit_log is service-role-only by design.
  const supabase = getSupabase();

  // Match an existing client by name for this subscriber, or create one.
  const { data: existingClient, error: matchError } = await supabase
    .from("clients")
    .select("id")
    .eq("subscriber_id", user.id)
    .eq("name", clientName)
    .maybeSingle();

  if (matchError) {
    console.error("create-invoice: client match failed", matchError);
    return NextResponse.json({ error: "Failed to look up client" }, { status: 500 });
  }

  let clientId = existingClient?.id ?? null;
  if (!clientId) {
    const { data: newClient, error: clientInsertError } = await supabase
      .from("clients")
      .insert({ subscriber_id: user.id, name: clientName })
      .select("id")
      .single();
    if (clientInsertError || !newClient) {
      console.error("create-invoice: client insert failed", clientInsertError);
      return NextResponse.json({ error: "Failed to create client" }, { status: 500 });
    }
    clientId = newClient.id;
  }

  // Create the invoice scoped to the subscriber.
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      subscriber_id: user.id,
      client_id: clientId,
      invoice_number: body.invoice?.trim() || null,
      amount_cents: amountCents,
      due_date: body.dueDate || null,
      description: body.notes?.trim() || null,
      status: "sent",
      source: "manual",
    })
    .select("id")
    .single();

  if (invoiceError || !invoice) {
    console.error("create-invoice: invoice insert failed", invoiceError);
    return NextResponse.json({ error: "Failed to create invoice" }, { status: 500 });
  }

  // Audit the subscriber action.
  const { error: auditError } = await supabase.from("audit_log").insert({
    subscriber_id: user.id,
    actor: "subscriber",
    actor_detail: user.email ?? null,
    action: "create_invoice",
    entity_type: "invoice",
    entity_id: invoice.id,
    payload: {
      client_id: clientId,
      client_name: clientName,
      invoice_number: body.invoice?.trim() || null,
      amount_cents: amountCents,
      terms: body.terms ?? null,
    } as never,
  });
  if (auditError) console.error("create-invoice: audit_log insert failed", auditError);

  return NextResponse.json({ id: invoice.id, client_id: clientId }, { status: 201 });
}
