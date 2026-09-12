"use client";
import { C } from "@/lib/theme";
import type { VoiceCallDisplay } from "@/lib/voice-calls";
import type { CommunicationDisplay, TransactionDisplay } from "@/lib/data";
import TransactionLog from "@/components/detail/TransactionLog";
import CommunicationLog from "@/components/detail/CommunicationLog";
import VoiceCallLog from "@/components/detail/VoiceCallLog";

interface Props {
  invoiceId: string;
  // Already filtered to this invoice by the caller.
  voiceCalls?: VoiceCallDisplay[];
  communications?: CommunicationDisplay[];
  transactions?: TransactionDisplay[];
  onClose: () => void;
}

export default function ExchangeDrawer({
  invoiceId,
  voiceCalls = [],
  communications = [],
  transactions = [],
  onClose,
}: Props) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.3)", zIndex: 999 }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 500, maxWidth: "100vw", background: "#FFFFFF", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)", zIndex: 1000, display: "flex", flexDirection: "column", fontFamily: C.sans }}>
        <style>{`@keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
        <div style={{ animation: "slideInRight 0.3s ease-out", display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ padding: "24px 28px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1, marginRight: 16 }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: C.text, marginBottom: 4 }}>Invoice History</div>
              <div style={{ fontSize: 15, color: C.textMid, fontWeight: 500, fontFamily: C.mono }}>Invoice {invoiceId}</div>
            </div>
            <button onClick={onClose} style={{ padding: "8px 12px", fontSize: 18, color: C.textMid, fontWeight: 500, background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
            <TransactionLog transactions={transactions} />
            <CommunicationLog communications={communications} />
            <VoiceCallLog calls={voiceCalls} title="Call History" />
          </div>
        </div>
      </div>
    </>
  );
}
