"use client";
import dynamic from "next/dynamic";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";
import type { ClientContactDisplay } from "@/lib/contacts/contactDisplay";
import type { VoiceCallDisplay } from "@/lib/voice-calls";
import type { CommunicationDisplay, TransactionDisplay, BalanceEventDisplay } from "@/lib/data";

const DetailScreen = dynamic(() => import("./DetailScreen"), { ssr: false });

export default function ClientDetailWrapper({
  client,
  invoiceSet,
  contacts,
  voiceCalls,
  communications,
  transactions,
  balanceEvents,
}: {
  client: Client;
  invoiceSet?: ClientInvoiceSet;
  contacts?: ClientContactDisplay[];
  voiceCalls?: VoiceCallDisplay[];
  communications?: CommunicationDisplay[];
  transactions?: TransactionDisplay[];
  balanceEvents?: BalanceEventDisplay[];
}) {
  return (
    <DetailScreen
      client={client}
      invoiceSet={invoiceSet}
      contacts={contacts}
      voiceCalls={voiceCalls}
      communications={communications}
      transactions={transactions}
      balanceEvents={balanceEvents}
    />
  );
}
