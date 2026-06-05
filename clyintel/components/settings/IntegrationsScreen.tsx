"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { DEMO_RESET_KEY, CLIENTS_KEY, INTEGRATIONS_KEY, DEFAULT_INTEGRATIONS } from "@/lib/demo-mode";
import type { Client } from "@/lib/mock-data";
import BillingTab from "@/components/settings/BillingTab";

type IntegrationStatus = "connected" | "syncing" | "disconnected";

interface ManagedIntegration {
  id: string;
  name: string;
  color: string;
  initial: string;
  logo?: string;
  subtitle: string;
  status: IntegrationStatus;
  lastSync: string | null;
  clients: number;
  invoices: number;
}


const INTEGRATION_CLIENT_SEEDS: Record<string, Client[]> = {
  stripe: [
    { id: 101, name: "Atlas Commerce", industry: "E-commerce", score: 58, prevScore: 65, status: "past_due", balance: 3200, daysOverdue: 22, invoices: 3, lastActivity: "3 days ago", nextAction: "Send final notice", scoreSummary: ["Payment delayed 22 days"], scoreFactors: ["Late payment history"], riskDrivers: ["22 days overdue"] },
  ],
  fb: [
    { id: 102, name: "Bright Solutions", industry: "Consulting", score: 71, prevScore: 68, status: "due", balance: 5800, daysOverdue: 0, invoices: 2, lastActivity: "Today", nextAction: "Follow up in 3 days", scoreSummary: ["Invoice due soon"], scoreFactors: [], riskDrivers: [] },
  ],
  xero: [
    { id: 103, name: "Summit Partners", industry: "Finance", score: 45, prevScore: 52, status: "past_due", balance: 9400, daysOverdue: 45, invoices: 4, lastActivity: "1 week ago", nextAction: "Issue formal demand", scoreSummary: ["Critical collection risk"], scoreFactors: ["4 late payments"], riskDrivers: ["45 days overdue"] },
  ],
  gdrive: [
    { id: 104, name: "Pixel Works", industry: "Creative", score: 63, prevScore: 60, status: "due", balance: 2100, daysOverdue: 0, invoices: 1, lastActivity: "2 days ago", nextAction: "Schedule follow-up", scoreSummary: ["Invoice due in 7 days"], scoreFactors: [], riskDrivers: [] },
  ],
};

const SETTING_TABS = [
  { id: "integrations", label: "Integrations", disabled: false },
  { id: "demo",         label: "Demo",          disabled: false },
  { id: "profile",      label: "Profile",       disabled: true },
  { id: "billing",      label: "Billing",       disabled: false },
  { id: "notifications",label: "Notifications", disabled: true },
];

function persist(list: ManagedIntegration[]) {
  localStorage.setItem(INTEGRATIONS_KEY, JSON.stringify(list));
}

function StatusBadge({ status }: { status: IntegrationStatus }) {
  if (status === "syncing") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, color: C.blue }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.blue, display: "inline-block", animation: "pulse 1.2s ease-in-out infinite" }} />
        Syncing…
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, color: C.green }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, display: "inline-block" }} />
      Connected
    </span>
  );
}

