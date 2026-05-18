"use client";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { clients, clientInvoices } from "@/lib/mock-data";

export default function ClientListScreen() {
  const router = useRouter();

  const totalOutstanding = clients.reduce((sum, c) => sum + c.balance, 0);
  const getRecoveryYTD = (id: number): number => ({ 4: 15800, 1: 3200, 2: 8400, 3: 12400, 5: 2800 } as Record<number, number>)[id] || 0;
  const totalRecovery = clients.reduce((sum, c) => sum + getRecoveryYTD(c.id), 0);
  const lowRisk = clients.filter(c => c.score >= 80).length;
  const mediumRisk = clients.filter(c => c.score >= 60 && c.score < 80).length;
  const highRisk = clients.filter(c => c.score < 60).length;
  const scores = clients.map(c => c.score);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);

  const riskItems = [
    { label: "Low Risk", count: lowRisk, color: C.green },
    { label: "Medium Risk", count: mediumRisk, color: C.amber },
    { label: "High Risk", count: highRisk, color: C.red },
  ];

  return (
    <div style={{ padding: "28px 36px", minHeight: 520, fontFamily: C.sans }}>
      <button onClick={() => router.push("/")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 14, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}>
        <span style={{ fontSize: 16 }}>←</span> Back to Recovery
      </button>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 4 }}>Clyintel</div>
      <div style={{ fontSize: 28, fontWeight: 600, color: C.navy, marginBottom: 24 }}>Portfolio Dashboard</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.navy, marginBottom: 12, textTransform: "uppercase" }}>Risk Distribution</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {riskItems.map(item => (
              <div key={item.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: item.color }}>{item.label}</span>
                <span style={{ fontWeight: 600, color: item.color }}>{item.count}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.navy, marginBottom: 12, textTransform: "uppercase" }}>Financial Overview</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: C.textMid }}>Outstanding</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: C.red, fontFamily: C.mono }}>${(totalOutstanding / 1000).toFixed(0)}K</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: C.textMid }}>Recovery YTD</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: C.green, fontFamily: C.mono }}>${(totalRecovery / 1000).toFixed(0)}K</span>
          </div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.navy, marginBottom: 12, textTransform: "uppercase" }}>Portfolio Stats</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: C.textMid }}>Total Clients</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: C.blue, fontFamily: C.mono }}>{clients.length}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: C.textMid }}>Score Range</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: C.text, fontFamily: C.mono }}>{maxScore}–{minScore}</span>
          </div>
        </div>
      </div>

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
            <div key={client.id} onClick={() => router.push(`/client/${client.id}`)} style={{ display: "grid", gridTemplateColumns: "200px 140px 140px 120px 100px 140px 140px", gap: 16, padding: "14px 16px", borderBottom: i < clients.length - 1 ? `1px solid ${C.border}` : "none", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={(e) => (e.currentTarget.style.background = C.blueBg)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.navy }}>{client.name}</div>
              <div style={{ fontSize: 13, color: C.textMid }}>{client.industry}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: scoreColor, fontFamily: C.mono }}>{client.score}</span>
                <span style={{ fontSize: 12, color: scoreDelta > 0 ? C.green : C.red, fontFamily: C.mono }}>{scoreDelta > 0 ? "▲" : "▼"} {Math.abs(scoreDelta)}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: statusColor }}>{statusLabel}</div>
              <div style={{ fontSize: 14, fontFamily: C.mono }}>{currentInvoices}/{client.invoices}</div>
              <div style={{ fontSize: 15, fontWeight: 400, color: client.balance > 0 ? C.red : C.text, fontFamily: C.mono }}>${client.balance.toLocaleString()}</div>
              <div style={{ fontSize: 15, fontWeight: 400, color: recoveryYTD > 0 ? C.green : C.textMid, fontFamily: C.mono }}>{recoveryYTD > 0 ? `$${recoveryYTD.toLocaleString()}` : "—"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
