"use client";
import { useState } from "react";
import { C } from "@/lib/theme";
import type { CommunicationDisplay } from "@/lib/data";
import type { VoiceCallDisplay } from "@/lib/voice-calls";
import { fmtExchangeTs, fmtDay, fmtDuration, fmtCost, fmtMoney, prettify } from "./logUi";

// Restores the existing drawer design (clyintel_after.jsx → ExchangeDrawer): one
// chronological timeline of recovery-agent exchanges, each with a channel-colored
// left border, channel icon + badge, contact, timestamp, From/To, a body line,
// and an amber Outcome. Communications (email/SMS) and voice calls are merged and
// sorted oldest → newest, matching the design sample.

type Channel = "Voice" | "Email" | "Text";

const CHANNEL_ICONS: Record<Channel, string> = { Voice: "📞", Email: "📧", Text: "💬" };
const CHANNEL_COLORS: Record<Channel, string> = { Voice: C.blue, Email: C.amber, Text: C.green };

interface TimelineEntry {
  key: string;
  sortTs: number;
  timestamp: string | null;
  channel: Channel;
  contact: string | null;
  from: string;
  to: string;
  bodyLabel: "Body" | "Message" | "Summary";
  body: string;
  outcome: string | null;
  voice?: VoiceCallDisplay; // present → renders the expandable call details
}

function tsNum(value: string | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return isNaN(t) ? 0 : t;
}

function buildEntries(communications: CommunicationDisplay[], voiceCalls: VoiceCallDisplay[], clientName: string): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const comm of communications) {
    // Voice is sourced from voice_calls, not communications.
    if (comm.channel === "voice") continue;
    const channel: Channel = comm.channel === "email" ? "Email" : "Text";
    const bodyLabel = channel === "Email" ? "Body" : "Message";
    const outbound = comm.direction === "outbound";
    const body = comm.subject
      ? comm.body
        ? `${comm.subject} — ${comm.body}`
        : comm.subject
      : comm.body ?? "";
    let outcome = prettify(comm.status);
    if (comm.status === "would_send") outcome = "Dry run (would send)";
    const timestamp = comm.sent_at ?? comm.created_at;

    entries.push({
      key: `comm:${comm.id}`,
      sortTs: tsNum(timestamp),
      timestamp,
      channel,
      contact: outbound ? comm.to_address : comm.from_address,
      from: outbound ? "Recovery Agent" : clientName,
      to: outbound ? clientName : "Recovery Agent",
      bodyLabel,
      body,
      outcome: outcome === "—" ? null : outcome,
    });

    // A recorded reply becomes a second, inbound entry from the client.
    if (comm.reply_body) {
      const replyTs = comm.reply_received_at ?? comm.created_at;
      entries.push({
        key: `comm:${comm.id}:reply`,
        sortTs: tsNum(replyTs),
        timestamp: replyTs,
        channel,
        contact: comm.from_address ?? comm.to_address,
        from: clientName,
        to: "Recovery Agent",
        bodyLabel,
        body: comm.reply_body,
        outcome: "Reply received",
      });
    }
  }

  for (const call of voiceCalls) {
    const timestamp = call.started_at ?? call.created_at;
    let outcome = prettify(call.outcome ?? call.ended_reason);
    if (outcome === "—") outcome = "Call completed";
    if (call.payment_committed) {
      outcome += ` · Committed ${fmtMoney(call.committed_amount)} by ${fmtDay(call.committed_date)}`;
    }
    entries.push({
      key: `call:${call.id}`,
      sortTs: tsNum(timestamp),
      timestamp,
      channel: "Voice",
      contact: call.to_number,
      from: "Recovery Agent",
      to: clientName,
      bodyLabel: "Summary",
      body: call.summary ?? "Voice call",
      outcome,
      voice: call,
    });
  }

  return entries.sort((a, b) => a.sortTs - b.sortTs);
}

function VoiceDetails({ call }: { call: VoiceCallDisplay }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 12, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", padding: "2px 0" }}
      >
        {open ? "Details ▲" : "Details ▼"}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
          <div style={{ fontSize: 13, color: C.textMid, fontFamily: C.mono }}>
            {fmtDuration(call.duration_seconds)} · {fmtCost(call.cost_usd)}
          </div>
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
          {call.payment_committed && (
            <div style={{ padding: "8px 12px", background: C.greenBg, border: `1px solid ${C.green}`, borderRadius: 8, fontSize: 13, color: C.green, fontWeight: 600 }}>
              Payment committed: {fmtMoney(call.committed_amount)}
              {call.committed_date ? ` · by ${fmtDay(call.committed_date)}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ExchangeTimeline({
  communications = [],
  voiceCalls = [],
  clientName,
}: {
  communications?: CommunicationDisplay[];
  voiceCalls?: VoiceCallDisplay[];
  clientName: string;
}) {
  const entries = buildEntries(communications, voiceCalls, clientName);

  if (entries.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 20px", color: C.textMid, fontSize: 14 }}>
        No exchanges recorded for this invoice yet.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {entries.map((ex, idx) => {
        const color = CHANNEL_COLORS[ex.channel];
        return (
          <div
            key={ex.key}
            style={{
              borderLeft: `3px solid ${color}`,
              paddingLeft: 16,
              paddingBottom: 16,
              borderBottom: idx < entries.length - 1 ? `1px solid ${C.border}` : "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 16 }}>{CHANNEL_ICONS[ex.channel]}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#FFFFFF", background: color, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {ex.channel}
                </span>
                {ex.contact && (
                  <span style={{ fontSize: 13, color: C.blue, fontFamily: C.mono, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ex.contact}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 13, color: C.textMid, fontFamily: C.mono, flexShrink: 0 }}>{fmtExchangeTs(ex.timestamp)}</span>
            </div>
            <div style={{ fontSize: 13, color: C.textMid, marginBottom: 4 }}>
              <span style={{ color: C.text, fontWeight: 500 }}>From:</span> {ex.from}
            </div>
            <div style={{ fontSize: 13, color: C.textMid, marginBottom: 10 }}>
              <span style={{ color: C.text, fontWeight: 500 }}>To:</span> {ex.to}
            </div>
            {ex.body && (
              <div style={{ fontSize: 14, color: C.text, marginBottom: 8, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 600, color: C.textMid }}>{ex.bodyLabel}:</span> {ex.body}
              </div>
            )}
            {ex.outcome && (
              <div style={{ fontSize: 14, color: C.text, fontWeight: 600, marginTop: 10 }}>
                <span style={{ color: C.amber }}>Outcome:</span> {ex.outcome}
              </div>
            )}
            {ex.voice && <VoiceDetails call={ex.voice} />}
          </div>
        );
      })}
    </div>
  );
}
