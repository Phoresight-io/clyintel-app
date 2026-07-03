"use client";
import { useState } from "react";
import { C } from "@/lib/theme";
import type { Exchange, NegotiationRec } from "@/lib/mock-data";
import RecoveryRecModal, { RecCard } from "@/components/dashboard/RecoveryRecModal";

interface Props {
  invoiceId: string;
  onClose: () => void;
}

export default function ExchangeDrawer({ invoiceId, onClose }: Props) {
  // Mock data flushed (D2 closeout); no real communications/negotiation source yet (D3).
  const exchanges: Exchange[] = [];
  const rec = ((): NegotiationRec | undefined => undefined)();
  const [activeRec, setActiveRec] = useState<RecCard | null>(null);
  const channelIcons: Record<string, string> = { "Voice": "📞", "Email": "📧", "Text": "💬" };
  const channelColors: Record<string, string> = { "Voice": C.blue, "Email": C.blue, "Text": C.green };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.3)", zIndex: 999 }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 500, background: "#FFFFFF", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)", zIndex: 1000, display: "flex", flexDirection: "column", fontFamily: C.sans }}>
        <style>{`@keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
        <div style={{ animation: "slideInRight 0.3s ease-out", display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ padding: "24px 28px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1, marginRight: 16 }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: C.text, marginBottom: 4 }}>Communications</div>
              <div style={{ fontSize: 15, color: C.textMid, fontWeight: 500, fontFamily: C.mono }}>Invoice {invoiceId}</div>
              {rec && (
                <div style={{ marginTop: 12, padding: "10px 14px", background: C.amberBg, border: `1px solid ${C.amber}33`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.amber }}>Recovery Recommendation</span>
                  <button onClick={() => setActiveRec({ ...rec, editAmount: rec.suggestedAmount, status: "pending" })} style={{ padding: "5px 12px", fontSize: 13, fontWeight: 600, color: "#fff", background: C.amber, border: "none", borderRadius: 5, cursor: "pointer" }}>Review</button>
                </div>
              )}
            </div>
            <button onClick={onClose} style={{ padding: "8px 12px", fontSize: 18, color: C.textMid, fontWeight: 500, background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
            {exchanges.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {exchanges.map((ex, idx) => (
                  <div key={idx} style={{ borderLeft: `3px solid ${channelColors[ex.channel] || C.textMid}`, paddingLeft: 16, paddingBottom: 16, borderBottom: idx < exchanges.length - 1 ? `1px solid ${C.border}` : "none" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16 }}>{channelIcons[ex.channel] || "📋"}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#FFFFFF", background: channelColors[ex.channel] || C.textMid, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>{ex.channel}</span>
                        <span style={{ fontSize: 14, color: C.blue, fontFamily: C.mono, fontWeight: 500 }}>{ex.contact}</span>
                      </div>
                      <span style={{ fontSize: 14, color: C.textMid, fontWeight: 500, fontFamily: C.mono }}>{ex.timestamp}</span>
                    </div>
                    <div style={{ fontSize: 14, color: C.textMid, marginBottom: 4 }}><span style={{ color: C.text, fontWeight: 500 }}>From:</span> {ex.from}</div>
                    <div style={{ fontSize: 14, color: C.textMid, marginBottom: 10 }}><span style={{ color: C.text, fontWeight: 500 }}>To:</span> {ex.to}</div>
                    <div style={{ fontSize: 15, color: C.text, marginBottom: 8, lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600, color: C.textMid }}>{ex.channel === "Email" ? "Body" : ex.channel === "Text" ? "Message" : "Summary"}:</span> {ex.message}
                    </div>
                    {ex.outcome && <div style={{ fontSize: 15, color: C.text, fontWeight: 600, marginTop: 10 }}><span style={{ color: C.amber }}>Outcome:</span> {ex.outcome}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "40px 20px", color: C.textMid, fontWeight: 500, fontSize: 14 }}>No exchanges recorded for this invoice yet.</div>
            )}
          </div>
        </div>
      </div>
      {activeRec && (
        <RecoveryRecModal card={activeRec} onUpdate={() => {}} onClose={() => setActiveRec(null)} />
      )}
    </>
  );
}
