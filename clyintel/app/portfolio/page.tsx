import { headers } from "next/headers";
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

  // TEMP auth diagnostic — REMOVE before merge. `/portfolio?authdebug=1` proves,
  // with real runtime values, whether the account-menu identity seed works:
  //   - xUserEmailHeader: the value middleware forwards (what the ROOT LAYOUT
  //     seeds initialEmail from). Non-null here ⇒ the menu WILL paint CW+email.
  //   - pageGetUserEmail: a page-level getUser() on the same request (shows
  //     whether a second server-side getUser() also resolves, i.e. the race).
  const sp = await searchParams;
  const showAuthDebug = sp?.authdebug === "1";
  const h = await headers();

  return (
    <>
      {showAuthDebug && (
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
              xUserEmailHeader: h.get("x-user-email"), // middleware-forwarded seed
              pageGetUserEmail: user?.email ?? null, // page-level getUser() result
              serverClientCount: clients.length,
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
