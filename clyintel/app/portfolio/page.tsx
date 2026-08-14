import { createSupabaseServer } from "@/lib/supabase-server";
import { getUIPortfolio } from "@/lib/data";
import ClientListLoader from "@/components/portfolio/ClientListLoader";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
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

  return <ClientListLoader initialClients={clients} initialClientInvoices={clientInvoices} />;
}
