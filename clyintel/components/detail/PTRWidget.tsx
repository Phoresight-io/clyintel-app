"use client";
import { useState } from "react";
import { C } from "@/lib/theme";
import { Client, ptrRecommendations } from "@/lib/mock-data";

type PTRState = "idle" | "generating" | "result";

const ANALYSIS_STEPS = [
  "Analyzing payment history",
  "Evaluating industry benchmarks",
  "Calculating risk exposure",
  "Generating recommendation",
];

const CONFIDENCE_COLORS = {
  High:   { text: C.green,  bg: C.greenBg  },
  Medium: { text: C.amber,  bg: C.amberBg  },
  Low:    { text: C.red,    bg: C.redBg    },
};

interface Props {
  client: Client;
}

export default function PTRWidget({ client }: Props) {
  const [ptrState, setPtrState] = useState<PTRState>("result");
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const [applied, setApplied] = useState(false);

  const rec = ptrRecommendations[client.id];
  const scoreColor = client.score >= 80 ? C.green : client.score >= 60 ? C.amber : C.red;
  const scoreLabel = client.score >= 80 ? "Low risk" : client.score >= 60 ? "Medium risk" : "High risk";

  const handleGenerate = () => {
    setPtrState("generating");
    setCompletedSteps([]);
    setApplied(false);

    ANALYSIS_STEPS.forEach((_, idx) => {
      setTimeout(() => {
        setCompletedSteps(prev => [...prev, idx]);
        if (idx === ANALYSIS_STEPS.length - 1) {
          setTimeout(() => setPtrState("result"), 500);
        }
      }, (idx + 1) * 520);
    });
  };

  const handleRegenerate = () => {
    setPtrState("idle");
    setTimeout(handleGenerate, 50);
  };

  /* ── IDLE ─────────────────────────────────────────────── */
  if (ptrState === "idle") {
    return (
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
        <div style={{ padding: "14px 20px 12px", background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em" }}>Payment Terms Recommendation</span>
          <span style={{ fontSize: 11, fontWeight: 500, color: C.textDim, fontFamily: C.mono }}>PTR</span>
        </div>

        <div style={{ padding: "20px 20px 22px" }}>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", marginBottom: 20 }}>
            {/* Score snapshot */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", minWidth: 120, textAlign: "center", flexShrink: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Score</div>
              <div style={{ fontSize: 30, fontWeight: 700, color: scoreColor, fontFamily: C.mono, lineHeight: 1, marginBottom: 4 }}>{client.score}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: scoreColor }}>{scoreLabel}</div>
            </div>

            {/* Context */}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: C.text, lineHeight: 1.6, marginBottom: 12 }}>
                Generate a data-driven payment terms recommendation for <strong>{client.name}</strong> based on their payment history, industry benchmarks, and risk score.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {rec?.keyFactors.slice(0, 3).map((f, i) => (
                  <div key={i} style={{ fontSize: 12, color: C.textMid, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: scoreColor, fontWeight: 700, marginTop: 1 }}>•</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={handleGenerate}
            style={{ width: "100%", padding: "11px 0", fontSize: 13, fontWeight: 600, color: "#FFFFFF", background: C.navy, border: "none", borderRadius: 7, cursor: "pointer", letterSpacing: "0.01em", transition: "opacity 0.15s" }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            Generate Recommendation
          </button>
        </div>
      </div>
    );
  }

  /* ── GENERATING ───────────────────────────────────────── */
  if (ptrState === "generating") {
    return (
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
        <div style={{ padding: "14px 20px 12px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em" }}>Payment Terms Recommendation</span>
        </div>
        <div style={{ padding: "28px 24px 30px" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 20 }}>
            Analyzing {client.name}…
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {ANALYSIS_STEPS.map((step, idx) => {
              const done = completedSteps.includes(idx);
              const active = !done && completedSteps.length === idx;
              return (
                <div key={step} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                    background: done ? C.green : active ? C.blueBg : C.surface,
                    border: `1.5px solid ${done ? C.green : active ? C.blue : C.border}`,
                    transition: "all 0.3s",
                  }}>
                    {done && <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>✓</span>}
                    {active && (
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.blue, display: "block", animation: "pulse 1s ease-in-out infinite" }} />
                    )}
                  </div>
                  <span style={{
                    fontSize: 13,
                    fontWeight: done ? 500 : active ? 600 : 400,
                    color: done ? C.text : active ? C.blue : C.textDim,
                    transition: "color 0.3s",
                  }}>
                    {step}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  /* ── RESULT ───────────────────────────────────────────── */
  if (!rec) return null;

  const confColors = CONFIDENCE_COLORS[rec.confidence];
  const revColor = rec.revImpactSign === "positive" ? C.green : rec.revImpactSign === "negative" ? C.red : C.textMid;

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 16, animation: "fadeUp 0.25s ease" }}>
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
      `}</style>

      {/* Header */}
      <div style={{ padding: "12px 20px", background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em" }}>Payment Terms Recommendation</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: confColors.text, background: confColors.bg, borderRadius: 10, padding: "2px 10px" }}>
          {rec.confidence} confidence
        </span>
      </div>

      {/* Terms + Reminder */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr", padding: "18px 20px 16px", gap: 0 }}>
        <div style={{ paddingRight: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Recommended Terms</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: rec.discount ? 4 : 0 }}>{rec.terms}</div>
          {rec.discount && (
            <div style={{ fontSize: 12, color: C.green, fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}>
              <span>＋</span> {rec.discount}
            </div>
          )}
        </div>
        <div style={{ background: C.border }} />
        <div style={{ paddingLeft: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Reminder Strategy</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
            {rec.reminderDays.map(day => {
              const isOverdue = day > 0;
              const isToday = day === 0;
              return (
                <span key={day} style={{
                  fontSize: 11, fontWeight: 600, fontFamily: C.mono,
                  color: isOverdue ? "#fff" : isToday ? C.navy : C.blue,
                  background: isOverdue ? C.red : isToday ? C.navy : C.blueBg,
                  borderRadius: 5, padding: "3px 7px",
                }}>
                  {isToday ? "Due" : day > 0 ? `+${day}d` : `${day}d`}
                </span>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: C.textDim }}>{rec.reminderLabel}</div>
        </div>
      </div>

      {/* Rationale */}
      <div style={{ padding: "0 20px 16px" }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navy, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Why this recommendation</div>
          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.7 }}>{rec.rationale}</div>
        </div>
      </div>

      {/* Key factors */}
      <div style={{ padding: "0 20px 16px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Key factors</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {rec.keyFactors.map((f, i) => (
            <div key={i} style={{ fontSize: 12, color: C.textMid, display: "flex", gap: 7, alignItems: "flex-start" }}>
              <span style={{ color: C.blue, fontWeight: 700, marginTop: 1, flexShrink: 0 }}>·</span>
              <span>{f}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Projections */}
      <div style={{ borderTop: `1px solid ${C.border}`, display: "grid", gridTemplateColumns: "1fr 1px 1fr" }}>
        <div style={{ padding: "16px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 11, color: C.textMid, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Late Payment Reduction</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: C.green, fontFamily: C.mono, lineHeight: 1 }}>{rec.lossReduction}</div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 5 }}>vs. current terms</div>
        </div>
        <div style={{ background: C.border }} />
        <div style={{ padding: "16px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 11, color: C.textMid, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            {rec.revImpactSign === "positive" ? "Est. Revenue Gain" : rec.revImpactSign === "neutral" ? "Revenue Impact" : "Est. Delay Cost"}
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: revColor, fontFamily: C.mono, lineHeight: 1 }}>
            {rec.revImpactSign === "negative" ? "-" : rec.revImpactSign === "positive" ? "+" : ""}{rec.revImpact}
          </div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 5 }}>est. annual</div>
        </div>
      </div>

      {/* Alt option */}
      {rec.altTerms && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: "14px 20px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Alternative</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: C.text, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 8px", whiteSpace: "nowrap", flexShrink: 0 }}>{rec.altTerms}</span>
            <span style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5 }}>{rec.altNote}</span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button
          onClick={() => { setApplied(false); handleRegenerate(); }}
          style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, color: C.textMid, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.color = C.blue; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textMid; }}
        >
          Regenerate
        </button>

        {applied ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: C.green }}>
            <span>✓</span> Terms applied
          </div>
        ) : (
          <button
            onClick={() => setApplied(true)}
            style={{ padding: "7px 18px", fontSize: 12, fontWeight: 600, color: "#fff", background: C.navy, border: "none", borderRadius: 6, cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            Apply Terms
          </button>
        )}
      </div>
    </div>
  );
}
