"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { C } from "@/lib/theme";
import { clientInvoices, Client } from "@/lib/mock-data";
import ExchangeDrawer from "@/components/shared/ExchangeDrawer";

interface Props {
  client: Client;
}

export default function DetailScreen({ client }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const [selectedInvoiceForExchanges, setSelectedInvoiceForExchanges] = useState<string | null>(null);

  const backLabel = from === "portfolio" ? "Back to Portfolio" : "Back to Recovery";
  const backHref = from === "portfolio" ? "/portfolio" : "/";

  const scoreColor = client.score >= 80 ? C.green : client.score >= 60 ? C.amber : C.red;
  const scoreLabel = client.score >= 80 ? "Low risk" : client.score >= 60 ? "Medium risk" : "High risk";

  const invoices = clientInvoices[client.id];
  const allActive = invoices ? [...(invoices.outstanding || []), ...(invoices.upcoming || [])] : [];
  const allInvoicesList = invoices ? [...(invoices.outstanding || []), ...(invoices.upcoming || []), ...(invoices.paid || [])] : [];

  const totalPastDue = allActive.filter(i => i.status === "past_due").reduce((s, i) => s + i.amount, 0);
  const totalRecovered = invoices ? (invoices.paid || []).reduce((s, i) => s + i.amount, 0) : 0;
  const totalOutstandingAmt = allActive.reduce((s, i) => s + i.amount, 0);

  const isLowRisk = client.score >= 80;
  const accentColor = isLowRisk ? C.green : C.amber;
  const accentBg = isLowRisk ? C.greenBg : C.amberBg;
  const terms = isLowRisk ? "Net 30 with standard terms" : "Net 15 with 2% early payment discount";
  const reminder = isLowRisk ? "-7, -3, 0 days" : "-14, -7, -3, 0 days";
  const reminderLabel = isLowRisk ? "3-touch sequence" : "4-touch escalation";
  const whyText = isLowRisk
    ? "Strong payment history supports standard terms. Low risk profile enables a flexible payment schedule without increasing exposure. The 3-touch reminder sequence maintains top-of-mind awareness without being intrusive."
    : "Shorter terms reduce your exposure window. The 2% early payment incentive directly addresses cash flow constraints that drive late payments. The 4-touch escalation sequence increases urgency progressively to maximize on-time collection.";
  const lossReduction = isLowRisk ? "12%" : "38%";
  const revenueImpact = isLowRisk ? "$525" : "$3,224";

  const invoiceSummaryStats = [
    { label: "Total Outstanding", value: `$${totalOutstandingAmt.toLocaleString()}`, color: C.text },
    { label: "Total Past Due", value: totalPastDue > 0 ? `$${totalPastDue.toLocaleString()}` : "—", color: totalPastDue > 0 ? C.red : C.textDim },
    { label: "Total Recovered", value: totalRecovered > 0 ? `$${totalRecovered.toLocaleString()}` : "—", color: totalRecovered > 0 ? C.green : C.textDim },
  ];

  const prevScore = client.score >= 80 ? 82 : 52;
  const scoreDelta = client.score - prevScore;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, padding: "28px 36px", minHeight: 520, fontFamily: C.sans }}>
      <div style={{ marginBottom: 24 }}>
        <button onClick={() => router.push(backHref)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 14, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}>
          <span style={{ fontSize: 16 }}>←</span> {backLabel}
        </button>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 4 }}>Clyintel</div>
        <div style={{ fontSize: 28, fontWeight: 600, color: C.navy }}>Clyintel Analyzer</div>
      </div>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* Left Panel */}
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text }}>{client.name}</div>
          </div>

          {/* PTR Widget */}
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ padding: "14px 20px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Payment Terms Recommendation</div>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 24 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Terms</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{terms}</div>
                </div>
                <div style={{ width: 1, background: C.border, alignSelf: "stretch" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Reminder Strategy</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.blue }}>{reminder}</div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{reminderLabel}</div>
                </div>
              </div>
            </div>
            <div style={{ padding: "0 20px 14px" }}>
              <div style={{ background: accentBg, border: `1px solid ${accentColor}22`, borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: accentColor, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Why this matters</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.text, lineHeight: 1.7 }}>{whyText}</div>
              </div>
            </div>
            <div style={{ padding: "0 20px 20px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Projections</div>
              <div style={{ display: "flex", gap: 0 }}>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontSize: 11, color: C.textMid, fontWeight: 600, marginBottom: 8 }}>Decrease Loss By</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: C.green, fontFamily: C.mono, lineHeight: 1 }}>{lossReduction}</div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>vs. current terms</div>
                </div>
                <div style={{ width: 1, background: C.border, margin: "0 4px" }} />
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontSize: 11, color: C.textMid, fontWeight: 600, marginBottom: 8 }}>Revenue Impact</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: isLowRisk ? C.green : C.red, fontFamily: C.mono, lineHeight: 1 }}>{revenueImpact}</div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>est. annual delay cost</div>
                </div>
              </div>
            </div>
          </div>

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

          {/* Invoice History Table */}
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>Invoice History</span>
            </div>
            {allInvoicesList.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 20px", color: "#6B7280" }}>No invoices found for this client.</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "120px 120px 120px 100px 120px 1fr", gap: 16, padding: "12px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  <div>Invoice #</div><div>Amount</div><div>Due Date</div><div>Due In</div><div>Status</div><div>Last Activity</div>
                </div>
                {allInvoicesList.map((inv, i) => {
                  const isPastDue = inv.status === "past_due";
                  const isPaid = inv.status === "paid";
                  const dueInValue = isPaid ? (inv.paidDate || "—") : isPastDue && inv.daysOverdue ? `-${inv.daysOverdue}d` : inv.daysUntilDue ? `${inv.daysUntilDue}d` : "—";
                  const statusColor = isPaid ? C.green : isPastDue ? C.red : C.text;
                  const statusLabel = isPaid ? "Paid" : isPastDue ? "Past Due" : "Current";
                  return (
                    <div key={inv.id} style={{ display: "grid", gridTemplateColumns: "120px 120px 120px 100px 120px 1fr", gap: 16, padding: "14px 16px", borderBottom: i < allInvoicesList.length - 1 ? `1px solid ${C.border}` : "none", fontSize: 14, alignItems: "center", background: isPaid ? "rgba(22,163,74,0.03)" : "transparent" }}>
                      <div onClick={() => !isPaid && setSelectedInvoiceForExchanges(inv.id)} style={{ fontFamily: C.mono, fontSize: 13, color: isPaid ? C.textMid : C.blue, cursor: isPaid ? "default" : "pointer" }} onMouseEnter={(e) => { if (!isPaid) e.currentTarget.style.color = C.amber; }} onMouseLeave={(e) => { if (!isPaid) e.currentTarget.style.color = C.blue; }}>{inv.id}</div>
                      <div style={{ fontFamily: C.mono, fontSize: 15, color: isPastDue ? C.red : C.text }}>${inv.amount.toLocaleString()}</div>
                      <div style={{ fontSize: 14, color: isPastDue ? C.red : C.textMid }}>{inv.dueDate}</div>
                      <div style={{ fontSize: 13, color: isPaid ? C.green : isPastDue ? C.red : C.text }}>{dueInValue}</div>
                      <div style={{ fontSize: 13, fontWeight: isPaid ? 600 : 400, color: statusColor }}>{statusLabel}</div>
                      <div style={{ fontSize: 13, color: C.textMid }}>{inv.lastActivity}</div>
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
                <div style={{ fontSize: 14, color: C.textMid }}>
                  <span style={{ color: scoreColor, fontWeight: 600 }}>{scoreDelta > 0 ? "▲" : "▼"} {Math.abs(scoreDelta)}</span> (prev: {prevScore})
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.textMid, marginBottom: 10 }}>out of 100</div>
              <div style={{ height: 6, borderRadius: 3, background: "linear-gradient(to right, #DC2626 0%, #F59E0B 50%, #16A34A 100%)", marginBottom: 12, position: "relative" }}>
                <div style={{ position: "absolute", left: `${client.score}%`, top: -2, width: 10, height: 10, borderRadius: "50%", background: scoreColor, border: "2px solid #FFFFFF" }} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: scoreColor, marginBottom: 14 }}>{scoreLabel}</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Score Summary</div>
              <div style={{ paddingLeft: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.textMid, marginBottom: 6 }}>• Frequent delays</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.textMid }}>• Below average payer</div>
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Score Factors</div>
              <div style={{ paddingLeft: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.textMid, marginBottom: 6 }}>• 6 of 8 invoices paid late</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.textMid }}>• Avg delay: 26 days</div>
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${C.border}`, margin: "16px 0" }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Risk Drivers</div>
              <div style={{ paddingLeft: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.textMid, marginBottom: 6 }}>• Lump-sum billing is the primary risk driver</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.textMid }}>• No late fee penalties applied to past due payments</div>
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
