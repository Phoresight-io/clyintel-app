"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import type { InvoiceService, ManualField, Client, ClientStatus } from "@/lib/mock-data";
import { CLIENTS_KEY, DEMO_RESET_KEY } from "@/lib/demo-mode";

// static UI config, not mock data — the Add-Client tiles (labels/colors/logos).
const INVOICE_SERVICES: InvoiceService[] = [
  { id: "qb",     name: "QuickBooks",   color: "#2CA01C", initial: "QB",  logo: "https://cdn.simpleicons.org/quickbooks/FFFFFF",  subtitle: "Sync invoices from QuickBooks" },
  { id: "fb",     name: "FreshBooks",   color: "#1068e0", initial: "FB",  logo: "https://cdn.simpleicons.org/freshbooks/FFFFFF",  subtitle: "Sync invoices from FreshBooks" },
  { id: "stripe", name: "Stripe",       color: "#635BFF", initial: "ST",  logo: "https://cdn.simpleicons.org/stripe/FFFFFF",      subtitle: "Sync invoices from Stripe" },
  { id: "xero",   name: "Xero",         color: "#13B5EA", initial: "XR",  logo: "https://cdn.simpleicons.org/xero/FFFFFF",        subtitle: "Sync invoices from Xero" },
  { id: "gdrive", name: "Google Drive", color: "#1FA463", initial: "GD",  logo: "https://cdn.simpleicons.org/googledrive/FFFFFF", subtitle: "Pick a CSV from your Drive" },
  { id: "csv",    name: "Upload CSV",   color: "#475569", initial: "CSV",                                                          subtitle: "Upload a CSV file from your computer" },
  { id: "manual", name: "Manual Entry", color: "#64748B", initial: "ME",                                                           subtitle: "Create an invoice manually" },
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

// Integrations without a live sync path yet — shown but disabled until D3.
// (QuickBooks is NOT here: its tile shows real connection state via /api/qbo/status.)
const COMING_SOON = new Set(["fb", "stripe", "xero", "gdrive"]);

function parseCSVToClients(text: string, startId: number): Client[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const col = (row: string[], name: string) => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? (row[idx] ?? '').trim().replace(/^["']|["']$/g, '') : '';
  };

  const clients: Client[] = [];
  let nextId = startId;

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    const name = col(row, 'name') || col(row, 'client_name') || col(row, 'client');
    if (!name) continue;

    const rawBalance = parseFloat((col(row, 'balance') || col(row, 'amount') || '0').replace(/[$,]/g, ''));
    const balance = isNaN(rawBalance) ? 0 : rawBalance;

    const rawStatus = (col(row, 'status') || '').toLowerCase();
    const status: ClientStatus =
      rawStatus === 'past_due' || rawStatus === 'overdue' || rawStatus === 'late' ? 'past_due' :
      rawStatus === 'due' || rawStatus === 'pending' ? 'due' : 'current';

    const score = status === 'past_due' ? 48 + (i % 5) * 2 :
                  status === 'due'      ? 67 + (i % 4) * 2 : 80 + (i % 3) * 2;
    const daysOverdue = status === 'past_due' ? 15 + (i % 3) * 10 : 0;

    clients.push({
      id: nextId++,
      name,
      industry: col(row, 'industry') || 'Other',
      score,
      prevScore: score + 4,
      status,
      balance,
      daysOverdue,
      invoices: 1 + (i % 4),
      lastActivity: status === 'current' ? 'Today' : `${daysOverdue} days ago`,
      nextAction: status === 'past_due' ? 'Send overdue notice' : status === 'due' ? 'Monitor invoice' : 'No action needed',
      scoreSummary: status === 'past_due' ? [`Payment overdue ${daysOverdue} days`] : [],
      scoreFactors: [],
      riskDrivers: status === 'past_due' ? [`${daysOverdue} days overdue`] : [],
    });
  }

  return clients;
}

function writeClientsToStorage(newClients: Client[]) {
  try {
    const existing: Client[] = JSON.parse(localStorage.getItem(CLIENTS_KEY) || '[]');
    const newIds = new Set(newClients.map(c => c.id));
    const merged = [...existing.filter(c => !newIds.has(c.id)), ...newClients];
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(merged));
    localStorage.removeItem(DEMO_RESET_KEY);
  } catch { /* ignore */ }
}

