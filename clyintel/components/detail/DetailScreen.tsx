"use client";
import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { C } from "@/lib/theme";
import * as mockRaw from "@/lib/mock-data";
import type { Client, NegotiationRec, ClientInvoiceSet } from "@/lib/mock-data";
import { isDemoReset } from "@/lib/demo-mode";
import ExchangeDrawer from "@/components/shared/ExchangeDrawer";
import PTRWidget from "./PTRWidget";
import NegotiationActions from "@/components/dashboard/NegotiationActions";
import { RecCard } from "@/components/dashboard/RecoveryRecModal";

interface Props {
  client: Client;
  // Real Supabase-backed invoice set for this client. When present, the screen
  // renders real data; otherwise it falls back to mock data for demo mode.
  invoiceSet?: ClientInvoiceSet;
}

export default function DetailScreen({ client, invoiceSet }: Props) {
  const isReset = isDemoReset();
  const realMode = invoiceSet !== undefined;
  const negotiationRecs = realMode ? ([] as NegotiationRec[]) : isReset ? ([] as NegotiationRec[]) : mockRaw.negotiationRecs;
  const invoices = realMode ? invoiceSet : isReset ? undefined : mockRaw.clientInvoices[client.id];

  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const [selectedInvoiceForExchanges, setSelectedInvoiceForExchanges] = useState<string | null>(null);
  const [showBack, setShowBack] = useState(false);
  const [recCards, setRecCards] = useState<RecCard[]>(
    negotiationRecs.filter(r => invoices?.outstanding.some(inv => inv.id === r.id)).map(r => ({ ...r, editAmount: r.suggestedAmount, status: "pending" as const }))
  );
  const [activeRecModal, setActiveRecModal] = useState<string | null>(null);

  useEffect(() => {
    const isDirect = sessionStorage.getItem('clyintel_nav_direct') === 'true';
    setShowBack(!isDirect);
    sessionStorage.removeItem('clyintel_nav_direct');
  }, []);

  const backLabel = from === "portfolio" ? "Back to Portfolio" : "Back to Recovery";
  const backHref = from === "portfolio" ? "/portfolio" : "/";

  const scoreColor = client.score >= 80 ? C.green : client.score >= 60 ? C.amber : C.red;
  const scoreLabel = client.score >= 80 ? "Low risk" : client.score >= 60 ? "Medium risk" : "High risk";

  const allActive = invoices ? [...(invoices.outstanding || []), ...(invoices.upcoming || [])] : [];
  const allInvoicesList = invoices ? [...(invoices.outstanding || []), ...(invoices.upcoming || []), ...(invoices.paid || [])] : [];

  const totalPastDue = allActive.filter(i => i.status === "past_due").reduce((s, i) => s + i.amount, 0);
  const totalRecovered = invoices ? (invoices.paid || []).reduce((s, i) => s + i.amount, 0) : 0;
  const totalOutstandingAmt = allActive.reduce((s, i) => s + i.amount, 0);

  const invoiceSummaryStats = [
    { label: "Total Outstanding", value: totalOutstandingAmt > 0 ? `$${totalOutstandingAmt.toLocaleString()}` : "—", color: totalOutstandingAmt > 0 ? C.text : C.textDim },
    { label: "Total Past Due", value: totalPastDue > 0 ? `$${totalPastDue.toLocaleString()}` : "—", color: totalPastDue > 0 ? C.red : C.textDim },
    { label: "Total Recovered", value: totalRecovered > 0 ? `$${totalRecovered.toLocaleString()}` : "—", color: totalRecovered > 0 ? C.green : C.textDim },
  ];

  const prevScore = client.prevScore;
  const scoreDelta = client.score - prevScore;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, padding: "28px 36px", minHeight: 520, fontFamily: C.sans }}>
      <div style={{ marginBottom: 24 }}>
        {showBack && (
          <button onClick={() => router.back()} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 15, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}>
            <span style={{ fontSize: 16 }}>←</span> Back
          </button>
        )}
