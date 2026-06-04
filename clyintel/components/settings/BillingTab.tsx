"use client";
import { useEffect, useState } from "react";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

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
              .select("subscription_status, plan:plans(tier)")
              .eq("id", user.id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      if (!active) return;
      if (planRows) {
        setPlans(
          [...(planRows as PlanRow[])].sort(
            (a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99)
          )
        );
      }
      const sub = subResult.data as { subscription_status?: string; plan?: { tier?: string } } | null;
      if (sub) {
        setCurrentTier(sub.plan?.tier ?? null);
        setStatus(sub.subscription_status ?? null);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

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
