"use client";
import { useEffect, useState, type ReactNode } from "react";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { getProvider } from "@/lib/providers";

interface PlanRow {
  id: string;
  tier: string;
  display_name: string;
  monthly_price_cents: number;
  stripe_product_id: string | null;
}

// Display order and the subset of tiers that are self-serve checkout-able.
const TIER_ORDER: Record<string, number> = { free: 0, starter: 1, plus: 2, pro: 3, enterprise: 4 };
const CHECKOUT_TIERS = new Set(["starter", "plus", "pro"]);
// Tiers shown in the Billing tab during Beta. Pro and Enterprise are defined in
// the DB but not actively sold yet, so they are excluded here (presentation-layer
// only — their plan records and Stripe products are untouched). To re-enable a
// tier later, add it back to this set.
const BETA_VISIBLE_TIERS = new Set(["free", "starter", "plus"]);

// The active payout rail at beta. UI copy, fee disclosure, and onboarding/status
// entry points come from the provider registry rather than inline Stripe literals
// (PRD v2.2 §8), so a second rail (PayPal) can drop in without touching this view.
const STRIPE = getProvider("stripe");

type OnboardingStatus = "not_started" | "pending" | "complete" | "restricted";

interface ConnectStatus {
  connected: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  onboarding_status: OnboardingStatus;
}

function priceLabel(plan: PlanRow): string {
  if (plan.tier === "free") return "$0 / mo";
  if (plan.tier === "enterprise") return "Custom";
  return `$${(plan.monthly_price_cents / 100).toFixed(0)} / mo`;
}

