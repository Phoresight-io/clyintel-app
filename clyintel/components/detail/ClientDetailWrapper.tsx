"use client";
import dynamic from "next/dynamic";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";

const DetailScreen = dynamic(() => import("./DetailScreen"), { ssr: false });

export default function ClientDetailWrapper({ client, invoiceSet }: { client: Client; invoiceSet?: ClientInvoiceSet }) {
  return <DetailScreen client={client} invoiceSet={invoiceSet} />;
}
