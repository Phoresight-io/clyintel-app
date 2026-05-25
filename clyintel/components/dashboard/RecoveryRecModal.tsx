"use client";
import { useState } from "react";
import { C } from "@/lib/theme";
import { NegotiationRec } from "@/lib/mock-data";

export interface RecCard extends NegotiationRec {
  editAmount: number;
  status: "pending" | "approved" | "dismissed";
}

interface Props {
  card: RecCard;
  onUpdate: (id: string, patch: Partial<RecCard>) => void;
  onClose: () => void;
}

export default function RecoveryRecModal({ card, onUpdate, onClose }: Props) {
  const [editAmount, setEditAmount] = useState(card.editAmount);

  const pctOfOriginal = editAmount > 0 ? Math.round(editAmount / card.invoiceAmount * 100) : 0;
  const concession = card.invoiceAmount - editAmount;
  const suggestedPct = Math.round(card.suggestedAmount / card.invoiceAmount * 100);

  const detailItems = [
    { label: "Amount", value: `$${card.invoiceAmount.toLocaleString()}`, mono: true, color: C.text },
    { label: "Days Overdue", value: `${card.daysOverdue}d`, mono: true, color: C.red },
    { label: "Full Loss Risk", value: card.riskOfFullLoss, mono: true, color: C.red },
    { label: "Last Contact", value: card.lastContact, mono: false, color: C.textMid, fontWeight: 500 },
  ];

  return (
    <div onClick={onClose} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, fontFamily: C.sans }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFFFFF", borderRadius: 12, width: 600, maxHeight: "85vh", overflow: "auto", boxShadow: "0 20px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ padding: "22px 28px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.amber, letterSpacing: "0.08em", textTransform: "uppercase" }}>Agent Recovery Recommendation</span>
              {card.status === "approved" && <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: C.greenBg, padding: "2px 8px", borderRadius: 5 }}>✓ Approved</span>}
              {card.status === "dismissed" && <span style={{ fontSize: 11, fontWeight: 600, color: C.textDim, background: C.surface, padding: "2px 8px", borderRadius: 5 }}>Dismissed</span>}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{card.client}</div>
            <div style={{ fontSize: 13, color: C.textDim, marginTop: 2 }}>Client Score: <span style={{ color: C.red, fontWeight: 700 }}>{card.score}</span></div>
            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: C.mono, color: C.text, marginTop: 4 }}>{card.id}</div>
          </div>
          <button onClick={onClose} style={{ padding: "6px 10px", fontSize: 18, color: C.textMid, fontWeight: 500, background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          {detailItems.map((item, i) => (
            <div key={item.label} style={{ flex: 1, padding: "12px 16px", borderRight: i < detailItems.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 14, fontWeight: 400, color: item.color, fontFamily: item.mono ? C.mono : C.sans }}>{item.value}</div>
            </div>
          ))}
        </div>

        <div style={{ padding: "20px 28px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>AI Rationale</div>
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, lineHeight: 1.7 }}>{card.rationale}</div>
          <div style={{ marginTop: 12, padding: "10px 14px", background: C.surface, borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            <span style={{ fontWeight: 600, color: C.text }}>If no action: </span>{card.alternativeOutcome}
          </div>
        </div>

        <div style={{ padding: "20px 28px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 14 }}>Negotiate Amount</div>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", marginBottom: 20 }}>
            <div style={{ flex: 1, background: C.amberBg, border: `1px solid ${C.amber}33`, borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, color: C.amber, fontWeight: 600, marginBottom: 4 }}>AI Suggested Floor</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: C.amber, fontFamily: C.mono }}>${card.suggestedAmount.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: C.textDim, fontWeight: 500, marginTop: 4 }}>{suggestedPct}% of original · lowest acceptable</div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: C.text, display: "block", marginBottom: 6 }}>
                Your floor amount <span style={{ color: C.textDim, fontWeight: 500 }}>(agent won&apos;t go below this)</span>
              </label>
              <div style={{ display: "flex", alignItems: "center", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden", background: "#FFFFFF", marginBottom: 6 }}>
                <span style={{ padding: "10px 12px", fontSize: 15, color: C.textMid, fontWeight: 500, background: C.surface, borderRight: `1px solid ${C.border}` }}>$</span>
                <input
                  type="number"
                  value={editAmount}
                  onChange={(e) => setEditAmount(Number(e.target.value))}
                  style={{ flex: 1, padding: "10px 12px", fontSize: 15, fontFamily: C.mono, border: "none", outline: "none", color: C.text }}
                />
              </div>
              <div style={{ fontSize: 11, color: C.textDim, fontWeight: 500 }}>
                {editAmount > 0 && `${pctOfOriginal}% of original · $${concession.toLocaleString()} concession`}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
            <button onClick={() => { onUpdate(card.id, { status: "dismissed", editAmount }); onClose(); }} style={{ padding: "9px 20px", fontSize: 14, fontWeight: 600, color: C.textMid, background: "#FFFFFF", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}>Dismiss</button>
            <button onClick={() => { onUpdate(card.id, { status: "approved", editAmount }); onClose(); }} style={{ padding: "9px 20px", fontSize: 14, fontWeight: 700, color: "#FFFFFF", background: C.green, border: "none", borderRadius: 6, cursor: "pointer" }} onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.88")} onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}>Authorize Agent</button>
          </div>
        </div>
      </div>
    </div>
  );
}