export default function BillingTab() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [currentTier, setCurrentTier] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutPlan, setCheckoutPlan] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [banner, setBanner] = useState<"success" | "cancelled" | null>(null);

  // Stripe Connect (Express) — revenue-recovery onboarding state.
  // revShareRate is the subscriber's PLAN-DERIVED rate, stored as a fraction
  // (e.g. 0.12), surfaced as a percentage in the disclosure. Never hardcoded.
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [connectLoading, setConnectLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [revShareRate, setRevShareRate] = useState<number | null>(null);

  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get("upgrade");
    if (u === "success" || u === "cancelled") setBanner(u);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const [{ data: planRows }, subResult] = await Promise.all([
        supabase.from("plans").select("id, tier, display_name, monthly_price_cents, stripe_product_id"),
        user
          ? supabase
              .from("subscribers")
              .select("subscription_status, plan:plans(tier, revenue_share_rate)")
              .eq("id", user.id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      if (!active) return;
      if (planRows) {
        setPlans(
          (planRows as PlanRow[])
            .filter((p) => BETA_VISIBLE_TIERS.has(p.tier))
            .sort((a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99))
        );
      }
      const sub = subResult.data as {
        subscription_status?: string;
        plan?: { tier?: string; revenue_share_rate?: number };
      } | null;
      if (sub) {
        setCurrentTier(sub.plan?.tier ?? null);
        setStatus(sub.subscription_status ?? null);
        setRevShareRate(
          typeof sub.plan?.revenue_share_rate === "number" ? sub.plan.revenue_share_rate : null
        );
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Connect status is the server-of-truth (GET /api/connect/status re-reads
  // Stripe). Refresh on mount and again when returning from onboarding
  // (?connect=complete), since the return redirect alone isn't authoritative.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(STRIPE.routes.status, { cache: "no-store" });
        const json = (await res.json()) as ConnectStatus;
        if (active && res.ok) setConnect(json);
      } catch {
        // Leave connect null; the section renders a neutral retry CTA.
      } finally {
        if (active) setConnectLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleConnect() {
    setError("");
    setConnecting(true);
    try {
      const res = await fetch(STRIPE.routes.onboard, { method: "POST" });
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !json.url) throw new Error(json.error || "Could not start onboarding");
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start onboarding");
      setConnecting(false);
    }
  }

  async function handleUpgrade(planId: string) {
    setError("");
    setCheckoutPlan(planId);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !json.url) throw new Error(json.error || "Could not start checkout");
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout");
      setCheckoutPlan(null);
    }
  }

  const currentRank = currentTier ? TIER_ORDER[currentTier] ?? 0 : 0;

  return (
    <section style={{ animation: "fadeUp 0.2s ease" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>Billing &amp; Plan</div>
        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
          {currentTier
            ? `You're on the ${currentTier.charAt(0).toUpperCase() + currentTier.slice(1)} plan${
                status ? ` · ${status}` : ""
              }.`
            : "Choose a plan to get started."}
        </div>
      </div>

      {banner && (
        <div
          style={{
            padding: "10px 14px",
            marginBottom: 16,
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            background: banner === "success" ? C.greenBg : C.amberBg,
            border: `1px solid ${banner === "success" ? C.green : C.amber}`,
            color: banner === "success" ? C.green : C.amber,
          }}
        >
          {banner === "success"
            ? "Payment received — your plan will update momentarily."
            : "Checkout cancelled — no changes were made."}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px 14px",
            marginBottom: 16,
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

      <ConnectCard
        connectLoading={connectLoading}
        connect={connect}
        connecting={connecting}
        revShareRate={revShareRate}
        onConnect={handleConnect}
      />

      {loading ? (
        <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>Loading plans…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {plans.map((plan) => {
            const isCurrent = plan.tier === currentTier;
            const rank = TIER_ORDER[plan.tier] ?? 0;
            const canCheckout = CHECKOUT_TIERS.has(plan.tier) && !!plan.stripe_product_id;
            const isUpgrade = canCheckout && rank > currentRank;
            const busy = checkoutPlan === plan.id;

            return (
              <div
                key={plan.id}
                style={{
                  background: C.card,
                  border: `1px solid ${isCurrent ? C.blue : C.border}`,
                  borderRadius: 12,
                  padding: "20px 24px",
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{plan.display_name}</span>
                    {isCurrent && (
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
                        Current plan
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>{priceLabel(plan)}</div>
                </div>

                <div style={{ flexShrink: 0 }}>
                  {isUpgrade ? (
                    <button
                      onClick={() => handleUpgrade(plan.id)}
                      disabled={busy}
                      style={{
                        padding: "8px 16px",
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#fff",
                        background: busy ? C.textDim : C.blue,
                        border: "none",
                        borderRadius: 6,
                        cursor: busy ? "not-allowed" : "pointer",
                      }}
                    >
                      {busy ? "Redirecting…" : "Upgrade"}
                    </button>
                  ) : plan.tier === "enterprise" && !isCurrent ? (
                    <a
                      href="mailto:sales@phoresight.io?subject=Clyintel%20Enterprise"
                      style={{
                        padding: "8px 16px",
                        fontSize: 14,
                        fontWeight: 600,
                        color: C.navy,
                        background: C.surface,
                        border: `1px solid ${C.navy}`,
                        borderRadius: 6,
                        cursor: "pointer",
                        textDecoration: "none",
                      }}
                    >
                      Contact sales
                    </a>
                  ) : (
                    <span style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
                      {isCurrent ? "Active" : rank < currentRank ? "Downgrade" : "—"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Plan-derived rev-share rate (stored as a fraction, e.g. 0.12) → percentage
// string without trailing zeros, e.g. "12". Returns null when unresolved so the
// disclosure never shows a hardcoded number.
function formatRate(rate: number | null): string | null {
  if (rate == null) return null;
  return String(Number((rate * 100).toFixed(2)));
}

interface ConnectCardProps {
  connectLoading: boolean;
  connect: ConnectStatus | null;
  connecting: boolean;
  revShareRate: number | null;
  onConnect: () => void;
}

function ConnectCard({ connectLoading, connect, connecting, revShareRate, onConnect }: ConnectCardProps) {
  const ratePct = formatRate(revShareRate);
  const disclosure = STRIPE.feeDisclosure(ratePct);

  const cta = (label: string, primary: boolean) => (
    <button
      onClick={onConnect}
      disabled={connecting}
      style={{
        padding: "9px 18px",
        fontSize: 14,
        fontWeight: 600,
        color: primary ? "#fff" : C.navy,
        background: connecting ? C.textDim : primary ? C.blue : C.surface,
        border: primary ? "none" : `1px solid ${C.navy}`,
        borderRadius: 6,
        cursor: connecting ? "not-allowed" : "pointer",
        alignSelf: "flex-start",
      }}
    >
      {connecting ? "Redirecting…" : label}
    </button>
  );

  const note = (text: string, kind: "info" | "good" | "warn" | "bad") => {
    const map = {
      info: { bg: C.blueBg, border: C.blue, color: C.blue },
      good: { bg: C.greenBg, border: C.green, color: C.green },
      warn: { bg: C.amberBg, border: C.amber, color: C.amber },
      bad: { bg: C.redBg, border: C.red, color: C.red },
    }[kind];
    return (
      <div
        style={{
          padding: "8px 12px",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          background: map.bg,
          border: `1px solid ${map.border}`,
          color: map.color,
          alignSelf: "flex-start",
        }}
      >
        {text}
      </div>
    );
  };

  const onboardingStatus = connect?.onboarding_status ?? "not_started";

  let body: ReactNode;
  if (connectLoading) {
    body = <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>Checking connection…</div>;
  } else if (onboardingStatus === "complete" && connect?.charges_enabled) {
    body = (
      <>
        {note("Connected ✓", "good")}
        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
          Your Stripe account is connected and ready to accept recovered payments
          {connect?.payouts_enabled ? " and receive payouts" : ""}. {disclosure}
        </div>
      </>
    );
  } else if (onboardingStatus === "restricted") {
    body = (
      <>
        {note("Action needed — Stripe has restricted this account", "bad")}
        <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>{disclosure}</div>
        {cta(STRIPE.copy.continueCta, true)}
      </>
    );
  } else if (onboardingStatus === "pending") {
    body = (
      <>
        {note("Setup incomplete", "warn")}
        <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>{disclosure}</div>
        {cta(STRIPE.copy.finishCta, true)}
      </>
    );
  } else {
    body = (
      <>
        <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>{disclosure}</div>
        {cta(STRIPE.copy.connectCta, true)}
      </>
    );
  }

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "20px 24px",
        marginBottom: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 3 }}>
          {STRIPE.copy.cardTitle}
        </div>
        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
          {STRIPE.copy.cardSubtitle}
        </div>
      </div>
      {body}
    </div>
  );
}
