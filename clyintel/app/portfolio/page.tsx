"use client";
import dynamic from "next/dynamic";
const ClientListScreen = dynamic(() => import("@/components/portfolio/ClientListScreen"), { ssr: false });
export default function PortfolioPage() { return <ClientListScreen />; }
