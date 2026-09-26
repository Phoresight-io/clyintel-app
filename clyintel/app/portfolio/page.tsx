import { createSupabaseServer } from "@/lib/supabase-server";
import { getUIPortfolio } from "@/lib/data";
import ClientListLoader from "@/components/portfolio/ClientListLoader";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";
import { RECOVERY_YTD_UNAVAILABLE, type RecoveryYTD } from "@/lib/recovery/recoveryYTD";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let clients: Client[] = [];
  let clientInvoices: Record<string | number, ClientInvoiceSet> = {};
  let recoveryYTD: RecoveryYTD = RECOVERY_YTD_UNAVAILABLE;
  if (user) {
    const portfolio = await getUIPortfolio(user.id);
    clients = portfolio.clients;
    clientInvoices = portfolio.clientInvoices;
    recoveryYTD = portfolio.recoveryYTD;
  }

  return <ClientListLoader initialClients={clients} initialClientInvoices={clientInvoices} recoveryYTD={recoveryYTD} />;
}
