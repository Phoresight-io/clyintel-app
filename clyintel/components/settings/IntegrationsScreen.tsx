"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import BillingTab from "@/components/settings/BillingTab";
import ConnectCard from "@/components/settings/ConnectCard";
import RevenueRecoveryTab from "@/components/settings/RevenueRecoveryTab";

// Static invoice-source roster (demo mode removed — no localStorage, no mock
// seeds, no fake sync). QuickBooks is the only live source; its state comes from
// /api/qbo/status. Every other source is shown but inactive ("Coming soon").
const INVOICE_SOURCES = [
  { id: "qb",     name: "QuickBooks",   color: "#2CA01C", initial: "QB", logo: "https://cdn.simpleicons.org/quickbooks/FFFFFF" },
  { id: "fb",     name: "FreshBooks",   color: "#1068e0", initial: "FB", logo: "https://cdn.simpleicons.org/freshbooks/FFFFFF" },
  { id: "stripe", name: "Stripe",       color: "#635BFF", initial: "ST", logo: "https://cdn.simpleicons.org/stripe/FFFFFF" },
  { id: "xero",   name: "Xero",         color: "#13B5EA", initial: "XR", logo: "https://cdn.simpleicons.org/xero/FFFFFF" },
  { id: "gdrive", name: "Google Drive", color: "#1FA463", initial: "GD", logo: "https://cdn.simpleicons.org/googledrive/FFFFFF" },
];

const SETTING_TABS = [
  { id: "integrations",    label: "Integrations",    disabled: false },
  { id: "notifications",   label: "Notifications",   disabled: false },
  { id: "revenue_recovery",label: "Revenue Recovery",disabled: false },
  { id: "subscription",    label: "Subscription",    disabled: false },
  { id: "profile",         label: "Profile",         disabled: true  },
];

function ConnectedBadge() {
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

  // Plan-derived revenue share rate — passed to ConnectCard for fee disclosure.
  const [revShareRate, setRevShareRate] = useState<number | null>(null);

  // Real QuickBooks connection state (no mock flow) — drives the QB source card.
  const [qboConnected, setQboConnected] = useState(false);

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

  // Real QuickBooks connection status.
  useEffect(() => {
    let active = true;
    fetch("/api/qbo/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (active && d) setQboConnected(!!d.connected); })
      .catch(() => { /* leave false — card shows "Coming soon"/inactive */ });
    return () => { active = false; };
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

  const connectedCount = qboConnected ? 1 : 0;

  const handleAddClient = () => {
    router.push("/connections");
  };

  return (
    <div style={{ padding: "36px 48px", fontFamily: C.sans, maxWidth: 900, margin: "0 auto" }}>
      <style>{`
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
                {connectedCount > 0 && (
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
                    {connectedCount} connected
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

          {/* INVOICE SOURCES section — static roster; QuickBooks live, others coming soon */}
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

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {INVOICE_SOURCES.map((source) => {
                const isQb = source.id === "qb";
                const active = isQb && qboConnected;
                return (
                  <div
                    key={source.id}
                    style={{
                      background: C.card,
                      border: `1px solid ${C.border}`,
                      borderRadius: 12,
                      padding: "20px 24px",
                      display: "flex",
                      alignItems: "center",
                      gap: 20,
                      opacity: isQb ? 1 : 0.6,
                    }}
                  >
                    {/* Logo */}
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 12,
                        background: source.color,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <img
                        src={source.logo}
                        alt={source.name}
                        style={{ width: 26, height: 26, objectFit: "contain" }}
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                          (e.currentTarget.nextElementSibling as HTMLElement).style.display = "inline";
                        }}
                      />
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", display: "none" }}>
                        {source.initial}
                      </span>
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
                        <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{source.name}</span>
                        {active && <ConnectedBadge />}
                      </div>
                      <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
                        Sync invoices from {source.name}
                      </div>
                    </div>

                    {/* Action */}
                    <div style={{ flexShrink: 0 }}>
                      {isQb ? (
                        <button
                          onClick={handleAddClient}
                          style={{
                            padding: "7px 14px",
                            fontSize: 13,
                            fontWeight: 600,
                            color: C.blue,
                            background: C.blueBg,
                            border: `1px solid ${C.blue}`,
                            borderRadius: 6,
                            cursor: "pointer",
                          }}
                        >
                          {qboConnected ? "Manage" : "Connect"}
                        </button>
                      ) : (
                        <span
                          style={{
                            display: "inline-block",
                            fontSize: 11,
                            fontWeight: 600,
                            color: C.textDim,
                            background: C.surface,
                            border: `1px solid ${C.border}`,
                            borderRadius: 999,
                            padding: "4px 12px",
                          }}
                        >
                          Coming soon
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
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
