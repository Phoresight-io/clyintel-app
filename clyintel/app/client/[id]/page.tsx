import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import {
  getClient,
  getInvoicesByClient,
  getPtrScores,
  getClientContacts,
  getCommunicationsByClient,
  getInvoicePaymentsByClient,
  getBalanceEventsByClient,
} from "@/lib/data";
import { getVoiceCalls } from "@/lib/voice-calls";
import { toUIClient, toUIClientInvoiceSet } from "@/lib/adapters";
import ClientDetailWrapper from "@/components/detail/ClientDetailWrapper";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Numeric ids belong to mock/demo clients; anything else is a real UUID.
  const isMockId = /^\d+$/.test(id);

  if (!isMockId) {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) notFound();

    const client = await getClient(user.id, id);
    // RLS-equivalent scoping: not found, or belongs to another subscriber.
    if (!client) notFound();

    // Invoices first: history rows are matched to the open invoice by invoice_id
    // (the real UUID). Build maps between the UI invoice id (invoice_number || id,
    // mirroring toUIInvoice) and the UUID, and the UUID list balance_events scopes
    // by. balance_events has no client_id, so it's scoped to these invoice UUIDs.
    const invoices = await getInvoicesByClient(user.id, id);
    const invoiceUuids = invoices.map((inv) => inv.id);
    const invoiceUuidByUiId: Record<string, string> = {};
    const invoiceNumberByUuid: Record<string, string> = {};
    for (const inv of invoices) {
      const uiId = inv.invoice_number || inv.id;
      invoiceUuidByUiId[uiId] = inv.id;
      invoiceNumberByUuid[inv.id] = inv.invoice_number || inv.id;
    }

    // getClient already proved ownership; getClientContacts also self-scopes by
    // the client's subscriber_id, so it's safe alongside the other per-client reads.
    const [ptr, contacts, voiceCalls, communications, transactions, balanceEvents] = await Promise.all([
      getPtrScores(user.id, id),
      getClientContacts(user.id, id),
      getVoiceCalls({ clientId: id }),
      getCommunicationsByClient(user.id, id),
      getInvoicePaymentsByClient(user.id, id),
      getBalanceEventsByClient(user.id, invoiceUuids),
    ]);
    const uiClient = toUIClient(client, ptr, invoices);
    const invoiceSet = toUIClientInvoiceSet(invoices);

    return (
      <Suspense fallback={null}>
        <ClientDetailWrapper
          client={uiClient}
          invoiceSet={invoiceSet}
          contacts={contacts}
          voiceCalls={voiceCalls}
          communications={communications}
          transactions={transactions}
          balanceEvents={balanceEvents}
          invoiceUuidByUiId={invoiceUuidByUiId}
          invoiceNumberByUuid={invoiceNumberByUuid}
        />
      </Suspense>
    );
  }

  // Mock/demo clients were flushed (D2 closeout): numeric (non-UUID) ids no
  // longer resolve to a client.
  notFound();
}
