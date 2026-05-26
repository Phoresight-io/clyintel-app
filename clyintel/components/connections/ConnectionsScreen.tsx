"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import {
  invoiceServices, importedClients, MANUAL_FIELDS,
  driveFolders, driveFiles, googleAccounts,
  InvoiceService, DriveFolder, DriveFile, GoogleAccount,
} from "@/lib/mock-data";
import type { Client, ClientStatus } from "@/lib/mock-data";
import { CLIENTS_KEY, INTEGRATIONS_KEY, DEFAULT_INTEGRATIONS, DEMO_RESET_KEY } from "@/lib/demo-mode";

const SEED_CLIENTS: Record<string, Client[]> = {
  stripe: [
    { id: 101, name: "Atlas Commerce", industry: "E-commerce", score: 58, prevScore: 65, status: "past_due", balance: 3200, daysOverdue: 22, invoices: 3, lastActivity: "3 days ago", nextAction: "Send final notice", scoreSummary: ["Payment delayed 22 days"], scoreFactors: ["Late payment history"], riskDrivers: ["22 days overdue"] },
  ],
  fb: [
    { id: 102, name: "Bright Solutions", industry: "Consulting", score: 71, prevScore: 68, status: "due", balance: 5800, daysOverdue: 0, invoices: 2, lastActivity: "Today", nextAction: "Follow up in 3 days", scoreSummary: ["Invoice due soon"], scoreFactors: [], riskDrivers: [] },
  ],
  xero: [
    { id: 103, name: "Summit Partners", industry: "Finance", score: 45, prevScore: 52, status: "past_due", balance: 9400, daysOverdue: 45, invoices: 4, lastActivity: "1 week ago", nextAction: "Issue formal demand", scoreSummary: ["Critical collection risk"], scoreFactors: ["4 late payments"], riskDrivers: ["45 days overdue"] },
  ],
};

const DRIVE_SEED_CLIENTS: Client[] = [
  { id: 150, name: "Pixel Works", industry: "Creative", score: 63, prevScore: 60, status: "due", balance: 2100, daysOverdue: 0, invoices: 1, lastActivity: "2 days ago", nextAction: "Monitor invoice", scoreSummary: ["Invoice due in 7 days"], scoreFactors: [], riskDrivers: [] },
  { id: 151, name: "Meridian Labs", industry: "Technology", score: 49, prevScore: 57, status: "past_due", balance: 7800, daysOverdue: 31, invoices: 3, lastActivity: "5 days ago", nextAction: "Send overdue notice", scoreSummary: ["Payment overdue 31 days"], scoreFactors: ["Missed payment"], riskDrivers: ["31 days overdue"] },
];

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

type Stage =
  | "connect"
  | "connecting" | "select" | "analyzing"
  | "oauth_account" | "oauth_consent" | "oauth_redirect"
  | "drive_folders" | "drive_files"
  | "csv_upload" | "csv_uploading" | "csv_done"
  | "manual";

type ManualForm = Record<string, string>;

