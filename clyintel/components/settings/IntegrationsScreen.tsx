"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { getInvoiceSource, type InvoiceSourceId } from "@/lib/invoiceSources";
import BillingTab from "@/components/settings/BillingTab";
import ConnectCard from "@/components/settings/ConnectCard";
import RevenueRecoveryTab from "@/components/settings/RevenueRecoveryTab";
import InvoiceSourceCard, { type SourceRow } from "@/components/settings/InvoiceSourceCard";
import { Toast, ToastSuccessDot } from "@/components/ui/Toast";

const SETTING_TABS = [
  { id: "integrations",    label: "Integrations",    disabled: false },
  { id: "notifications",   label: "Notifications",   disabled: false },
  { id: "revenue_recovery",label: "Revenue Recovery",disabled: false },
  { id: "subscription",    label: "Subscription",    disabled: false },
  { id: "profile",         label: "Profile",         disabled: true  },
];

// OAuth connect-start + disconnect endpoints per invoice-source provider. Only
// QuickBooks is live today; a provider absent here simply can't be managed (its
// coming-soon registry entry never yields a /api/sources row anyway). The
// provider id ("quickbooks") differs from QBO's route prefix ("qbo"), so this
// mapping can't be derived from the id.
const PROVIDER_ROUTES: Partial<
  Record<InvoiceSourceId, { reauthorizeHref: string; disconnectEndpoint: string }>
> = {
  quickbooks: { reauthorizeHref: "/api/qbo/connect", disconnectEndpoint: "/api/qbo/disconnect" },
};

interface SyncToast {
  invoices: number;
  events: number;
}

export default function IntegrationsScreen() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState("integrations");

  // Real invoice-source rows from /api/sources (registry-scoped, caller's own).
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(true);

  // Plan-derived revenue share rate — passed to ConnectCard for fee disclosure.
  const [revShareRate, setRevShareRate] = useState<number | null>(null);

  // Sync-result toast (from PR-B's ?qbo=connected&synced=N&events=M params).
  const [syncToast, setSyncToast] = useState<SyncToast | null>(null);

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

  // Sync-result toast: PR-B's callback appends ?qbo=connected&synced=N&events=M
  // after an auto-sync on reauthorize. It currently redirects to /connections,
  // NOT here — so in the normal reauthorize-from-Integrations flow this toast
  // won't fire until the callback honors a return-to (named follow-up). Wired to
  // this screen's own params so it fires wherever those params actually land here.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("qbo") !== "connected") return;
    const synced = params.get("synced");
    const events = params.get("events");
    if (synced === null || events === null) return; // sync failed/absent → no false count
    const invoices = Number(synced);
    const ev = Number(events);
    if (Number.isNaN(invoices) || Number.isNaN(ev)) return;
    setSyncToast({ invoices, events: ev });
  }, []);

  // Fetch plan-derived revenue share rate for ConnectCard fee disclosure.
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

  // Real invoice-source rows. never-connected providers return NO row, so they
  // are simply absent (never rendered). Refetched after a disconnect so the card
  // flips to its disconnected tile.
  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch("/api/sources", { cache: "no-store" });
      if (!res.ok) {
        setSources([]);
        return;
      }
      const data = (await res.json()) as { sources?: SourceRow[] };
      setSources(Array.isArray(data.sources) ? data.sources : []);
    } catch {
      setSources([]);
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSources();
  }, [fetchSources]);

  const connectedCount = (sources ?? []).filter((s) => s.state === "connected").length;

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

          {/* INVOICE SOURCES section — real cards from /api/sources + registry */}
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

            {sourcesLoading ? (
              <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500, padding: "12px 0" }}>
                Loading sources…
              </div>
            ) : (sources ?? []).length === 0 ? (
              <div
                style={{
                  background: C.surface,
                  border: `1px dashed ${C.border}`,
                  borderRadius: 10,
                  padding: "36px 24px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>
                  No invoice sources connected yet.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {(sources ?? []).map((row) => {
                  const registry = getInvoiceSource(row.provider);
                  const routes = PROVIDER_ROUTES[row.provider as InvoiceSourceId];
                  // A row for an unknown provider, or one without OAuth routes,
                  // can't be managed here — skip rather than render a broken card.
                  if (!registry || !routes) return null;
                  return (
                    <InvoiceSourceCard
                      key={row.provider}
                      source={registry}
                      row={row}
                      reauthorizeHref={routes.reauthorizeHref}
                      disconnectEndpoint={routes.disconnectEndpoint}
                      onDisconnected={fetchSources}
                    />
                  );
                })}
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

      {/* Sync-result toast */}
      {syncToast && (
        <Toast icon={<ToastSuccessDot />} onDismiss={() => setSyncToast(null)}>
          Synced · {syncToast.invoices} invoice{syncToast.invoices === 1 ? "" : "s"},{" "}
          {syncToast.events} balance event{syncToast.events === 1 ? "" : "s"}
        </Toast>
      )}
    </div>
  );
}
