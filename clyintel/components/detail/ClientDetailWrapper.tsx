"use client";
import dynamic from "next/dynamic";
import type { Client } from "@/lib/mock-data";

const DetailScreen = dynamic(() => import("./DetailScreen"), { ssr: false });

export default function ClientDetailWrapper({ client }: { client: Client }) {
  return <DetailScreen client={client} />;
}
