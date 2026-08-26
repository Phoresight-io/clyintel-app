"use client";
import { useState, type ReactNode } from "react";
import { C } from "@/lib/theme";
import type { InvoiceSource } from "@/lib/invoiceSources";

// Provider-parameterized management card for a connected invoice source. Driven
// by a lib/invoiceSources registry entry (name, idLabel, …) + one /api/sources
// row. QuickBooks is the only live source today, but nothing here is
// QBO-specific: the OAuth connect-start and disconnect endpoints are passed in
// by the call site.
//
// This card is ONLY for rows that exist in /api/sources — i.e. currently or
// formerly connected. A never-connected provider has NO row and is not rendered
// (there is deliberately no "never connected" state here). There is NO sync
// button: syncing is automatic (and runs on reauthorize via the OAuth callback).

// Mirror of one /api/sources row (see app/api/sources/route.ts). external_id is
// the FULL, unmasked Company ID — we mask it in JS; Company ID is not a secret.
export interface SourceRow {
  provider: string;
  state: "connected" | "disconnected";
  external_id: string | null;
  disconnected_external_id: string | null;
  refresh_expires_at: string | null;
  connected_at: string;
  updated_at: string;
  disconnected_at: string | null;
}

interface InvoiceSourceCardProps {
  /** Registry entry for this provider (name, idLabel, …). */
  source: InvoiceSource;
  /** The /api/sources row for this provider. */
  row: SourceRow;
  /** OAuth connect-start href (e.g. /api/qbo/connect). Drives ReAuthorize/Reconnect. */
  reauthorizeHref: string;
  /** Disconnect endpoint (e.g. /api/qbo/disconnect); POSTed with NO body. */
  disconnectEndpoint: string;
  /** Called after a successful disconnect so the parent can refetch /api/sources. */
  onDisconnected: () => void;
}

// ── Health, computed at RENDER time ─────────────────────────────────────────
// Expiry slides forward on active use (QBO returns a fresh refresh window on each
// refresh), so a server-frozen threshold would be stale. We compute days
// remaining here, every render.
const EXPIRING_WITHIN_DAYS = 14;

type Health = "healthy" | "expiring" | "expired";

function daysRemaining(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.ceil((ms - Date.now()) / 86_400_000);
}

function healthFrom(days: number | null): Health {
  if (days === null) return "healthy"; // no expiry known → don't alarm
  if (days <= 0) return "expired";
  if (days <= EXPIRING_WITHIN_DAYS) return "expiring";
  return "healthy";
}

// Mask a Company ID to its last 4, e.g. "9130350000001969" → "••••••••••••1969".
function maskId(id: string): string {
  if (id.length <= 4) return id;
  return "•".repeat(id.length - 4) + id.slice(-4);
}

