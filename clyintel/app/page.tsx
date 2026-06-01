import { createSupabaseServer } from "@/lib/supabase-server";
import { getUIPortfolio } from "@/lib/data";
import DashboardLoader from "@/components/dashboard/DashboardLoader";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let clients: Client[] = [];
  let clientInvoices: Record<string | number, ClientInvoiceSet> = {};
  if (user) {
    const portfolio = await getUIPortfolio(user.id);
    clients = portfolio.clients;
    clientInvoices = portfolio.clientInvoices;
  }

  return <DashboardLoader initialClients={clients} initialClientInvoices={clientInvoices} />;
}
