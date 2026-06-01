"use client";
import dynamic from "next/dynamic";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";

// Client wrapper: data is fetched server-side, the screen renders client-only
// (it reads localStorage for demo mode).
const ClientListScreen = dynamic(() => import("@/components/portfolio/ClientListScreen"), { ssr: false });

interface Props {
  initialClients: Client[];
  initialClientInvoices: Record<string | number, ClientInvoiceSet>;
}

export default function ClientListLoader({ initialClients, initialClientInvoices }: Props) {
  return <ClientListScreen initialClients={initialClients} initialClientInvoices={initialClientInvoices} />;
}