<div style={{ fontSize: 28, fontWeight: 600, color: C.navy }}>Clyintel Analyzer</div>
      </div>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* Left Panel */}
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text }}>{client.name}</div>
          </div>

          <PTRWidget client={client} />

          <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0 16px" }} />

          {/* Invoice Summary */}
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
            <div style={{ padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>Invoice Summary</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
              {invoiceSummaryStats.map((w, i, arr) => (
                <div key={w.label} style={{ padding: "14px 16px", borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none", textAlign: "center" }}>
                  <div style={{ fontSize: 11, color: C.navy, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>{w.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: w.color, fontFamily: C.mono }}>{w.value}</div>
                </div>
              ))}
            </div>
          </div>

          <NegotiationActions cards={recCards} onUpdate={(id, patch) => setRecCards(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))} activeModal={activeRecModal} setActiveModal={setActiveRecModal} />

          {/* Invoice History Table */}
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>Invoice History</span>
            </div>
            {allInvoicesList.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 20px", color: "#6B7280" }}>No invoices found for this client.</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "120px 120px 120px 100px 120px 1fr 36px", gap: 16, padding: "12px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  <div>Invoice #</div><div>Amount</div><div>Due Date</div><div>Due In</div><div>Status</div><div>Last Activity</div><div />
                </div>
                {allInvoicesList.map((inv, i) => {
                  const isPastDue = inv.status === "past_due";
                  const isPaid = inv.status === "paid";
                  const dueInValue = isPaid ? (inv.paidDate || "—") : isPastDue && inv.daysOverdue ? `-${inv.daysOverdue}d` : inv.daysUntilDue ? `${inv.daysUntilDue}d` : "—";
                  const statusColor = isPaid ? C.green : isPastDue ? C.red : C.text;
                  const statusLabel = isPaid ? "Paid" : isPastDue ? "Past Due" : "Current";
                  return (
                    <div key={inv.id} style={{ display: "grid", gridTemplateColumns: "120px 120px 120px 100px 120px 1fr 36px", gap: 16, padding: "14px 16px", borderBottom: i < allInvoicesList.length - 1 ? `1px solid ${C.border}` : "none", fontSize: 15, alignItems: "center", background: isPaid ? "rgba(22,163,74,0.03)" : "transparent" }}>
                      <div onClick={() => !isPaid && setSelectedInvoiceForExchanges(inv.id)} style={{ fontFamily: C.mono, fontSize: 14, color: isPaid ? C.textMid : C.blue, cursor: isPaid ? "default" : "pointer" }} onMouseEnter={(e) => { if (!isPaid) e.currentTarget.style.color = C.amber; }} onMouseLeave={(e) => { if (!isPaid) e.currentTarget.style.color = C.blue; }}>{inv.id}</div>
                      <div style={{ fontFamily: C.mono, fontSize: 16, color: isPastDue ? C.red : C.text }}>${inv.amount.toLocaleString()}</div>
                      <div style={{ fontSize: 15, color: isPastDue ? C.red : C.textMid }}>{inv.dueDate}</div>
                      <div style={{ fontSize: 14, color: isPaid ? C.green : isPastDue ? C.red : C.text }}>{dueInValue}</div>
                      <div style={{ fontSize: 14, fontWeight: isPaid ? 600 : 400, color: statusColor }}>{statusLabel}</div>
                      <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>{inv.lastActivity}</div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {!isPaid && negotiationRecs.some(r => r.id === inv.id) && (
                          <button onClick={() => setActiveRecModal(inv.id)} title="Recovery recommendation pending" style={{ width: 26, height: 26, borderRadius: "50%", background: C.amberBg, color: C.amber, border: "none", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }} onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.75")} onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}>!</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Right Rail - Client Score */}
        <div style={{ width: 300 }}>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "18px 20px", position: "sticky", top: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 12 }}>Client Score</div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 48, fontWeight: 700, color: scoreColor, fontFamily: C.mono }}>{client.score}</div>
                <div style={{ fontSize: 15, color: C.textMid, fontWeight: 500 }}>
                  <span style={{ color: scoreColor, fontWeight: 600 }}>{scoreDelta > 0 ? "▲" : "▼"} {Math.abs(scoreDelta)}</span> (prev: {prevScore})
                </div>
              </div>
              <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500, marginBottom: 10 }}>out of 100</div>
              <div style={{ height: 6, borderRadius: 3, background: "linear-gradient(to right, #DC2626 0%, #F59E0B 50%, #16A34A 100%)", marginBottom: 12, position: "relative" }}>
                <div style={{ position: "absolute", left: `${client.score}%`, top: -2, width: 10, height: 10, borderRadius: "50%", background: scoreColor, border: "2px solid #FFFFFF" }} />
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: scoreColor, marginBottom: 14 }}>{scoreLabel}</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Score Summary</div>
              <div style={{ paddingLeft: 8 }}>
                {client.scoreSummary.map((line, i) => (
                  <div key={i} style={{ fontSize: 15, fontWeight: 500, color: C.textMid, marginBottom: i < client.scoreSummary.length - 1 ? 6 : 0 }}>• {line}</div>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Score Factors</div>
              <div style={{ paddingLeft: 8 }}>
                {client.scoreFactors.map((line, i) => (
                  <div key={i} style={{ fontSize: 15, fontWeight: 500, color: C.textMid, marginBottom: i < client.scoreFactors.length - 1 ? 6 : 0 }}>• {line}</div>
                ))}
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${C.border}`, margin: "16px 0" }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Risk Drivers</div>
              <div style={{ paddingLeft: 8 }}>
                {client.riskDrivers.map((line, i) => (
                  <div key={i} style={{ fontSize: 15, fontWeight: 500, color: C.textMid, marginBottom: i < client.riskDrivers.length - 1 ? 6 : 0 }}>• {line}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedInvoiceForExchanges && (
        <ExchangeDrawer invoiceId={selectedInvoiceForExchanges} onClose={() => setSelectedInvoiceForExchanges(null)} />
      )}
    </div>
  );
}
