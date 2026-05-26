"use client";
import dynamic from "next/dynamic";
const DashboardScreen = dynamic(() => import("@/components/dashboard/DashboardScreen"), { ssr: false });
export default function HomePage() { return <DashboardScreen />; }