// Full date+time stamp, e.g. "Aug 26, 2026, 12:53 AM".
function fmtStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function InvoiceSourceCard({
  source,
  row,
  reauthorizeHref,
  disconnectEndpoint,
  onDisconnected,
}: InvoiceSourceCardProps) {
  const [revealId, setRevealId] = useState(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [disconnectInput, setDisconnectInput] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState("");

  const startReauthorize = () => {
    window.location.href = reauthorizeHref;
  };

  // ── Disconnected tile (row present, soft-voided) ──────────────────────────
  if (row.state === "disconnected") {
    const maskedOld = row.disconnected_external_id
      ? maskId(row.disconnected_external_id)
      : null;
    return (
      <div
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "20px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 20,
          animation: "fadeUp 0.18s ease",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{source.name}</span>
            {pill("Disconnected", "grey")}
          </div>
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            {maskedOld ? (
              <>
                {source.idLabel}{" "}
                <span style={{ fontFamily: C.mono }}>{maskedOld}</span>
                <span style={{ color: C.border, margin: "0 8px" }}>·</span>
              </>
            ) : null}
            Reconnect to resume syncing invoices.
          </div>
        </div>
        <button onClick={startReauthorize} style={btn("primary")}>
          Reconnect
        </button>
      </div>
    );
  }

  // ── Connected tile ────────────────────────────────────────────────────────
  const days = daysRemaining(row.refresh_expires_at);
  const health = healthFrom(days);
  const isExpired = health === "expired";
  const isExpiring = health === "expiring";

  const accent = isExpired ? C.red : isExpiring ? C.amber : C.green;
  const cardBorder = isExpired ? C.red : C.border;

  const pillNode = isExpired
    ? pill("Reauthorization required", "red")
    : isExpiring
    ? pill("Expiring soon", "amber")
    : pill("Connected", "green");

  // Expiry meta value + suffix.
  let expiryValue: string = fmtStamp(row.refresh_expires_at);
  if (row.refresh_expires_at && days !== null) {
    expiryValue = isExpired
      ? `${fmtStamp(row.refresh_expires_at)} · expired`
      : `${fmtStamp(row.refresh_expires_at)} · ${days} day${days === 1 ? "" : "s"} remaining`;
  }
  const expiryColor = isExpired ? C.red : isExpiring ? C.amber : C.text;

  const warning = isExpired
    ? `Your ${source.name} connection has expired. Reauthorize to resume syncing invoices.`
    : isExpiring
    ? `Your ${source.name} connection expires in ${days} day${days === 1 ? "" : "s"}. Reauthorize to avoid interruption.`
    : null;

  const maskedId = row.external_id ? maskId(row.external_id) : null;

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${cardBorder}`,
        borderRadius: 12,
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        animation: "fadeUp 0.18s ease",
      }}
    >
      {/* Header: name + pill */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{source.name}</span>
            {pillNode}
          </div>
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            ReAuthorize renews your {source.name} connection and pulls the latest invoices.
          </div>
        </div>
      </div>

      {/* Stacked meta rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {maskedId && (
          <MetaRow label={source.idLabel}>
            <span style={{ fontFamily: C.mono, color: C.text }}>
              {revealId ? row.external_id : maskedId}
            </span>
            <button
              onClick={() => setRevealId((v) => !v)}
              aria-label={revealId ? `Hide ${source.idLabel}` : `Reveal ${source.idLabel}`}
              style={{
                marginLeft: 8,
                border: "none",
                background: "transparent",
                color: C.textDim,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                padding: 0,
              }}
            >
              {revealId ? "Hide" : "Reveal"}
            </button>
          </MetaRow>
        )}
        <MetaRow label="Last authorized">
          <span style={{ color: C.text }}>{fmtStamp(row.updated_at)}</span>
        </MetaRow>
        <MetaRow label="Connection expires">
          <span style={{ color: expiryColor, fontWeight: isExpired || isExpiring ? 600 : 500 }}>
            {expiryValue}
          </span>
        </MetaRow>
      </div>

      {/* Warning line (expiring / expired only) */}
      {warning && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            background: isExpired ? C.redBg : C.amberBg,
            border: `1px solid ${accent}`,
            color: accent,
          }}
        >
          {warning}
        </div>
      )}

      {/* Actions: Disconnect (left, red-outline) · ReAuthorize (right, primary). No Sync. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <button onClick={() => { setShowDisconnect(true); setError(""); }} style={btn("danger-outline")}>
          Disconnect
        </button>
        <button onClick={startReauthorize} style={btn("primary")}>
          ReAuthorize
        </button>
      </div>

      {/* Disconnect modal — typed confirm, POST with NO body */}
      {showDisconnect && (
        <Modal
          onClose={() => {
            setShowDisconnect(false);
            setDisconnectInput("");
            setError("");
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.navy, marginBottom: 4 }}>
                Disconnect {source.name}
              </div>
              <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
                This stops ClyIntel from syncing invoices from {source.name}. Your{" "}
                {source.name} account itself is not affected — you can reconnect anytime.
              </div>
            </div>

            <div>
              <label
                style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}
              >
                Type DISCONNECT to confirm
              </label>
              <input
                type="text"
                value={disconnectInput}
                onChange={(e) => setDisconnectInput(e.target.value)}
                placeholder="DISCONNECT"
                autoFocus
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.text,
                  background: C.surface,
                  border: `1px solid ${
                    disconnectInput.trim().toLowerCase() === "disconnect" ? C.red : C.border
                  }`,
                  borderRadius: 6,
                  outline: "none",
                  boxSizing: "border-box",
                  letterSpacing: "0.03em",
                }}
              />
            </div>

            {error && (
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  background: C.redBg,
                  border: `1px solid ${C.red}`,
                  color: C.red,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setShowDisconnect(false);
                  setDisconnectInput("");
                  setError("");
                }}
                style={btn("secondary")}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (disconnectInput.trim().toLowerCase() !== "disconnect") return;
                  setDisconnecting(true);
                  setError("");
                  try {
                    // T1 route takes NO body — do not send one.
                    const res = await fetch(disconnectEndpoint, { method: "POST" });
                    if (!res.ok) {
                      const json = (await res.json().catch(() => ({}))) as { error?: string };
                      throw new Error(json.error ?? "Disconnect failed.");
                    }
                    setShowDisconnect(false);
                    setDisconnectInput("");
                    onDisconnected(); // parent refetches /api/sources → card flips to disconnected tile
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Disconnect failed.");
                  } finally {
                    setDisconnecting(false);
                  }
                }}
                disabled={disconnectInput.trim().toLowerCase() !== "disconnect" || disconnecting}
                style={{
                  padding: "9px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "#fff",
                  background:
                    disconnectInput.trim().toLowerCase() !== "disconnect" || disconnecting
                      ? C.textDim
                      : C.red,
                  border: "none",
                  borderRadius: 6,
                  cursor:
                    disconnectInput.trim().toLowerCase() !== "disconnect" || disconnecting
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Small presentational helpers ────────────────────────────────────────────

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13, fontWeight: 500 }}>
      <span style={{ color: C.textDim, minWidth: 130 }}>{label}</span>
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
}

function pill(text: string, tone: "green" | "amber" | "red" | "grey"): ReactNode {
  const map = {
    green: { bg: C.greenBg, border: C.green, color: C.green },
    amber: { bg: C.amberBg, border: C.amber, color: C.amber },
    red: { bg: C.redBg, border: C.red, color: C.red },
    grey: { bg: C.surface, border: C.border, color: C.textMid },
  }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px",
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        background: map.bg,
        border: `1px solid ${map.border}`,
        color: map.color,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: map.color,
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      {text}
    </span>
  );
}

function btn(kind: "primary" | "secondary" | "danger-outline"): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 6,
    cursor: "pointer",
    flexShrink: 0,
  };
  if (kind === "primary") {
    return { ...base, color: "#fff", background: C.blue, border: "none" };
  }
  if (kind === "danger-outline") {
    return { ...base, color: C.red, background: "transparent", border: `1px solid ${C.red}` };
  }
  return { ...base, color: C.textMid, background: C.surface, border: `1px solid ${C.border}` };
}

// Local modal mirroring ConnectCard's Modal structure/styling (that one is not
// exported). Kept local to avoid touching ConnectCard.
function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "rgba(0,0,0,0.35)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 14,
          padding: "28px 32px",
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
