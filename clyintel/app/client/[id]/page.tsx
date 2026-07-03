import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getClient, getInvoicesByClient, getPtrScores } from "@/lib/data";
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

    const [invoices, ptr] = await Promise.all([
      getInvoicesByClient(user.id, id),
      getPtrScores(user.id, id),
    ]);
    const uiClient = toUIClient(client, ptr, invoices);
    const invoiceSet = toUIClientInvoiceSet(invoices);

    return (
      <Suspense fallback={null}>
        <ClientDetailWrapper client={uiClient} invoiceSet={invoiceSet} />
      </Suspense>
    );
  }

  // Mock/demo clients were flushed (D2 closeout): numeric (non-UUID) ids no
  // longer resolve to a client.
  notFound();
}