type Stage = "connect" | "csv_upload" | "csv_uploading" | "csv_done" | "manual";
type ManualForm = Record<string, string>;
type QboStatus = { connected: boolean; external_id: string | null } | null;

export default function ConnectionsScreen() {
  const router = useRouter();
  const [showBack, setShowBack] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [selectedFile, setSelectedFile]     = useState<{ name: string; rows: number; size: string } | null>(null);

  const handleServiceClick = (svc: InvoiceService) => {
    if (svc.id === "manual") { setStage("manual"); return; }
    if (svc.id === "csv")    { setStage("csv_upload"); return; }
    if (svc.id === "qb") {
      // Real QuickBooks OAuth (D1). Sync itself is D3; this only starts connect.
      if (!qboStatus?.connected) window.location.href = "/api/qbo/connect";
      return;
    }
    // fb / stripe / xero / gdrive → Coming soon, no action.
  };

  const handleUploadMore = () => { setSelectedFile(null); setStage("csv_upload"); };

  const processFile = (file: File) => {
    setStage("csv_uploading");
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const existing: Client[] = (() => { try { return JSON.parse(localStorage.getItem(CLIENTS_KEY) || '[]') as Client[]; } catch { return []; } })();
      const startId = Math.max(200, ...existing.map(c => typeof c.id === "number" ? c.id : 0)) + 1;
      const parsed = parseCSVToClients(text, startId);
      writeClientsToStorage(parsed);
      setSelectedFile({ name: file.name, rows: parsed.length, size: `${Math.max(1, Math.round(file.size / 1024))} KB` });
      setTimeout(() => setStage("csv_done"), 1800);
    };
    reader.onerror = () => {
      setSelectedFile({ name: file.name, rows: 0, size: "0 KB" });
      setTimeout(() => setStage("csv_done"), 1800);
    };
    reader.readAsText(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  };

  const handleFileUpload = () => { fileInputRef.current?.click(); };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
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

  const integrations = INVOICE_SERVICES.filter(s => ["qb","fb","stripe","xero"].includes(s.id));
  const bottomRow    = ["gdrive","csv","manual"].map(id => INVOICE_SERVICES.find(s => s.id === id)!);

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

  const backBtn = (onClick: () => void, label = "Back") => (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 15, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"} onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}>
      <span style={{ fontSize: 16 }}>←</span> {label}
    </button>
  );

  return (
    <div style={{ padding: "36px 48px", minHeight: 520, fontFamily: C.sans }}>
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes bar{from{width:0%}to{width:100%}}
        button:focus-visible{outline:2px solid #2B6CB0;outline-offset:2px}
      `}</style>

      {/* ── CONNECT ── */}
      {stage === "connect" && (
        <>
          {showBack && backBtn(() => router.back())}
          <div style={{ maxWidth: 860, margin: "0 auto", textAlign: "center" }}>
            <div style={{ marginBottom: 40 }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Add Client</div>
              <div style={{ fontSize: 16, color: C.textMid, fontWeight: 500 }}>Connect your invoice source, import a file, or enter an invoice manually.</div>
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
                        {isQb ? qbStatusPill() : disabled ? comingSoonPill : null}
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

            {/* Bottom 3: Google Drive | Upload CSV | Manual Entry */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
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
                      {svc.id === "csv" ? (
                        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 3v12" /><path d="M7 8l5-5 5 5" /><path d="M5 21h14" />
                        </svg>
                      ) : svc.id === "manual" ? (
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

      {/* ── CSV UPLOAD (drag-and-drop zone) ── */}
      {stage === "csv_upload" && (
        <>
          {backBtn(() => setStage("connect"))}
          <div style={{ maxWidth: 640, margin: "0 auto" }}>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 6 }}>Upload a CSV file</div>
              <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>Drag-and-drop a CSV from your computer, or browse to select one.</div>
            </div>
            <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }} onChange={handleFileSelect} />
        <div onClick={handleFileUpload} onDrop={handleFileDrop} onDragOver={e => e.preventDefault()} onDragEnter={e => { e.preventDefault(); e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.background = C.blueBg; }} onDragLeave={e => { e.currentTarget.style.borderColor = C.borderLight ?? C.border; e.currentTarget.style.background = C.card; }} style={{ background: C.card, border: `2px dashed ${C.borderLight ?? C.border}`, borderRadius: 12, padding: "48px 32px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginBottom: 20, transition: "all 0.15s" }} onMouseEnter={e => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.background = C.blueBg; }} onMouseLeave={e => { e.currentTarget.style.borderColor = C.borderLight ?? C.border; e.currentTarget.style.background = C.card; }}>
              <div style={{ width: 56, height: 56, borderRadius: 14, background: C.surface, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke={C.blue} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12" /><path d="M7 8l5-5 5 5" /><path d="M5 21h14" />
                </svg>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>Drop your CSV here, or click to browse</div>
                <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>Up to 10 MB · UTF-8 encoded</div>
              </div>
            </div>
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Expected columns</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {["client_name","invoice_id","amount","due_date","issue_date","status","terms"].map(c => (
                  <span key={c} style={{ fontSize: 11, fontFamily: C.mono, padding: "3px 8px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, color: C.textMid, fontWeight: 500 }}>{c}</span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── CSV UPLOADING ── */}
      {stage === "csv_uploading" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 360 }}>
          <div style={{ fontSize: 14, color: C.textDim, fontWeight: 500, fontFamily: C.mono, marginBottom: 6 }}>{selectedFile?.name || "invoices.csv"}</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: C.text, marginBottom: 6 }}>Uploading and processing...</div>
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, marginBottom: 24 }}>Parsing rows · matching clients · scoring history</div>
          <div style={{ width: 320, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", background: C.blue, borderRadius: 2, animation: "bar 1.8s ease forwards" }} />
          </div>
        </div>
      )}

      {/* ── CSV DONE ── */}
      {stage === "csv_done" && (
        <div style={{ maxWidth: 560, margin: "40px auto 0", textAlign: "center" }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: C.greenBg ?? "#DCFCE7", border: `2px solid ${C.green}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
            <span style={{ fontSize: 28, color: C.green, lineHeight: 1 }}>✓</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 6 }}>Import complete</div>
          <div style={{ fontSize: 15, color: C.textMid, fontWeight: 500, marginBottom: 4 }}>
            <span style={{ fontFamily: C.mono, color: C.text, fontWeight: 500 }}>{selectedFile?.name}</span>
          </div>
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, marginBottom: 28 }}>
            {selectedFile?.rows ?? 0} rows imported · {selectedFile?.size ?? "0 KB"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button onClick={handleUploadMore} style={{ padding: "12px 20px", fontSize: 15, fontWeight: 600, color: "#FFFFFF", background: C.blue, border: "none", borderRadius: 8, cursor: "pointer" }} onMouseEnter={e => e.currentTarget.style.opacity = "0.88"} onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
              Upload more files
            </button>
            <button onClick={() => { setSelectedFile(null); setStage("connect"); }} style={{ padding: "12px 20px", fontSize: 15, fontWeight: 600, color: C.text, background: "#FFFFFF", border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer" }} onMouseEnter={e => e.currentTarget.style.borderColor = C.blue} onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
              Back to Add Client
            </button>
            <button onClick={() => { sessionStorage.removeItem('clyintel_nav_direct'); router.push("/"); }} style={{ padding: "12px 20px", fontSize: 15, fontWeight: 600, color: C.text, background: "#FFFFFF", border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer" }} onMouseEnter={e => e.currentTarget.style.borderColor = C.blue} onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
              Go to Recovery Dashboard →
            </button>
          </div>
        </div>
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