export default function IntegrationsScreen() {
  const router = useRouter();
  const [showBack, setShowBack] = useState(false);

  useEffect(() => {
    const isDirect = sessionStorage.getItem('clyintel_nav_direct') === 'true';
    setShowBack(!isDirect);
    sessionStorage.removeItem('clyintel_nav_direct');
  }, []);

  const [activeTab, setActiveTab] = useState("integrations");
  const [integrations, setIntegrations] = useState<ManagedIntegration[]>(DEFAULT_INTEGRATIONS as ManagedIntegration[]);
  const [disconnectConfirm, setDisconnectConfirm] = useState<string | null>(null);
  const [isDemoReset, setIsDemoReset] = useState(false);

  // Mount priority: reset → [] | saved localStorage (non-empty) → parse | fallback to INITIAL
  useEffect(() => {
    const reset = localStorage.getItem(DEMO_RESET_KEY) === 'true';
    setIsDemoReset(reset);
    if (reset) {
      setIntegrations([]);
      return;
    }
    const saved = localStorage.getItem(INTEGRATIONS_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as ManagedIntegration[];
        setIntegrations(Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_INTEGRATIONS as ManagedIntegration[]);
      } catch {
        setIntegrations(DEFAULT_INTEGRATIONS as ManagedIntegration[]);
      }
    } else {
      setIntegrations(DEFAULT_INTEGRATIONS as ManagedIntegration[]);
    }
  }, []);

  const handleResetDemo = () => {
    localStorage.setItem(DEMO_RESET_KEY, 'true');
    localStorage.removeItem(CLIENTS_KEY);
    localStorage.removeItem(INTEGRATIONS_KEY);
    window.location.reload();
  };

  const handleRestoreDemo = () => {
    localStorage.removeItem(DEMO_RESET_KEY);
    localStorage.removeItem(INTEGRATIONS_KEY);
    localStorage.removeItem(CLIENTS_KEY);
    window.location.reload();
  };

  const connected = integrations.filter(i => i.status !== "disconnected");

  const handleSyncNow = (id: string) => {
    setIntegrations(prev => prev.map(i => i.id === id ? { ...i, status: "syncing" as const } : i));
    setTimeout(() => {
      setIntegrations(prev => {
        const next = prev.map(i => i.id === id ? { ...i, status: "connected" as const, lastSync: "Just now" } : i);
        persist(next);
        return next;
      });
    }, 2200);
  };

  const handleDisconnect = (id: string) => {
    setDisconnectConfirm(null);
    setIntegrations(prev => {
      const next = prev.map(i =>
        i.id === id ? { ...i, status: "disconnected" as const, lastSync: null, clients: 0, invoices: 0 } : i
      );
      persist(next);
      return next;
    });

    const seedIds = new Set((INTEGRATION_CLIENT_SEEDS[id] ?? []).map(s => s.id));
    if (seedIds.size > 0) {
      try {
        const existing: Client[] = JSON.parse(localStorage.getItem(CLIENTS_KEY) || '[]');
        localStorage.setItem(CLIENTS_KEY, JSON.stringify(existing.filter(c => !seedIds.has(c.id))));
      } catch { /* ignore */ }
    }
  };


  const handleAddNew = () => {
    sessionStorage.removeItem('clyintel_nav_direct');
    router.push("/connections");
  };

  return (
    <div style={{ padding: "36px 48px", fontFamily: C.sans, maxWidth: 900, margin: "0 auto" }}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
      `}</style>

      {/* Page header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Settings</div>
        <div style={{ fontSize: 15, color: C.textMid, fontWeight: 500 }}>Manage your account, integrations, and preferences.</div>
      </div>

      {/* Sub-nav tabs */}
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 36 }}>
        {SETTING_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => !tab.disabled && setActiveTab(tab.id)}
            style={{
              padding: "9px 18px",
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 600 : 500,
              color: tab.disabled ? C.textDim : activeTab === tab.id ? C.navy : C.textMid,
              background: "transparent",
              border: "none",
              borderBottom: activeTab === tab.id ? `2px solid ${C.navy}` : "2px solid transparent",
              marginBottom: -1,
              cursor: tab.disabled ? "not-allowed" : "pointer",
              opacity: tab.disabled ? 0.45 : 1,
              transition: "color 0.12s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Integrations tab */}
      {activeTab === "integrations" && (
        <section style={{ marginBottom: 40, animation: "fadeUp 0.2s ease" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: C.text }}>
                Integrations
                {connected.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 600, color: C.blue, background: C.blueBg, borderRadius: 10, padding: "2px 8px" }}>
                    {connected.length} connected
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500, marginTop: 2 }}>
                Your data sources. Invoices sync automatically every 4 hours.
              </div>
            </div>
            <button
              onClick={handleAddNew}
              style={{ padding: "8px 16px", fontSize: 14, fontWeight: 600, color: C.blue, background: C.blueBg, border: `1px solid ${C.blue}`, borderRadius: 6, cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              + Add Client
            </button>
          </div>

          {connected.length === 0 ? (
            <div style={{ background: C.surface, border: `1px dashed ${C.border}`, borderRadius: 10, padding: "36px 24px", textAlign: "center" }}>
              <div style={{ fontSize: 15, color: C.textMid, fontWeight: 500 }}>No integrations available.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {connected.map(integration => (
                <div
                  key={integration.id}
                  style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", display: "flex", alignItems: "center", gap: 20, animation: "fadeUp 0.18s ease" }}
                >
                  {/* Logo */}
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: integration.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {integration.logo && (
                      <img
                        src={integration.logo}
                        alt={integration.name}
                        style={{ width: 26, height: 26, objectFit: "contain" }}
                        onError={e => {
                          e.currentTarget.style.display = "none";
                          (e.currentTarget.nextElementSibling as HTMLElement).style.display = "inline";
                        }}
                      />
                    )}
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", display: integration.logo ? "none" : "inline" }}>
                      {integration.initial}
                    </span>
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{integration.name}</span>
                      {integration.status !== "disconnected" && <StatusBadge status={integration.status} />}
                    </div>
                    <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>{integration.subtitle}</div>
                    {integration.lastSync && (
                      <div style={{ fontSize: 11, color: C.textDim, fontWeight: 500, marginTop: 5, display: "flex", gap: 12 }}>
                        <span>Last synced: {integration.lastSync}</span>
                        {integration.clients > 0 && <span>·</span>}
                        {integration.clients > 0 && <span>{integration.clients} clients · {integration.invoices} invoices</span>}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={() => handleSyncNow(integration.id)}
                      disabled={integration.status === "syncing"}
                      style={{
                        padding: "7px 14px", fontSize: 13, fontWeight: 600,
                        color: integration.status === "syncing" ? C.textDim : C.blue,
                        background: integration.status === "syncing" ? C.surface : C.blueBg,
                        border: `1px solid ${integration.status === "syncing" ? C.border : C.blue}`,
                        borderRadius: 6, cursor: integration.status === "syncing" ? "not-allowed" : "pointer",
                        transition: "opacity 0.15s",
                      }}
                    >
                      {integration.status === "syncing" ? "Syncing…" : "Sync now"}
                    </button>

                    {disconnectConfirm === integration.id ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ fontSize: 11, color: C.textMid, fontWeight: 500 }}>Disconnect?</span>
                        <button
                          onClick={() => handleDisconnect(integration.id)}
                          style={{ padding: "7px 12px", fontSize: 13, fontWeight: 600, color: "#fff", background: C.red, border: "none", borderRadius: 6, cursor: "pointer" }}
                        >
                          Yes, disconnect
                        </button>
                        <button
                          onClick={() => setDisconnectConfirm(null)}
                          style={{ padding: "7px 12px", fontSize: 13, fontWeight: 500, color: C.textMid, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDisconnectConfirm(integration.id)}
                        style={{ padding: "7px 14px", fontSize: 13, fontWeight: 600, color: C.textMid, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = C.red; e.currentTarget.style.borderColor = C.red; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = C.textMid; e.currentTarget.style.borderColor = C.border; }}
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Demo tab */}
      {activeTab === "demo" && (
        <section style={{ animation: "fadeUp 0.2s ease" }}>
          {/* Status badge */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 28, padding: "8px 14px", background: isDemoReset ? "rgba(220,38,38,0.05)" : "rgba(22,163,74,0.05)", border: `1px solid ${isDemoReset ? "rgba(220,38,38,0.2)" : "rgba(22,163,74,0.2)"}`, borderRadius: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: isDemoReset ? C.red : C.green, flexShrink: 0, display: "inline-block" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: isDemoReset ? C.red : C.green }}>
              {isDemoReset ? "No Data" : "Live Data"}
            </span>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>Demo Data</div>
            <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
              Control the mock data shown across the app. Useful for demos or testing the zero-state UI.
            </div>
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button
                onClick={handleResetDemo}
                disabled={isDemoReset}
                style={{
                  padding: "9px 18px", fontSize: 14, fontWeight: 600,
                  color: isDemoReset ? C.textDim : "#fff",
                  background: isDemoReset ? C.surface : C.red,
                  border: `1px solid ${isDemoReset ? C.border : C.red}`,
                  borderRadius: 6, cursor: isDemoReset ? "not-allowed" : "pointer",
                  opacity: isDemoReset ? 0.6 : 1,
                  transition: "opacity 0.15s",
                }}
                onMouseEnter={(e) => { if (!isDemoReset) e.currentTarget.style.opacity = "0.85"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = isDemoReset ? "0.6" : "1"; }}
              >
                Reset Mock Data
              </button>
              <button
                onClick={handleRestoreDemo}
                style={{
                  padding: "9px 18px", fontSize: 14, fontWeight: 600,
                  color: C.navy,
                  background: C.surface,
                  border: `1px solid ${C.navy}`,
                  borderRadius: 6, cursor: "pointer",
                  transition: "opacity 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
              >
                Restore Demo Data
              </button>
              <span style={{ fontSize: 13, color: C.textDim, fontWeight: 400 }}>
                Both actions reload the page immediately.
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Billing tab */}
      {activeTab === "billing" && <BillingTab />}

    </div>
  );
}
