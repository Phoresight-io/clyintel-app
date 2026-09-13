"use client";
import { useState } from "react";
import { C } from "@/lib/theme";
import type { VoiceCallDisplay } from "@/lib/voice-calls";
import {
  LogCard,
  LogRow,
  Badge,
  type Tone,
  fmtDateTime,
  fmtDay,
  fmtDuration,
  fmtCost,
  fmtMoney,
  prettify,
} from "./logUi";

// Outcome → tone: a committed payment (or a "connected" outcome) is green, a
// voicemail amber, no-answer/busy gray, failed/declined red. Falls back to gray.
function outcomeTone(outcome: string | null, paymentCommitted: boolean): Tone {
  if (paymentCommitted) return "green";
  const o = (outcome ?? "").toLowerCase();
  if (o.includes("connect") || o.includes("commit")) return "green";
  if (o.includes("voicemail")) return "amber";
  if (o.includes("no-answer") || o.includes("no_answer") || o.includes("noanswer") || o.includes("busy")) return "gray";
  if (o.includes("fail") || o.includes("declin")) return "red";
  return "gray";
}

function VoiceCallRow({ call, first, showInvoice, invoiceLabel }: { call: VoiceCallDisplay; first?: boolean; showInvoice?: boolean; invoiceLabel?: string | null }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(call.summary || call.transcript || call.recording_url || call.ended_reason);

  return (
    <LogRow first={first}>
      {/* Top line: date + badges (+ invoice #) on the left, duration/cost on the right. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{fmtDateTime(call.created_at)}</span>
        {call.status && <Badge label={prettify(call.status)} tone="blue" />}
        <Badge label={prettify(call.outcome) === "—" ? "No outcome" : prettify(call.outcome)} tone={outcomeTone(call.outcome, call.payment_committed)} />
        {showInvoice && invoiceLabel && (
          <span style={{ fontSize: 12, color: C.textMid, fontFamily: C.mono }}>Invoice {invoiceLabel}</span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: C.textMid, fontFamily: C.mono }}>{fmtDuration(call.duration_seconds)}</span>
          <span style={{ fontSize: 13, color: C.textMid, fontFamily: C.mono }}>{fmtCost(call.cost_usd)}</span>
        </span>
      </div>

      {/* Payment commitment callout. */}
      {call.payment_committed && (
        <div
          style={{
            padding: "8px 12px",
            background: C.greenBg,
            border: `1px solid ${C.green}`,
            borderRadius: 8,
            fontSize: 13,
            color: C.green,
            fontWeight: 600,
          }}
        >
          Payment committed: {fmtMoney(call.committed_amount)}
          {call.committed_date ? ` · by ${fmtDay(call.committed_date)}` : ""}
        </div>
      )}

      {hasDetail && (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              alignSelf: "flex-start",
              fontSize: 12,
              fontWeight: 600,
              color: C.blue,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "2px 0",
            }}
          >
            {open ? "Hide details ▲" : "Show details ▼"}
          </button>
          {open && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 2 }}>
              {call.summary && (
                <div style={{ fontSize: 14, color: C.text, lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 600, color: C.textMid }}>Summary:</span> {call.summary}
                </div>
              )}
              {call.recording_url && (
                <audio controls src={call.recording_url} style={{ width: "100%" }}>
                  Your browser does not support audio playback.
                </audio>
              )}
              {call.transcript && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>Transcript</div>
                  <div
                    style={{
                      maxHeight: 200,
                      overflowY: "auto",
                      padding: "10px 12px",
                      background: C.surface,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      fontSize: 13,
                      color: C.text,
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                    }}
                  >
                    {call.transcript}
                  </div>
                </div>
              )}
              {call.ended_reason && (
                <div style={{ fontSize: 12, color: C.textDim, fontStyle: "italic" }}>
                  Ended: {prettify(call.ended_reason)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </LogRow>
  );
}

export default function VoiceCallLog({
  calls,
  title = "Call History",
  showInvoice,
  invoiceNumberByUuid,
}: {
  calls: VoiceCallDisplay[];
  title?: string;
  showInvoice?: boolean;
  invoiceNumberByUuid?: Record<string, string>;
}) {
  return (
    <LogCard title={title} count={calls.length} emptyLabel="No calls yet.">
      {calls.map((call, i) => (
        <VoiceCallRow
          key={call.id}
          call={call}
          first={i === 0}
          showInvoice={showInvoice}
          invoiceLabel={call.invoice_id ? invoiceNumberByUuid?.[call.invoice_id] ?? null : null}
        />
      ))}
    </LogCard>
  );
}
