"use client";
import { useEffect, useState, type ReactNode } from "react";
import { C } from "@/lib/theme";

// QuickBooks Online connection card. Mirrors the Stripe ConnectCard structure/
// style. Connect + Reconnect both hit GET /api/qbo/connect (which 302s to Intuit);
// status comes from GET /api/qbo/status. The ?qbo= return param drives the banner.

interface QboStatus {
  connected: boolean;
  external_id: string | null; // already masked by the status route
  updated_at: string | null;
  refresh_expires_at: string | null;
}

type Banner = { tone: "success" | "error"; text: string };

const BANNERS: Record<string, Banner> = {
  connected: { tone: "success", text: "QuickBooks connected." },
  denied: {
    tone: "error",
    text: "QuickBooks authorization was cancelled — no changes were made.",
  },
  state_invalid: {
    tone: "error",
    text: "Could not verify the QuickBooks sign-in request. Please try connecting again.",
  },
  error: {
    tone: "error",
    text: "Something went wrong connecting QuickBooks. Please try again.",
  },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function QuickBooksCard() {
  const [status, setStatus] = useState<QboStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    const qbo = new URLSearchParams(window.location.search).get("qbo");
    if (qbo && BANNERS[qbo]) setBanner(BANNERS[qbo]);

    (async () => {
      try {
        const res = await fetch("/api/qbo/status", { cache: "no-store" });
        if (res.ok) setStatus((await res.json()) as QboStatus);
      } catch {
        // Leave status null; card renders the connect CTA.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Both connect and reconnect route through the same OAuth entry point.
  const startConnect = () => {
    window.location.href = "/api/qbo/connect";
  };

  function badge(text: string, tone: "grey" | "green"): ReactNode {
    const map = {
      grey: { bg: C.surface, border: C.border, color: C.textMid },
      green: { bg: C.greenBg, border: C.green, color: C.green },
    }[tone];
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
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

  function primaryBtn(label: string): ReactNode {
    return (
      <button
        onClick={startConnect}
        style={{
          padding: "8px 16px",
          fontSize: 13,
          fontWeight: 600,
          color: "#fff",
          background: C.blue,
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
          flexShrink: 0,
          alignSelf: "flex-start",
        }}
      >
        {label}
      </button>
    );
  }

  function secondaryBtn(label: string): ReactNode {
    return (
      <button
        onClick={startConnect}
        style={{
          padding: "8px 16px",
          fontSize: 13,
          fontWeight: 600,
          color: C.textMid,
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {label}
      </button>
    );
  }

  let stateContent: ReactNode;
  if (loading) {
    stateContent = (
      <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>Checking connection…</div>
    );
  } else if (status?.connected) {
    stateContent = (
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {badge("Connected", "green")}
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500, lineHeight: 1.5 }}>
            Realm <span style={{ fontFamily: C.mono }}>{status.external_id}</span>
            <span style={{ color: C.border, margin: "0 8px" }}>·</span>
            Updated {fmtDate(status.updated_at)}
            <span style={{ color: C.border, margin: "0 8px" }}>·</span>
            Refresh expires {fmtDate(status.refresh_expires_at)}
          </div>
        </div>
        {secondaryBtn("Reconnect QuickBooks")}
      </div>
    );
  } else {
    stateContent = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>
          Connect QuickBooks Online to detect recovered payments automatically.
        </div>
        {primaryBtn("Connect QuickBooks")}
      </div>
    );
  }

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: 720,
      }}
    >
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 2 }}>
          QuickBooks Online
        </div>
        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
          Sync invoices and payments from your QuickBooks Online company.
        </div>
      </div>

      {banner && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            background: banner.tone === "success" ? C.greenBg : C.redBg,
            border: `1px solid ${banner.tone === "success" ? C.green : C.red}`,
            color: banner.tone === "success" ? C.green : C.red,
          }}
        >
          {banner.text}
        </div>
      )}

      {stateContent}
    </div>
  );
}