export default function ConnectionsScreen() {
  const router = useRouter();
  const [showBack, setShowBack] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const isDirect = sessionStorage.getItem('clyintel_nav_direct') === 'true';
    setShowBack(!isDirect);
    sessionStorage.removeItem('clyintel_nav_direct');
  }, []);

  const [stage, setStage]                   = useState<Stage>("connect");
  const [selectedService, setSelectedService] = useState<InvoiceService | null>(null);
  const [pickedClient, setPickedClient]     = useState<{ name: string } | null>(null);
  const [manualForm, setManualForm]         = useState<ManualForm>({ client: "", invoice: "", amount: "", dueDate: "", terms: "Net 30", notes: "" });
  const [manualSubmitted, setManualSubmitted] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<GoogleAccount | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(null);
  const [selectedFile, setSelectedFile]     = useState<DriveFile | { name: string; rows: number; size: string } | null>(null);
  const [csvSource, setCsvSource]           = useState<"drive" | "upload" | null>(null);
  const [selectedClients, setSelectedClients] = useState<string[]>([]);

  const handleServiceClick = (svc: InvoiceService) => {
    if (svc.id === "manual") { setSelectedService(svc); setStage("manual"); return; }
    if (svc.id === "gdrive") { setSelectedService(svc); setCsvSource("drive");  setStage("oauth_account"); return; }
    if (svc.id === "csv")    { setSelectedService(svc); setCsvSource("upload"); setStage("csv_upload"); return; }
    setSelectedService(svc);
    setStage("connecting");
    setTimeout(() => setStage("select"), 1600);
  };

  const handleAccountPick   = (acct: GoogleAccount) => { setSelectedAccount(acct); setStage("oauth_consent"); };
  const handleConsentAllow  = () => { setStage("oauth_redirect"); setTimeout(() => setStage("drive_folders"), 1400); };
  const handleFolderPick    = (f: DriveFolder) => { setSelectedFolder(f); setStage("drive_files"); };
  const handleDriveFilePick = (f: DriveFile) => {
    setSelectedFile(f);
    setStage("csv_uploading");
    writeClientsToStorage(DRIVE_SEED_CLIENTS);
    setTimeout(() => setStage("csv_done"), 1800);
  };
  const handleUploadMore    = () => { setSelectedFile(null); setStage(csvSource === "drive" ? "drive_folders" : "csv_upload"); };

  const processFile = (file: File) => {
    setStage("csv_uploading");
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const existing: Client[] = (() => { try { return JSON.parse(localStorage.getItem(CLIENTS_KEY) || '[]') as Client[]; } catch { return []; } })();
      const startId = Math.max(200, ...existing.map(c => c.id)) + 1;
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
  const handleClientPick = (c: { name: string }) => {
    setPickedClient(c);
    setStage("analyzing");

    if (selectedService) {
      const svcId = selectedService.id;
      const seeds = SEED_CLIENTS[svcId] ?? [];
      try {
        if (seeds.length > 0) {
          const existing: Client[] = JSON.parse(localStorage.getItem(CLIENTS_KEY) || '[]');
          const merged = [...existing.filter(e => !seeds.some(s => s.id === e.id)), ...seeds];
          localStorage.setItem(CLIENTS_KEY, JSON.stringify(merged));
        }
        const stored = localStorage.getItem(INTEGRATIONS_KEY);
        const list: typeof DEFAULT_INTEGRATIONS = stored ? JSON.parse(stored) : DEFAULT_INTEGRATIONS;
        const updated = list.map(i =>
          i.id === svcId
            ? { ...i, status: "connected" as const, lastSync: "Just now", clients: seeds.length, invoices: seeds.length * 2 }
            : i
        );
        localStorage.setItem(INTEGRATIONS_KEY, JSON.stringify(updated));
        localStorage.removeItem(DEMO_RESET_KEY);
      } catch { /* ignore */ }
    }

    setTimeout(() => { sessionStorage.removeItem('clyintel_nav_direct'); router.push("/"); }, 2000);
  };

  const integrations = invoiceServices.filter(s => ["qb","fb","stripe","xero"].includes(s.id));
  const bottomRow    = ["gdrive","csv","manual"].map(id => invoiceServices.find(s => s.id === id)!);

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

  const backBtn = (onClick: () => void, label = "Back") => (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 15, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"} onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}>
      <span style={{ fontSize: 16 }}>←</span> {label}
    </button>
  );

  const progressBar = (duration = "1.6s") => (
    <div style={{ width: 280, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
      <div style={{ height: "100%", background: C.blue, borderRadius: 2, animation: `bar ${duration} ease forwards` }} />
    </div>
  );

  const driveConnectedBadge = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
      <div style={{ width: 28, height: 28, borderRadius: 7, background: "#1FA463", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <img src="https://cdn.simpleicons.org/googledrive/FFFFFF" alt="Google Drive" style={{ width: 16, height: 16, objectFit: "contain" }} />
      </div>
      <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>
        <span style={{ color: C.green, fontWeight: 500 }}>✓ Connected</span>
        {selectedAccount && <><span style={{ color: C.border, margin: "0 8px" }}>·</span><span style={{ fontFamily: C.mono, fontSize: 12 }}>{selectedAccount.email}</span></>}
        {selectedFolder  && <><span style={{ color: C.border, margin: "0 8px" }}>·</span><span style={{ color: C.text, fontWeight: 500 }}>{selectedFolder.name}</span></>}
      </div>
    </div>
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
                {integrations.map(svc => (
                  <div key={svc.id} onClick={() => handleServiceClick(svc)} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "28px 20px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center", transition: "border-color 0.15s" }} onMouseEnter={e => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.boxShadow = `0 0 0 3px ${C.blueBg}`; }} onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "none"; }}>
                    <div style={{ width: 56, height: 56, borderRadius: 14, background: svc.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {svcIcon(svc, 32)}
                    </div>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 600, color: C.text }}>{svc.name}</div>
                      <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500, marginTop: 4 }}>{svc.subtitle}</div>
                    </div>
                  </div>
                ))}
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
              {bottomRow.map(svc => (
                <div key={svc.id} onClick={() => handleServiceClick(svc)} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "24px 20px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", transition: "border-color 0.15s" }} onMouseEnter={e => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.boxShadow = `0 0 0 3px ${C.blueBg}`; }} onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "none"; }}>
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
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── CONNECTING (QB/FB/Stripe/Xero mock) ── */}
      {stage === "connecting" && selectedService && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 360 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: selectedService.color, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 18 }}>
            {svcIcon(selectedService, 30)}
          </div>
          <div style={{ fontSize: 16, fontWeight: 500, color: C.text, marginBottom: 6 }}>Connecting to {selectedService.name}...</div>
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, marginBottom: 24 }}>Syncing invoice history</div>
          {progressBar("1.6s")}
        </div>
      )}

      {/* ── SELECT CLIENT (QB/FB/Stripe/Xero mock) ── */}
      {stage === "select" && selectedService && (
        <>
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ width: 20, height: 20, borderRadius: 5, background: selectedService.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {svcIcon(selectedService, 12)}
              </div>
              <span style={{ fontSize: 13, color: C.green, fontWeight: 500 }}>✓ {selectedService.name} connected</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 6 }}>Select a client</div>
            <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>Choose one or more clients to analyze and score.</div>
          </div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", maxWidth: 580 }}>
            <div style={{ display: "grid", gridTemplateColumns: "32px 2fr 90px 110px", padding: "9px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              <div />
              {["Client", "Invoices", "Balance"].map(h => <span key={h} style={{ fontSize: 11, fontWeight: 600, color: C.textMid, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</span>)}
            </div>
            {importedClients.map((c, i) => {
              const isSelected = selectedClients.includes(c.name);
              const toggle = () => setSelectedClients(prev => isSelected ? prev.filter(n => n !== c.name) : [...prev, c.name]);
              return (
                <div
                  key={c.name}
                  onClick={toggle}
                  style={{
                    display: "grid", gridTemplateColumns: "32px 2fr 90px 110px", alignItems: "center",
                    padding: "13px 16px",
                    borderBottom: i < importedClients.length - 1 ? `1px solid ${C.border}` : "none",
                    borderLeft: isSelected ? `2px solid ${C.blue}` : "2px solid transparent",
                    background: isSelected ? C.blueBg : "transparent",
                    cursor: "pointer", transition: "background 0.15s",
                  }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = C.blueBg; }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={toggle}
                    onClick={e => e.stopPropagation()}
                    style={{ cursor: "pointer", accentColor: C.blue }}
                  />
                  <div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{c.name}</div>
                  <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, fontFamily: C.mono }}>{c.invoices}</div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: c.balance > 0 ? C.text : C.textDim, fontFamily: C.mono }}>{c.balance > 0 ? `$${c.balance.toLocaleString()}` : "—"}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, maxWidth: 580 }}>
            <button
              onClick={() => setStage("connect")}
              style={{ padding: "9px 18px", fontSize: 14, fontWeight: 600, color: C.textMid, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.color = C.blue; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textMid; }}
            >
              Cancel
            </button>
            {selectedClients.length > 0 && (
              <span style={{ fontSize: 14, color: C.textMid, fontWeight: 500, flex: 1 }}>
                {selectedClients.length} client{selectedClients.length !== 1 ? "s" : ""} selected
              </span>
            )}
            <button
              onClick={() => selectedClients.length > 0 && handleClientPick({ name: selectedClients[0] })}
              style={{
                marginLeft: "auto", padding: "9px 20px", fontSize: 14, fontWeight: 600,
                color: selectedClients.length === 0 ? C.textDim : "#fff",
                background: selectedClients.length === 0 ? C.surface : C.blue,
                border: `1px solid ${selectedClients.length === 0 ? C.border : C.blue}`,
                borderRadius: 6, cursor: selectedClients.length === 0 ? "not-allowed" : "pointer",
                opacity: selectedClients.length === 0 ? 0.6 : 1, transition: "opacity 0.15s",
              }}
              onMouseEnter={e => { if (selectedClients.length > 0) e.currentTarget.style.opacity = "0.85"; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = selectedClients.length === 0 ? "0.6" : "1"; }}
            >
              Continue
            </button>
          </div>
        </>
      )}

      {/* ── ANALYZING ── */}
      {stage === "analyzing" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 360 }}>
          <div style={{ fontSize: 16, fontWeight: 500, color: C.text, marginBottom: 6 }}>Analyzing {pickedClient?.name}...</div>
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, marginBottom: 24 }}>Scoring invoice history and calculating risk</div>
          {progressBar("2s")}
        </div>
      )}

      {/* ── OAUTH: ACCOUNT PICKER ── */}
      {stage === "oauth_account" && (
        <div onClick={() => setStage("connect")} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, fontFamily: "Roboto, Arial, sans-serif" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 448, background: "#FFFFFF", borderRadius: 8, boxShadow: "0 8px 28px rgba(0,0,0,0.28)", overflow: "hidden", animation: "fadeUp 0.2s ease-out" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "#F1F3F4", borderBottom: "1px solid #DADCE0" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF5F57" }} />
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#FEBC2E" }} />
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#28C840" }} />
              </div>
              <div style={{ flex: 1, fontSize: 11, color: "#5F6368", fontFamily: "monospace", textAlign: "center" }}>accounts.google.com/o/oauth2/v2/auth</div>
            </div>
            <div style={{ padding: "40px 40px 32px", textAlign: "center" }}>
              <div style={{ display: "inline-flex", alignItems: "center", marginBottom: 16, fontSize: 22, fontWeight: 400, letterSpacing: "-0.5px" }}>
                <span style={{ color: "#4285F4" }}>G</span><span style={{ color: "#EA4335" }}>o</span><span style={{ color: "#FBBC04" }}>o</span><span style={{ color: "#4285F4" }}>g</span><span style={{ color: "#34A853" }}>l</span><span style={{ color: "#EA4335" }}>e</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 400, color: "#202124", marginBottom: 6 }}>Choose an account</div>
              <div style={{ fontSize: 14, color: "#5F6368", marginBottom: 24 }}>to continue to <span style={{ color: "#1A73E8" }}>Phoresight Clyintel</span></div>
              <div style={{ textAlign: "left", border: "1px solid #DADCE0", borderRadius: 8, overflow: "hidden" }}>
                {googleAccounts.map((acct, i) => (
                  <div key={acct.email} onClick={() => handleAccountPick(acct)} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: i < googleAccounts.length ? "1px solid #DADCE0" : "none", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={e => e.currentTarget.style.background = "#F8F9FA"} onMouseLeave={e => e.currentTarget.style.background = "#FFFFFF"}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: acct.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: "#FFFFFF" }}>{acct.initial}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, color: "#202124" }}>{acct.name}</div>
                      <div style={{ fontSize: 13, color: "#5F6368", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{acct.email}</div>
                    </div>
                  </div>
                ))}
                <div onClick={() => handleAccountPick({ email: "new@example.com", name: "New Account", initial: "+", color: "#5F6368" })} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={e => e.currentTarget.style.background = "#F8F9FA"} onMouseLeave={e => e.currentTarget.style.background = "#FFFFFF"}>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", border: "1px solid #DADCE0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 18, color: "#5F6368", fontWeight: 300 }}>+</span>
                  </div>
                  <div style={{ fontSize: 15, color: "#202124" }}>Use another account</div>
                </div>
              </div>
              <div style={{ marginTop: 28, fontSize: 11, color: "#5F6368", textAlign: "left" }}>
                To continue, Google will share your name, email address, language preference, and profile picture with Phoresight Clyintel.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── OAUTH: CONSENT ── */}
      {stage === "oauth_consent" && selectedAccount && (
        <div onClick={() => setStage("oauth_account")} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, fontFamily: "Roboto, Arial, sans-serif" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 448, background: "#FFFFFF", borderRadius: 8, boxShadow: "0 8px 28px rgba(0,0,0,0.28)", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "#F1F3F4", borderBottom: "1px solid #DADCE0" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF5F57" }} />
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#FEBC2E" }} />
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#28C840" }} />
              </div>
              <div style={{ flex: 1, fontSize: 11, color: "#5F6368", fontFamily: "monospace", textAlign: "center" }}>accounts.google.com/signin/oauth/consent</div>
            </div>
            <div style={{ padding: "32px 40px 28px" }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 20, fontSize: 22, fontWeight: 400, letterSpacing: "-0.5px" }}>
                <span style={{ color: "#4285F4" }}>G</span><span style={{ color: "#EA4335" }}>o</span><span style={{ color: "#FBBC04" }}>o</span><span style={{ color: "#4285F4" }}>g</span><span style={{ color: "#34A853" }}>l</span><span style={{ color: "#EA4335" }}>e</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#FFFFFF", letterSpacing: "-0.5px" }}>P</span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 400, color: "#202124" }}>Phoresight Clyintel wants to access your Google Account</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#F8F9FA", borderRadius: 8, marginBottom: 20 }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: selectedAccount.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span style={{ fontSize: 10, fontWeight: 500, color: "#FFFFFF" }}>{selectedAccount.initial}</span>
                </div>
                <div style={{ fontSize: 14, color: "#202124" }}>{selectedAccount.email}</div>
              </div>
              <div style={{ fontSize: 15, fontWeight: 500, color: "#202124", marginBottom: 12 }}>This will allow Phoresight Clyintel to:</div>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0", borderTop: "1px solid #E8EAED" }}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="#5F6368" style={{ marginTop: 2, flexShrink: 0 }}><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" /></svg>
                <div style={{ fontSize: 14, color: "#3C4043", lineHeight: 1.5 }}>See and download all your Google Drive files</div>
              </div>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0", borderTop: "1px solid #E8EAED" }}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="#5F6368" style={{ marginTop: 2, flexShrink: 0 }}><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" /></svg>
                <div style={{ fontSize: 14, color: "#3C4043", lineHeight: 1.5 }}>See your primary Google Account email address and personal info</div>
              </div>
              <div style={{ fontSize: 11, color: "#5F6368", marginTop: 16, lineHeight: 1.55 }}>
                Make sure you trust Phoresight Clyintel. You may be sharing sensitive info with this site or app.
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
                <button onClick={() => setStage("oauth_account")} style={{ padding: "8px 24px", fontSize: 15, fontWeight: 500, color: "#1A73E8", background: "transparent", border: "none", borderRadius: 4, cursor: "pointer" }}>Cancel</button>
                <button onClick={handleConsentAllow} style={{ padding: "8px 24px", fontSize: 15, fontWeight: 500, color: "#FFFFFF", background: "#1A73E8", border: "none", borderRadius: 4, cursor: "pointer", boxShadow: "0 1px 2px rgba(60,64,67,0.3)" }}>Allow</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── OAUTH: REDIRECT ── */}
      {stage === "oauth_redirect" && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#FFFFFF", padding: "32px 40px", borderRadius: 8, boxShadow: "0 8px 28px rgba(0,0,0,0.28)", textAlign: "center", minWidth: 360 }}>
            <div style={{ display: "inline-flex", marginBottom: 14, fontSize: 18, fontWeight: 400 }}>
              <span style={{ color: "#4285F4" }}>G</span><span style={{ color: "#EA4335" }}>o</span><span style={{ color: "#FBBC04" }}>o</span><span style={{ color: "#4285F4" }}>g</span><span style={{ color: "#34A853" }}>l</span><span style={{ color: "#EA4335" }}>e</span>
            </div>
            <div style={{ fontSize: 15, color: "#202124", marginBottom: 18 }}>Returning to Phoresight Clyintel...</div>
            <div style={{ width: 240, height: 3, background: "#E8EAED", borderRadius: 2, margin: "0 auto", overflow: "hidden" }}>
              <div style={{ height: "100%", background: "#1A73E8", borderRadius: 2, animation: "bar 1.3s ease forwards" }} />
            </div>
          </div>
        </div>
      )}

      {/* ── DRIVE: FOLDER PICKER ── */}
      {stage === "drive_folders" && (
        <>
          {backBtn(() => setStage("connect"))}
          <div style={{ maxWidth: 680, margin: "0 auto" }}>
            {driveConnectedBadge()}
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 6 }}>Select a folder</div>
            <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, marginBottom: 20 }}>Choose the folder containing your invoice CSVs.</div>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 140px 24px", gap: 16, padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.textMid, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                <div>Folder name</div><div>Files</div><div>Modified</div><div></div>
              </div>
              {driveFolders.map((f, i) => (
                <div key={f.name} onClick={() => handleFolderPick(f)} style={{ display: "grid", gridTemplateColumns: "1fr 110px 140px 24px", gap: 16, padding: "14px 16px", alignItems: "center", borderBottom: i < driveFolders.length - 1 ? `1px solid ${C.border}` : "none", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={(e) => (e.currentTarget.style.background = C.blueBg)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="#FBBF24" stroke="#D97706" strokeWidth="0.5"><path d="M2 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" /></svg>
                    <span style={{ fontSize: 15, color: C.blue, fontWeight: 500 }}>{f.name}</span>
                  </div>
                  <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, fontFamily: C.mono }}>{f.files}</div>
                  <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>{f.modified}</div>
                  <div style={{ fontSize: 15, color: C.textDim, fontWeight: 500 }}>›</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── DRIVE: FILE PICKER ── */}
      {stage === "drive_files" && (
        <>
          {backBtn(() => setStage("drive_folders"), "Back to folders")}
          <div style={{ maxWidth: 680, margin: "0 auto" }}>
            {driveConnectedBadge()}
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 6 }}>Pick a file to import</div>
            <div style={{ fontSize: 14, color: C.textMid, marginBottom: 20 }}>{driveFiles.length} CSV files in <span style={{ fontWeight: 500, color: C.text }}>{selectedFolder?.name}</span></div>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 140px 90px", gap: 16, padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.textMid, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                <div>File name</div><div>Rows</div><div>Modified</div><div>Size</div>
              </div>
              {driveFiles.map((f, i) => (
                <div key={f.name} onClick={() => handleDriveFilePick(f)} style={{ display: "grid", gridTemplateColumns: "1fr 100px 140px 90px", gap: 16, padding: "14px 16px", alignItems: "center", borderBottom: i < driveFiles.length - 1 ? `1px solid ${C.border}` : "none", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={(e) => (e.currentTarget.style.background = C.blueBg)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 15, color: "#1FA463" }}>▤</span>
                    <span style={{ fontSize: 15, color: C.blue, fontWeight: 500 }}>{f.name}</span>
                  </div>
                  <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, fontFamily: C.mono }}>{f.rows}</div>
                  <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>{f.modified}</div>
                  <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, fontFamily: C.mono }}>{f.size}</div>
                </div>
              ))}
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
            {(selectedFile as DriveFile)?.rows || 47} rows imported · {(selectedFile as DriveFile)?.size || "84 KB"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button onClick={handleUploadMore} style={{ padding: "12px 20px", fontSize: 15, fontWeight: 600, color: "#FFFFFF", background: C.blue, border: "none", borderRadius: 8, cursor: "pointer" }} onMouseEnter={e => e.currentTarget.style.opacity = "0.88"} onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
              Upload more files
            </button>
            <button onClick={() => { setSelectedFile(null); setSelectedFolder(null); setStage("connect"); }} style={{ padding: "12px 20px", fontSize: 15, fontWeight: 600, color: C.text, background: "#FFFFFF", border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer" }} onMouseEnter={e => e.currentTarget.style.borderColor = C.blue} onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
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
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
              <button onClick={() => setStage("connect")} style={{ padding: "9px 18px", fontSize: 14, fontWeight: 600, color: C.textMid, background: "#FFFFFF", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => { setManualSubmitted(true); setTimeout(() => { sessionStorage.removeItem('clyintel_nav_direct'); router.push("/"); }, 1800); }} style={{ padding: "9px 18px", fontSize: 14, fontWeight: 600, color: "#FFFFFF", background: C.blue, border: "none", borderRadius: 6, cursor: "pointer" }} onMouseEnter={e => e.currentTarget.style.opacity = "0.88"} onMouseLeave={e => e.currentTarget.style.opacity = "1"}>Save Invoice</button>
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
