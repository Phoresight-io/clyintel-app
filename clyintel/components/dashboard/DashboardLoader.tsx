"use client";
import dynamic from "next/dynamic";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";
import type { RecoveryYTD } from "@/lib/recovery/recoveryYTD";

// Client wrapper so the dashboard can be fetched server-side (real data) while
// the screen itself renders client-only (it relies on localStorage for demo
// mode, so SSR is disabled).
const DashboardScreen = dynamic(() => import("@/components/dashboard/DashboardScreen"), { ssr: false });

interface Props {
  initialClients: Client[];
  initialClientInvoices: Record<string | number, ClientInvoiceSet>;
  recoveryYTD?: RecoveryYTD;
}

export default function DashboardLoader({ initialClients, initialClientInvoices, recoveryYTD }: Props) {
  return <DashboardScreen initialClients={initialClients} initialClientInvoices={initialClientInvoices} recoveryYTD={recoveryYTD} />;
}
