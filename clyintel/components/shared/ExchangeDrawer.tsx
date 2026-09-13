"use client";
import { C } from "@/lib/theme";
import type { VoiceCallDisplay } from "@/lib/voice-calls";
import type { CommunicationDisplay, TransactionDisplay, BalanceEventDisplay } from "@/lib/data";
import TransactionLog from "@/components/detail/TransactionLog";
import ExchangeTimeline from "@/components/detail/ExchangeTimeline";

interface Props {
  invoiceId: string;
  clientName?: string;
  // All already filtered to this invoice by the caller.
  transactions?: TransactionDisplay[];
  balanceEvents?: BalanceEventDisplay[];
  communications?: CommunicationDisplay[];
  voiceCalls?: VoiceCallDisplay[];
  onClose: () => void;
}

export default function ExchangeDrawer({
  invoiceId,
  clientName = "Client",
  transactions = [],
  balanceEvents = [],
  communications = [],
  voiceCalls = [],
  onClose,
}: Props) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.3)", zIndex: 999 }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 500, maxWidth: "100vw", background: "#FFFFFF", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)", zIndex: 1000, display: "flex", flexDirection: "column", fontFamily: C.sans }}>
        <style>{`@keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
        <div style={{ animation: "slideInRight 0.3s ease-out", display: "flex", flexDirection: "column", height: "100%" }}>
          {/* Header — matches the existing design */}
          <div style={{ padding: "24px 28px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 600, color: C.text, marginBottom: 4 }}>Recovery Agent Exchanges</div>
              <div style={{ fontSize: 14, color: C.textMid, fontFamily: C.mono }}>Invoice {invoiceId}</div>
            </div>
            <button onClick={onClose} style={{ padding: "8px 12px", fontSize: 18, color: C.textMid, background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
            {/* Distinct Transactions section, above the timeline */}
            <TransactionLog transactions={transactions} balanceEvents={balanceEvents} />

            {/* Chronological exchanges timeline (existing design) */}
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 16 }}>Exchanges</div>
              <ExchangeTimeline communications={communications} voiceCalls={voiceCalls} clientName={clientName} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
