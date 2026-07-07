"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import type { InvoiceService, ManualField } from "@/lib/mock-data";

// static UI config, not mock data — the Add-Client tiles (labels/colors/logos).
const INVOICE_SERVICES: InvoiceService[] = [
  { id: "qb",     name: "QuickBooks",   color: "#2CA01C", initial: "QB",  logo: "https://cdn.simpleicons.org/quickbooks/FFFFFF",  subtitle: "Sync invoices from QuickBooks" },
  { id: "fb",     name: "FreshBooks",   color: "#1068e0", initial: "FB",  logo: "https://cdn.simpleicons.org/freshbooks/FFFFFF",  subtitle: "Sync invoices from FreshBooks" },
  { id: "stripe", name: "Stripe",       color: "#635BFF", initial: "ST",  logo: "https://cdn.simpleicons.org/stripe/FFFFFF",      subtitle: "Sync invoices from Stripe" },
  { id: "xero",   name: "Xero",         color: "#13B5EA", initial: "XR",  logo: "https://cdn.simpleicons.org/xero/FFFFFF",        subtitle: "Sync invoices from Xero" },
  { id: "gdrive", name: "Google Drive", color: "#1FA463", initial: "GD",  logo: "https://cdn.simpleicons.org/googledrive/FFFFFF", subtitle: "Import from a spreadsheet in Drive" },
  { id: "manual", name: "Manual Entry", color: "#64748B", initial: "ME",                                                          subtitle: "Create an invoice manually" },
];

// static UI config, not mock data — fields for the real manual-invoice form.
const MANUAL_FIELDS: ManualField[] = [
  { id: "client", label: "Client Name", type: "text", placeholder: "e.g. Acme Corp" },
  { id: "invoice", label: "Invoice #", type: "text", placeholder: "e.g. INV-1060" },
  { id: "amount", label: "Amount ($)", type: "number", placeholder: "e.g. 5000" },
  { id: "dueDate", label: "Due Date", type: "date", placeholder: "" },
  { id: "terms", label: "Payment Terms", type: "select", placeholder: "", options: ["Net 15", "Net 30", "Net 45", "Net 60", "Due on Receipt"] },
  { id: "notes", label: "Notes", type: "textarea", placeholder: "Any additional context..." },
];

// Integrations without a live sync path yet — shown but disabled ("coming soon").
// (QuickBooks is NOT here: its tile shows real connection state via /api/qbo/status.)
const COMING_SOON = new Set(["fb", "stripe", "xero", "gdrive"]);

type Stage = "connect" | "manual";
type ManualForm = Record<string, string>;
type QboStatus = { connected: boolean; external_id: string | null } | null;

