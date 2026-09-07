"use client";
import dynamic from "next/dynamic";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";
import type { ClientContactDisplay } from "@/lib/contacts/contactDisplay";

const DetailScreen = dynamic(() => import("./DetailScreen"), { ssr: false });

export default function ClientDetailWrapper({
  client,
  invoiceSet,
  contacts,
}: {
  client: Client;
  invoiceSet?: ClientInvoiceSet;
  contacts?: ClientContactDisplay[];
}) {
  return <DetailScreen client={client} invoiceSet={invoiceSet} contacts={contacts} />;
}
