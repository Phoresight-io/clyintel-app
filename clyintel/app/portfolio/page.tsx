import { createSupabaseServer } from "@/lib/supabase-server";
import { getUIPortfolio } from "@/lib/data";
import ClientListLoader from "@/components/portfolio/ClientListLoader";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  // TEMP diagnostic — REMOVE before merge. `/portfolio?debug=1` surfaces the
  // resolved auth identity + server-side client count for the logged-in viewer,
  // to confirm WHICH account is being viewed vs where the invoice data lives
  // (all 33 invoices / 30 clients belong to subscriber 34205047 =
  // cwjr27@outlook.com). Service-role query filters purely on subscriber_id =
  // user.id, so a mismatched viewer id → 0 rows.
  const sp = await searchParams;
  const showDebug = sp?.debug === "1";

  return (
    <>
      {showDebug && (
        <pre
          style={{
            margin: 0,
            padding: "10px 16px",
            background: "#111",
            color: "#0f0",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {JSON.stringify(
            {
              viewerUserId: user?.id ?? null,
              viewerEmail: user?.email ?? null,
              serverClientCount: clients.length,
              dataOwner:
                "subscriber 34205047-14e3-45bb-80e2-2fb8da2da910 = cwjr27@outlook.com",
            },
            null,
            2,
          )}
        </pre>
      )}
      <ClientListLoader
        initialClients={clients}
        initialClientInvoices={clientInvoices}
      />
    </>
  );
}