export default function ConnectionsScreen() {
  const router = useRouter();
  const [showBack, setShowBack] = useState(false);

  useEffect(() => {
    const isDirect = sessionStorage.getItem('clyintel_nav_direct') === 'true';
    setShowBack(!isDirect);
    sessionStorage.removeItem('clyintel_nav_direct');
  }, []);

  // Real QuickBooks connection state (no mock flow) — drives the QB tile badge.
  const [qboStatus, setQboStatus] = useState<QboStatus>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/qbo/status")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (active && d) setQboStatus({ connected: !!d.connected, external_id: d.external_id ?? null }); })
      .catch(() => { /* leave null — tile shows "Not connected" */ });
    return () => { active = false; };
  }, []);

  const [stage, setStage]                   = useState<Stage>("connect");
  const [manualForm, setManualForm]         = useState<ManualForm>({ client: "", invoice: "", amount: "", dueDate: "", terms: "Net 30", notes: "" });
  const [manualSubmitted, setManualSubmitted] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  // QuickBooks "Sync now" (D3): POST /api/qbo/sync, then refresh server data so
  // the newly synced clients/invoices render on the dashboard/portfolio.
  const [syncing, setSyncing]       = useState(false);
  const [syncResult, setSyncResult] = useState<{ customersUpserted: number; invoicesUpserted: number; invoicesSkipped: number } | null>(null);
  const [syncError, setSyncError]   = useState<string | null>(null);

  const handleServiceClick = (svc: InvoiceService) => {
    if (svc.id === "manual") { setStage("manual"); return; }
    if (svc.id === "qb") {
      // Real QuickBooks OAuth (D1). Sync itself is D3; this only starts connect.
      if (!qboStatus?.connected) window.location.href = "/api/qbo/connect";
      return;
    }
    // fb / stripe / xero / gdrive → Coming soon, no action.
  };

  const handleManualSubmit = async () => {
    if (manualSaving) return;
    setManualError(null);
    if (!manualForm.client.trim()) { setManualError("Client name is required."); return; }
    setManualSaving(true);
    try {
      const res = await fetch("/api/invoices/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manualForm),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setManualError(body.error || "Failed to save invoice.");
        setManualSaving(false);
        return;
      }
      setManualSubmitted(true);
      setTimeout(() => { sessionStorage.removeItem("clyintel_nav_direct"); router.push("/"); }, 1800);
    } catch {
      setManualError("Network error — please try again.");
      setManualSaving(false);
    }
  };

  // Only meaningful when QuickBooks is connected (button is gated on that).
  // Mirrors handleManualSubmit: POST, loading flag, inline result/error.
  const handleSyncNow = async () => {
    if (syncing) return;
    setSyncError(null);
    setSyncResult(null);
    setSyncing(true);
    try {
      const res = await fetch("/api/qbo/sync", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSyncError(body.error || "Sync failed.");
        setSyncing(false);
        return;
      }
      const data = await res.json();
      setSyncResult({
        customersUpserted: data.customersUpserted ?? 0,
        invoicesUpserted: data.invoicesUpserted ?? 0,
        invoicesSkipped: data.invoicesSkipped ?? 0,
      });
      setSyncing(false);
      // Re-fetch the server components (dashboard/portfolio read real rows via
      // getUIPortfolio) so the just-synced data shows without a manual reload.
      router.refresh();
    } catch {
      setSyncError("Network error — please try again.");
      setSyncing(false);
    }
  };

  const integrations = INVOICE_SERVICES.filter(s => ["qb","fb","stripe","xero"].includes(s.id));
  const bottomRow    = ["gdrive","manual"].map(id => INVOICE_SERVICES.find(s => s.id === id)!);

  const svcIcon = (svc: InvoiceService, size = 32) => (
    <>
      {svc.logo && (
        <img
          src={svc.logo}
          alt={svc.name}
          style={{ width: size, height: size, objectFit: "contain" }}
          onError={e => {
            e.currentTarget.style.display = "none";
            (e.currentTarget.nextElementSibling as HTMLElement).style.display = "inline";
          }}
        />
      )}
      <span style={{ fontSize: 15, fontWeight: 700, color: "#fff", display: svc.logo ? "none" : "inline" }}>
        {svc.initial}
      </span>
    </>
  );

  const comingSoonPill = (
    <span style={{ display: "inline-block", marginTop: 8, fontSize: 11, fontWeight: 600, color: C.textDim, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 999, padding: "2px 10px" }}>
      Coming soon
    </span>
  );

  const qbStatusPill = () => (
    qboStatus?.connected ? (
      <span style={{ display: "inline-block", marginTop: 8, fontSize: 11, fontWeight: 600, color: C.green }}>
        ✓ Connected{qboStatus.external_id ? ` · ${qboStatus.external_id}` : ""}
      </span>
    ) : (
      <span style={{ display: "inline-block", marginTop: 8, fontSize: 11, fontWeight: 600, color: C.textDim }}>
        Not connected
      </span>
    )
  );

  // QB tile footer: connection pill + (only when connected) the "Sync now"
  // control with inline counts/error. stopPropagation so clicks don't bubble to
  // the tile's onClick.
  const qbTileFooter = () => (
    <>
      {qbStatusPill()}
      {qboStatus?.connected && (
        <div style={{ marginTop: 10 }} onClick={e => e.stopPropagation()}>
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            style={{ padding: "7px 14px", fontSize: 13, fontWeight: 600, color: "#FFFFFF", background: C.blue, border: "none", borderRadius: 6, cursor: syncing ? "not-allowed" : "pointer", opacity: syncing ? 0.7 : 1 }}
            onMouseEnter={e => { if (!syncing) e.currentTarget.style.opacity = "0.88"; }}
            onMouseLeave={e => { if (!syncing) e.currentTarget.style.opacity = "1"; }}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          {syncResult && (
            <div style={{ marginTop: 8, fontSize: 12, fontWeight: 500, color: C.green }}>
              ✓ Synced {syncResult.customersUpserted} customers · {syncResult.invoicesUpserted} invoices · {syncResult.invoicesSkipped} skipped
            </div>
          )}
          {syncError && (
            <div style={{ marginTop: 8, fontSize: 12, fontWeight: 500, color: C.red }}>{syncError}</div>
          )}
        </div>
      )}
    </>
  );

  const backBtn = (onClick: () => void, label = "Back") => (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 15, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"} onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}>
      <span style={{ fontSize: 16 }}>←</span> {label}
    </button>
  );

  return (
    <div style={{ padding: "36px 48px", minHeight: 520, fontFamily: C.sans }}>
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        button:focus-visible{outline:2px solid #2B6CB0;outline-offset:2px}
      `}</style>

      {/* ── CONNECT ── */}
      {stage === "connect" && (
        <>
          {showBack && backBtn(() => router.back())}
          <div style={{ maxWidth: 860, margin: "0 auto", textAlign: "center" }}>
            <div style={{ marginBottom: 40 }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Add Client</div>
              <div style={{ fontSize: 16, color: C.textMid, fontWeight: 500 }}>Connect your invoice source or enter an invoice manually.</div>
            </div>

            {/* 4 integration tiles */}
            <div style={{ marginBottom: 36 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>Connect an Integration</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
                {integrations.map(svc => {
                  const disabled = COMING_SOON.has(svc.id);
                  const isQb = svc.id === "qb";
                  return (
                    <div
                      key={svc.id}
                      onClick={disabled ? undefined : () => handleServiceClick(svc)}
                      aria-disabled={disabled}
                      style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "28px 20px", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.55 : 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center", transition: "border-color 0.15s" }}
                      onMouseEnter={disabled ? undefined : e => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.boxShadow = `0 0 0 3px ${C.blueBg}`; }}
                      onMouseLeave={disabled ? undefined : e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "none"; }}
                    >
                      <div style={{ width: 56, height: 56, borderRadius: 14, background: svc.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {svcIcon(svc, 32)}
                      </div>
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 600, color: C.text }}>{svc.name}</div>
                        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500, marginTop: 4 }}>{svc.subtitle}</div>
                        {isQb ? qbTileFooter() : disabled ? comingSoonPill : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Divider */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 36 }}>
              <div style={{ flex: 1, height: 1, background: C.border }} />
              <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>or</div>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>

            {/* Bottom: Google Drive (coming soon) | Manual Entry */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {bottomRow.map(svc => {
                const disabled = COMING_SOON.has(svc.id);
                return (
                  <div
                    key={svc.id}
                    onClick={disabled ? undefined : () => handleServiceClick(svc)}
                    aria-disabled={disabled}
                    style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "24px 20px", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.55 : 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", transition: "border-color 0.15s" }}
                    onMouseEnter={disabled ? undefined : e => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.boxShadow = `0 0 0 3px ${C.blueBg}`; }}
                    onMouseLeave={disabled ? undefined : e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "none"; }}
                  >
                    <div style={{ width: 52, height: 52, borderRadius: 12, background: svc.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {svc.id === "manual" ? (
                        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                        </svg>
                      ) : svcIcon(svc, 28)}
                    </div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{svc.name}</div>
                      <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500, marginTop: 4, lineHeight: 1.4 }}>{svc.subtitle}</div>
                      {disabled ? comingSoonPill : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── MANUAL ENTRY ── */}
      {stage === "manual" && !manualSubmitted && (
        <>
          {backBtn(() => setStage("connect"))}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 6 }}>Create Invoice Manually</div>
            <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>Enter invoice details to add a client and invoice to Clyintel.</div>
          </div>
          <div style={{ maxWidth: 520, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "28px 32px" }}>
            {MANUAL_FIELDS.map(field => (
              <div key={field.id} style={{ marginBottom: 20 }}>
                <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>{field.label}</label>
                {field.type === "select" ? (
                  <select value={manualForm[field.id]} onChange={e => setManualForm({ ...manualForm, [field.id]: e.target.value })} style={{ width: "100%", padding: "9px 12px", fontSize: 14, border: `1px solid ${C.border}`, borderRadius: 6, background: "#FFFFFF", color: C.text, outline: "none" }}>
                    {(field.options || []).map(o => <option key={o}>{o}</option>)}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea value={manualForm[field.id]} onChange={e => setManualForm({ ...manualForm, [field.id]: e.target.value })} placeholder={field.placeholder} rows={3} style={{ width: "100%", padding: "9px 12px", fontSize: 14, border: `1px solid ${C.border}`, borderRadius: 6, background: "#FFFFFF", color: C.text, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box", outline: "none" }} />
                ) : (
                  <input type={field.type} value={manualForm[field.id]} onChange={e => setManualForm({ ...manualForm, [field.id]: e.target.value })} placeholder={field.placeholder} style={{ width: "100%", padding: "9px 12px", fontSize: 14, border: `1px solid ${C.border}`, borderRadius: 6, background: "#FFFFFF", color: C.text, boxSizing: "border-box", outline: "none" }} />
                )}
              </div>
            ))}
            {manualError && (
              <div style={{ fontSize: 13, color: C.red, fontWeight: 500, marginBottom: 12 }}>{manualError}</div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
              <button onClick={() => setStage("connect")} style={{ padding: "9px 18px", fontSize: 14, fontWeight: 600, color: C.textMid, background: "#FFFFFF", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}>Cancel</button>
              <button onClick={handleManualSubmit} disabled={manualSaving} style={{ padding: "9px 18px", fontSize: 14, fontWeight: 600, color: "#FFFFFF", background: C.blue, border: "none", borderRadius: 6, cursor: manualSaving ? "not-allowed" : "pointer", opacity: manualSaving ? 0.7 : 1 }} onMouseEnter={e => { if (!manualSaving) e.currentTarget.style.opacity = "0.88"; }} onMouseLeave={e => { if (!manualSaving) e.currentTarget.style.opacity = "1"; }}>{manualSaving ? "Saving…" : "Save Invoice"}</button>
            </div>
          </div>
        </>
      )}

      {stage === "manual" && manualSubmitted && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 360 }}>
          <div style={{ fontSize: 32, color: C.green, marginBottom: 16 }}>✓</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: C.text, marginBottom: 6 }}>Invoice saved</div>
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>Returning to dashboard...</div>
        </div>
      )}
    </div>
  );
}
