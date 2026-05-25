"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { clients, clientInvoices } from "@/lib/mock-data";

export default function ClientListScreen() {
  const router = useRouter();
  const [showBack, setShowBack] = useState(false);

  useEffect(() => {
    const isDirect = sessionStorage.getItem('clyintel_nav_direct') === 'true';
    setShowBack(!isDirect);
    sessionStorage.removeItem('clyintel_nav_direct');
  }, []);

  const getRecoveryYTD = (id: number): number => ({ 4: 15800, 1: 3200, 2: 8400, 3: 12400, 5: 2800 } as Record<number, number>)[id] || 0;

  return (
    <div style={{ padding: "28px 36px", minHeight: 520, fontFamily: C.sans }}>
      {showBack && (
        <button onClick={() => router.back()} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 15, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}>
          <span style={{ fontSize: 16 }}>←</span> Back
        </button>
      )}
      <div style={{ fontSize: 28, fontWeight: 600, color: C.navy, marginBottom: 24 }}>Portfolio Dashboard</div>

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "200px 140px 140px 120px 100px 140px 140px", gap: 16, padding: "12px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase" }}>
          <div>Client Name</div><div>Industry</div><div>Score</div><div>Status</div><div>Invoices</div><div>Outstanding</div><div>Recovery YTD</div>
        </div>
        {clients.map((client, i) => {
          const scoreColor = client.score >= 80 ? C.green : client.score >= 60 ? C.amber : C.red;
          const recoveryYTD = getRecoveryYTD(client.id);
          const scoreDelta = client.score - client.prevScore;
          let statusColor = C.red, statusLabel = "Past Due";
          if (client.status === "recovered") { statusColor = C.green; statusLabel = "Paid"; }
          else if (client.status === "current") { statusColor = C.green; statusLabel = "Current"; }
          else if (client.status === "due") { statusColor = C.amber; statusLabel = "Due Soon"; }
          const invoices = clientInvoices[client.id];
          const currentInvoices = invoices ? (invoices.outstanding?.length || 0) + (invoices.upcoming?.length || 0) : 0;

          return (
            <div key={client.id} onClick={() => { sessionStorage.removeItem('clyintel_nav_direct'); router.push(`/client/${client.id}`); }} style={{ display: "grid", gridTemplateColumns: "200px 140px 140px 120px 100px 140px 140px", gap: 16, padding: "14px 16px", borderBottom: i < clients.length - 1 ? `1px solid ${C.border}` : "none", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={(e) => (e.currentTarget.style.background = C.blueBg)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.navy }}>{client.name}</div>
              <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>{client.industry}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: scoreColor, fontFamily: C.mono }}>{client.score}</span>
                <span style={{ fontSize: 13, color: scoreDelta > 0 ? C.green : C.red, fontFamily: C.mono }}>{scoreDelta > 0 ? "▲" : "▼"} {Math.abs(scoreDelta)}</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: statusColor }}>{statusLabel}</div>
              <div style={{ fontSize: 15, fontFamily: C.mono }}>{currentInvoices}/{client.invoices}</div>
              <div style={{ fontSize: 16, fontWeight: 400, color: client.balance > 0 ? C.red : C.text, fontFamily: C.mono }}>${client.balance.toLocaleString()}</div>
              <div style={{ fontSize: 16, fontWeight: 500, color: recoveryYTD > 0 ? C.green : C.textMid, fontFamily: C.mono }}>{recoveryYTD > 0 ? `$${recoveryYTD.toLocaleString()}` : "—"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
