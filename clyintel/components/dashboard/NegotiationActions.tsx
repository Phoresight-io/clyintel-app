"use client";
import { C } from "@/lib/theme";
import RecoveryRecModal, { RecCard } from "./RecoveryRecModal";

interface Props {
  cards: RecCard[];
  onUpdate: (id: string, patch: Partial<RecCard>) => void;
  activeModal: string | null;
  setActiveModal: (id: string | null) => void;
}

export default function NegotiationActions({ cards, onUpdate, activeModal, setActiveModal }: Props) {
  const activeCard = cards.find(c => c.id === activeModal);

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: C.navy }}>Recovery Recommendations</div>
      </div>

      {cards.filter(c => c.status !== "dismissed").length === 0 ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "20px 24px" }}>
          <span style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>No recommendations at this time.</span>
        </div>
      ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {cards.filter(c => c.status !== "dismissed").map(card => (
          <div key={card.id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 18px", borderRadius: 8, background: card.status === "approved" ? C.greenBg : C.blueBg }}>
            <div style={{ width: 160 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{card.client}</div>
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 1 }}>Score <span style={{ color: C.red, fontWeight: 700 }}>{card.score}</span></div>
            </div>
            <div style={{ width: 90 }}>
              <div style={{ fontSize: 10, color: C.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>Invoice #</div>
              <div style={{ fontSize: 14, fontFamily: C.mono, fontWeight: 400, color: C.text, marginTop: 2 }}>{card.id}</div>
            </div>
            <div style={{ display: "flex", gap: 24, flex: 1 }}>
              <div>
                <div style={{ fontSize: 10, color: C.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>Original</div>
                <div style={{ fontSize: 14, fontFamily: C.mono, fontWeight: 400, color: C.text }}>${card.invoiceAmount.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>Days Overdue</div>
                <div style={{ fontSize: 14, fontFamily: C.mono, fontWeight: 400, color: C.red }}>{card.daysOverdue}d</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>AI Floor</div>
                <div style={{ fontSize: 14, fontFamily: C.mono, fontWeight: 400, color: C.amber }}>${card.suggestedAmount.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>Loss Risk</div>
                <div style={{ fontSize: 14, fontFamily: C.mono, fontWeight: 400, color: C.red }}>{card.riskOfFullLoss}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {card.status === "approved" && <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>✓ Approved — ${card.editAmount.toLocaleString()}</span>}
              <button onClick={() => setActiveModal(card.id)} style={{ padding: "6px 14px", fontSize: 13, fontWeight: 600, color: card.status === "pending" ? "#FFFFFF" : C.textMid, background: card.status === "pending" ? C.blue : "transparent", border: card.status === "pending" ? "none" : `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }} onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")} onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}>
                {card.status === "pending" ? "Review" : "View"}
              </button>
              {card.status !== "dismissed" && (
                <button onClick={() => onUpdate(card.id, { status: "dismissed" })} style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: C.textDim, fontWeight: 500, display: "flex", alignItems: "center", justifyContent: "center" }} onMouseEnter={(e) => (e.currentTarget.style.color = C.red)} onMouseLeave={(e) => (e.currentTarget.style.color = C.textDim)}>✕</button>
              )}
            </div>
          </div>
        ))}
      </div>
      )}

      {activeCard && (
        <RecoveryRecModal
          card={activeCard}
          onUpdate={onUpdate}
          onClose={() => setActiveModal(null)}
        />
      )}
    </div>
  );
}
