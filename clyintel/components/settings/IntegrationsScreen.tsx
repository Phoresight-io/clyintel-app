"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { DEMO_RESET_KEY, CLIENTS_KEY, INTEGRATIONS_KEY, DEFAULT_INTEGRATIONS } from "@/lib/demo-mode";
import type { Client } from "@/lib/mock-data";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import BillingTab from "@/components/settings/BillingTab";
import ConnectCard from "@/components/settings/ConnectCard";
import RevenueRecoveryTab from "@/components/settings/RevenueRecoveryTab";

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
  { id: "integrations",    label: "Integrations",    disabled: false },
  { id: "notifications",   label: "Notifications",   disabled: false },
  { id: "revenue_recovery",label: "Revenue Recovery",disabled: false },
  { id: "subscription",    label: "Subscription",    disabled: false },
  { id: "profile",         label: "Profile",         disabled: true  },
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

  const [activeTab, setActiveTab] = useState("integrations");
  const [integrations, setIntegrations] = useState<ManagedIntegration[]>(DEFAULT_INTEGRATIONS as ManagedIntegration[]);
  const [disconnectConfirm, setDisconnectConfirm] = useState<string | null>(null);

  // Plan-derived revenue share rate — passed to ConnectCard for fee disclosure.
  const [revShareRate, setRevShareRate] = useState<number | null>(null);

  // Honor ?tab= deep links. Connect onboarding returns to ?tab=integrations.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab && SETTING_TABS.some((t) => t.id === tab && !t.disabled)) {
      setActiveTab(tab);
    } else if (params.get("connect")) {
      setActiveTab("integrations");
    }
  }, []);

  // Load integrations from localStorage
  useEffect(() => {
    const reset = localStorage.getItem(DEMO_RESET_KEY) === "true";
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
    }
  }, []);

  // Fetch plan-derived revenue share rate for ConnectCard fee disclosure
  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createSupabaseBrowser();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !active) return;
      const { data: sub } = await supabase
        .from("subscribers")
        .select("plan:plans(revenue_share_rate)")
        .eq("id", user.id)
        .maybeSingle();
      if (!active) return;
      const rate = (sub as { plan?: { revenue_share_rate?: number } } | null)?.plan?.revenue_share_rate;
      if (typeof rate === "number") setRevShareRate(rate);
    })();
    return () => { active = false; };
  }, []);

  const connected = integrations.filter((i) => i.status !== "disconnected");

  const handleSyncNow = (id: string) => {
    setIntegrations((prev) => prev.map((i) => i.id === id ? { ...i, status: "syncing" as const } : i));
    setTimeout(() => {
      setIntegrations((prev) => {
        const next = prev.map((i) =>
          i.id === id ? { ...i, status: "connected" as const, lastSync: "Just now" } : i
        );
        persist(next);
        return next;
      });
    }, 2200);
  };

  const handleDisconnectIntegration = (id: string) => {
    setDisconnectConfirm(null);
    setIntegrations((prev) => {
      const next = prev.map((i) =>
        i.id === id ? { ...i, status: "disconnected" as const, lastSync: null, clients: 0, invoices: 0 } : i
      );
      persist(next);
      return next;
    });
    const seedIds = new Set((INTEGRATION_CLIENT_SEEDS[id] ?? []).map((s) => s.id));
    if (seedIds.size > 0) {
      try {
        const existing: Client[] = JSON.parse(localStorage.getItem(CLIENTS_KEY) || "[]");
        localStorage.setItem(CLIENTS_KEY, JSON.stringify(existing.filter((c) => !seedIds.has(c.id))));
      } catch { /* ignore */ }
    }
  };

  const handleAddClient = () => {
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
        <div style={{ fontSize: 15, color: C.textMid, fontWeight: 500 }}>
          Manage your account, integrations, and preferences.
        </div>
      </div>

      {/* Sub-nav tabs */}
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 36 }}>
        {SETTING_TABS.map((tab) => (
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
        <section style={{ animation: "fadeUp 0.2s ease" }}>
          {/* Tab header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: C.text }}>Integrations</span>
                {connected.length > 0 && (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: C.blue,
                      background: C.blueBg,
                      borderRadius: 10,
                      padding: "2px 8px",
                    }}
                  >
                    {connected.length} connected
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500, marginTop: 3 }}>
                Your data sources. Invoices sync automatically every 4 hours.
              </div>
            </div>
            <button
              onClick={handleAddClient}
              style={{
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 600,
                color: C.blue,
                background: "transparent",
                border: `1px solid ${C.blue}`,
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              + Add Client
            </button>
          </div>

          {/* REVENUE SHARE section */}
          <div style={{ marginBottom: 32 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.textDim,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              Revenue Share
            </div>
            <ConnectCard revShareRate={revShareRate} />
          </div>

          {/* INVOICE SOURCES section */}
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.textDim,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              Invoice Sources
            </div>

            {connected.length === 0 ? (
              <div
                style={{
                  background: C.surface,
                  border: `1px dashed ${C.border}`,
                  borderRadius: 10,
                  padding: "36px 24px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>No integrations available.</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {connected.map((integration) => (
                  <div
                    key={integration.id}
                    style={{
                      background: C.card,
                      border: `1px solid ${C.border}`,
                      borderRadius: 12,
                      padding: "20px 24px",
                      display: "flex",
                      alignItems: "center",
                      gap: 20,
                      animation: "fadeUp 0.18s ease",
                    }}
                  >
                    {/* Logo */}
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 12,
                        background: integration.color,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {integration.logo && (
                        <img
                          src={integration.logo}
                          alt={integration.name}
                          style={{ width: 26, height: 26, objectFit: "contain" }}
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                            (e.currentTarget.nextElementSibling as HTMLElement).style.display = "inline";
                          }}
                        />
                      )}
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: "#fff",
                          display: integration.logo ? "none" : "inline",
                        }}
                      >
                        {integration.initial}
                      </span>
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
                        <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{integration.name}</span>
                        {integration.status !== "disconnected" && <StatusBadge status={integration.status} />}
                      </div>
                      <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
                        Sync invoices from {integration.name}
                      </div>
                      {integration.lastSync && (
                        <div
                          style={{
                            fontSize: 11,
                            color: C.textDim,
                            fontWeight: 500,
                            marginTop: 5,
                            display: "flex",
                            gap: 12,
                          }}
                        >
                          <span>Last synced: {integration.lastSync}</span>
                          {integration.clients > 0 && <span>·</span>}
                          {integration.clients > 0 && (
                            <span>
                              {integration.clients} clients · {integration.invoices} invoices
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                      <button
                        onClick={() => handleSyncNow(integration.id)}
                        disabled={integration.status === "syncing"}
                        style={{
                          padding: "7px 14px",
                          fontSize: 13,
                          fontWeight: 600,
                          color: integration.status === "syncing" ? C.textDim : C.blue,
                          background: integration.status === "syncing" ? C.surface : C.blueBg,
                          border: `1px solid ${integration.status === "syncing" ? C.border : C.blue}`,
                          borderRadius: 6,
                          cursor: integration.status === "syncing" ? "not-allowed" : "pointer",
                        }}
                      >
                        {integration.status === "syncing" ? "Syncing…" : "Sync now"}
                      </button>

                      {disconnectConfirm === integration.id ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <span style={{ fontSize: 11, color: C.textMid, fontWeight: 500 }}>Disconnect?</span>
                          <button
                            onClick={() => handleDisconnectIntegration(integration.id)}
                            style={{
                              padding: "7px 12px",
                              fontSize: 13,
                              fontWeight: 600,
                              color: "#fff",
                              background: C.red,
                              border: "none",
                              borderRadius: 6,
                              cursor: "pointer",
                            }}
                          >
                            Yes, disconnect
                          </button>
                          <button
                            onClick={() => setDisconnectConfirm(null)}
                            style={{
                              padding: "7px 12px",
                              fontSize: 13,
                              fontWeight: 500,
                              color: C.textMid,
                              background: C.surface,
                              border: `1px solid ${C.border}`,
                              borderRadius: 6,
                              cursor: "pointer",
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDisconnectConfirm(integration.id)}
                          style={{
                            padding: "7px 14px",
                            fontSize: 13,
                            fontWeight: 600,
                            color: C.textMid,
                            background: C.surface,
                            border: `1px solid ${C.border}`,
                            borderRadius: 6,
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = C.red;
                            e.currentTarget.style.borderColor = C.red;
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = C.textMid;
                            e.currentTarget.style.borderColor = C.border;
                          }}
                        >
                          Disconnect
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Notifications tab */}
      {activeTab === "notifications" && (
        <section style={{ animation: "fadeUp 0.2s ease" }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>
              Notifications
            </div>
            <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
              Choose which alerts you receive and how.
            </div>
          </div>
          <div
            style={{
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              padding: "24px",
              fontSize: 14,
              color: C.textMid,
              fontWeight: 500,
            }}
          >
            Notification settings coming soon.
          </div>
        </section>
      )}

      {/* Revenue Recovery tab */}
      {activeTab === "revenue_recovery" && <RevenueRecoveryTab />}

      {/* Subscription tab */}
      {activeTab === "subscription" && <BillingTab />}

      {/* Profile tab — disabled stub, should not be reachable via nav */}
      {activeTab === "profile" && (
        <section style={{ animation: "fadeUp 0.2s ease" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>Profile</div>
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>Coming soon.</div>
        </section>
      )}
    </div>
  );
}
