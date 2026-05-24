"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";

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

const INITIAL_INTEGRATIONS: ManagedIntegration[] = [
  { id: "qb",     name: "QuickBooks",   color: "#2CA01C", initial: "QB", logo: "https://cdn.simpleicons.org/quickbooks/FFFFFF",   subtitle: "Sync invoices from QuickBooks Online",   status: "connected",    lastSync: "Today at 2:14 PM", clients: 6, invoices: 24 },
  { id: "fb",     name: "FreshBooks",   color: "#1068e0", initial: "FB", logo: "https://cdn.simpleicons.org/freshbooks/FFFFFF",   subtitle: "Sync invoices from FreshBooks",          status: "disconnected", lastSync: null, clients: 0, invoices: 0 },
  { id: "stripe", name: "Stripe",       color: "#635BFF", initial: "ST", logo: "https://cdn.simpleicons.org/stripe/FFFFFF",       subtitle: "Sync invoices from Stripe Billing",      status: "disconnected", lastSync: null, clients: 0, invoices: 0 },
  { id: "xero",   name: "Xero",         color: "#13B5EA", initial: "XR", logo: "https://cdn.simpleicons.org/xero/FFFFFF",         subtitle: "Sync invoices from Xero",                status: "disconnected", lastSync: null, clients: 0, invoices: 0 },
  { id: "gdrive", name: "Google Drive", color: "#1FA463", initial: "GD", logo: "https://cdn.simpleicons.org/googledrive/FFFFFF",  subtitle: "Import from a spreadsheet in Drive",     status: "disconnected", lastSync: null, clients: 0, invoices: 0 },
];

const SETTING_TABS = [
  { id: "integrations", label: "Integrations", disabled: false },
  { id: "profile",      label: "Profile",       disabled: true },
  { id: "billing",      label: "Billing",       disabled: true },
  { id: "notifications",label: "Notifications", disabled: true },
];

function StatusBadge({ status }: { status: IntegrationStatus }) {
  if (status === "syncing") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500, color: C.blue }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.blue, display: "inline-block", animation: "pulse 1.2s ease-in-out infinite" }} />
        Syncing…
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500, color: C.green }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, display: "inline-block" }} />
      Connected
    </span>
  );
}

export default function IntegrationsScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("integrations");
  const [integrations, setIntegrations] = useState<ManagedIntegration[]>(INITIAL_INTEGRATIONS);
  const [disconnectConfirm, setDisconnectConfirm] = useState<string | null>(null);

  const connected  = integrations.filter(i => i.status !== "disconnected");

  const handleSyncNow = (id: string) => {
    setIntegrations(prev => prev.map(i => i.id === id ? { ...i, status: "syncing" } : i));
    setTimeout(() => {
      setIntegrations(prev => prev.map(i => i.id === id ? { ...i, status: "connected", lastSync: "Just now" } : i));
    }, 2200);
  };

  const handleDisconnect = (id: string) => {
    setDisconnectConfirm(null);
    setIntegrations(prev => prev.map(i =>
      i.id === id ? { ...i, status: "disconnected", lastSync: null, clients: 0, invoices: 0 } : i
    ));
  };

  const handleConnect = () => {
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
        <div style={{ fontSize: 14, color: C.textMid }}>Manage your account, integrations, and preferences.</div>
      </div>

      {/* Sub-nav tabs */}
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 36 }}>
        {SETTING_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => !tab.disabled && setActiveTab(tab.id)}
            style={{
              padding: "9px 18px",
              fontSize: 13,
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

      {/* Connected integrations */}
      <section style={{ marginBottom: 40, animation: "fadeUp 0.2s ease" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>
              Connected integrations
              {connected.length > 0 && (
                <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: C.blue, background: C.blueBg, borderRadius: 10, padding: "2px 8px" }}>
                  {connected.length}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: C.textDim, marginTop: 2 }}>
              Your active data sources. Invoices sync automatically every 4 hours.
            </div>
          </div>
          <button
            onClick={handleConnect}
            style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600, color: C.blue, background: C.blueBg, border: `1px solid ${C.blue}`, borderRadius: 6, cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            + Add Client
          </button>
        </div>

        {connected.length === 0 ? (
          <div style={{ background: C.surface, border: `1px dashed ${C.border}`, borderRadius: 10, padding: "36px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 14, color: C.textMid, marginBottom: 12 }}>No integrations connected yet.</div>
            <button
              onClick={handleConnect}
              style={{ padding: "9px 18px", fontSize: 13, fontWeight: 600, color: C.blue, background: C.blueBg, border: `1px solid ${C.blue}`, borderRadius: 6, cursor: "pointer" }}
            >
              Connect your first integration
            </button>
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
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", display: integration.logo ? "none" : "inline" }}>
                    {integration.initial}
                  </span>
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{integration.name}</span>
                    <StatusBadge status={integration.status} />
                  </div>
                  <div style={{ fontSize: 12, color: C.textDim }}>{integration.subtitle}</div>
                  {integration.lastSync && (
                    <div style={{ fontSize: 11, color: C.textDim, marginTop: 5, display: "flex", gap: 12 }}>
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
                      padding: "7px 14px", fontSize: 12, fontWeight: 600,
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
                      <span style={{ fontSize: 11, color: C.textMid }}>Disconnect?</span>
                      <button
                        onClick={() => handleDisconnect(integration.id)}
                        style={{ padding: "7px 12px", fontSize: 12, fontWeight: 600, color: "#fff", background: C.red, border: "none", borderRadius: 6, cursor: "pointer" }}
                      >
                        Yes, disconnect
                      </button>
                      <button
                        onClick={() => setDisconnectConfirm(null)}
                        style={{ padding: "7px 12px", fontSize: 12, fontWeight: 500, color: C.textMid, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDisconnectConfirm(integration.id)}
                      style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, color: C.textMid, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}
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

    </div>
  );
}
