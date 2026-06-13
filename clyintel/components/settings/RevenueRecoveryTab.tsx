"use client";
import { C } from "@/lib/theme";

// Revenue Recovery tab — holds recovery mechanics (not the connect card, which
// lives in Integrations > Revenue Share). Off-platform reconciliation backend
// and payment-link management are future prompts; this renders the section
// headers and placeholder states so the tab is navigable at beta.

export default function RevenueRecoveryTab() {
  return (
    <section style={{ animation: "fadeUp 0.2s ease" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>
          Revenue Recovery
        </div>
        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
          Configure how ClyIntel recovers overdue invoices on your behalf.
        </div>
      </div>

      {/* Off-Platform Payment Reconciliation */}
      <div
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "20px 24px",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>
              Off-Platform Payment Reconciliation
            </div>
            <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
              Automatically reconcile payments collected outside of ClyIntel payment links.
            </div>
          </div>
          <div
            style={{
              width: 40,
              height: 22,
              borderRadius: 11,
              background: C.border,
              cursor: "not-allowed",
              flexShrink: 0,
              opacity: 0.5,
            }}
          />
        </div>
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: C.surface,
            border: `1px dashed ${C.border}`,
            fontSize: 13,
            color: C.textDim,
            fontWeight: 500,
          }}
        >
          Off-platform reconciliation settings coming soon.
        </div>
      </div>

      {/* Recent Off-Platform Captures */}
      <div
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "20px 24px",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>
          Recent Off-Platform Captures
        </div>
        <div
          style={{
            padding: "32px 24px",
            borderRadius: 8,
            background: C.surface,
            border: `1px dashed ${C.border}`,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, marginBottom: 4 }}>
            No captures yet
          </div>
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            Off-platform payments will appear here once reconciliation is enabled.
          </div>
        </div>
      </div>
    </section>
  );
}
