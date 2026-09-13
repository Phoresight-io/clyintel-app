import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { getVoiceCalls } from "@/lib/voice-calls";
import {
  getCommunicationsByClient,
  getInvoicePaymentsByClient,
  getBalanceEventsByClient,
} from "@/lib/data";

// Per-invoice history for the Exchange drawer, so the dashboard (a cross-client,
// client-rendered screen that can't call the service-role fetches directly) gets
// the SAME data the client-detail page assembles server-side. Reuses the exact
// same lib fetches + invoice_id filtering as DetailScreen, so behavior matches.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMPTY = { voiceCalls: [], communications: [], transactions: [], balanceEvents: [] };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Resolve the UI invoice id (invoice_number OR uuid) to the real invoice within
  // this subscriber, using the service-role client scoped to userId.
  const supabase = getSupabase();
  let { data: invoice } = await supabase
    .from("invoices")
    .select("id, client_id")
    .eq("subscriber_id", user.id)
    .eq("invoice_number", id)
    .maybeSingle();

  if (!invoice && UUID_RE.test(id)) {
    ({ data: invoice } = await supabase
      .from("invoices")
      .select("id, client_id")
      .eq("subscriber_id", user.id)
      .eq("id", id)
      .maybeSingle());
  }

  if (!invoice) {
    return NextResponse.json(EMPTY);
  }

  const invoiceUuid = invoice.id;
  const clientId = invoice.client_id;

  const [voiceCalls, communicationsAll, transactionsAll, balanceEvents] = await Promise.all([
    getVoiceCalls({ invoiceId: invoiceUuid }),
    getCommunicationsByClient(user.id, clientId),
    getInvoicePaymentsByClient(user.id, clientId),
    getBalanceEventsByClient(user.id, [invoiceUuid]),
  ]);

  // Filter the client-wide lists to this invoice, exactly as DetailScreen does.
  const communications = communicationsAll.filter((c) => c.invoice_id === invoiceUuid);
  const transactions = transactionsAll.filter((t) => t.invoice_id === invoiceUuid);

  return NextResponse.json({ voiceCalls, communications, transactions, balanceEvents });
}
