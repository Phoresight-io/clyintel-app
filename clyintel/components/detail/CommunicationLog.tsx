"use client";
import { useState } from "react";
import { C } from "@/lib/theme";
import type { CommunicationDisplay } from "@/lib/data";
import { LogCard, LogRow, Badge, Meta, type Tone, fmtDateTime, prettify } from "./logUi";

// channel → tone: email blue, sms green, voice amber.
function channelTone(channel: string): Tone {
  if (channel === "email") return "blue";
  if (channel === "sms") return "green";
  if (channel === "voice") return "amber";
  return "gray";
}

function CommunicationRow({ comm, first, showInvoice }: { comm: CommunicationDisplay; first?: boolean; showInvoice?: boolean }) {
  const [open, setOpen] = useState(false);
  const isOutbound = comm.direction === "outbound";
  const preview = comm.subject || comm.body || "";
  const hasReply = !!(comm.reply_body || comm.reply_received_at);
  const hasDetail = !!(comm.body || comm.from_address || comm.to_address || comm.status || hasReply || comm.ai_intent);

  return (
    <LogRow first={first}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge label={comm.channel} tone={channelTone(comm.channel)} />
        <Badge label={isOutbound ? "Out" : "In"} tone={isOutbound ? "blue" : "green"} />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{fmtDateTime(comm.created_at)}</span>
        {showInvoice && comm.invoice_number && (
          <span style={{ fontSize: 12, color: C.textMid, fontFamily: C.mono }}>Invoice {comm.invoice_number}</span>
        )}
      </div>

      {preview && (
        <div
          style={{
            fontSize: 14,
            color: C.text,
            lineHeight: 1.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {comm.subject ? <span style={{ fontWeight: 600 }}>{comm.subject}</span> : null}
          {comm.subject && comm.body ? " — " : ""}
          {!comm.subject && comm.body ? comm.body : ""}
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
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 2 }}>
              {comm.body && <div style={{ fontSize: 14, color: C.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{comm.body}</div>}
              {comm.from_address && <Meta label="From" value={comm.from_address} />}
              {comm.to_address && <Meta label="To" value={comm.to_address} />}
              {comm.status && <Meta label="Status" value={prettify(comm.status)} />}
              {hasReply && (
                <div
                  style={{
                    padding: "8px 12px",
                    background: C.surface,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid }}>
                    Reply{comm.reply_received_at ? ` · ${fmtDateTime(comm.reply_received_at)}` : ""}
                  </div>
                  {comm.reply_body && <div style={{ fontSize: 14, color: C.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{comm.reply_body}</div>}
                </div>
              )}
              {comm.ai_intent && <Meta label="AI intent" value={prettify(comm.ai_intent)} />}
            </div>
          )}
        </>
      )}
    </LogRow>
  );
}

export default function CommunicationLog({
  communications,
  showInvoice,
}: {
  communications: CommunicationDisplay[];
  showInvoice?: boolean;
}) {
  return (
    <LogCard title="Communications" count={communications.length} emptyLabel="No communications yet.">
      {communications.map((comm, i) => (
        <CommunicationRow key={comm.id} comm={comm} first={i === 0} showInvoice={showInvoice} />
      ))}
    </LogCard>
  );
}
