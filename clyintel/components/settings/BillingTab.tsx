"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { REV_SHARE_BANDS, MIN_QUALIFYING_FACE } from "@/lib/revshare/bands";
import {
  groupIntoCurrentCycle,
  LedgerSeedRow,
  CurrentCycle,
} from "@/lib/revshare/accrualLedger";

interface PlanRow {
  id: string;
  tier: string;
  display_name: string;
  monthly_price_cents: number;
  stripe_product_id: string | null;
}

const TIER_ORDER: Record<string, number> = { free: 0, starter: 1, plus: 2, pro: 3, enterprise: 4 };
const CHECKOUT_TIERS = new Set(["starter", "plus", "pro"]);
// Tiers shown during Beta. Pro and Enterprise are excluded here (presentation-layer
// only — their plan records and Stripe products are untouched).
const BETA_VISIBLE_TIERS = new Set(["free", "starter", "plus"]);

// Prototype ledger seed. A real `rev_share_ledger` table drops in behind this
// later; for now the tab renders this global mock array as-is (the existing
// subscriber resolution below is left untouched — no new auth wiring).
const MOCK_LEDGER: LedgerSeedRow[] = [
  { invoiceRef: "INV-1042", faceValue: 1200, dollarsRecovered: 1200, detectedAt: "2026-06-02" },
  { invoiceRef: "INV-1043", faceValue: 8500, dollarsRecovered: 6000, detectedAt: "2026-06-05" },
  { invoiceRef: "INV-1044", faceValue: 30000, dollarsRecovered: 30000, detectedAt: "2026-06-09" },
  { invoiceRef: "INV-1045", faceValue: 62000, dollarsRecovered: 45000, detectedAt: "2026-06-11" },
];

const fmtWhole = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmtCents = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// 0.22 → "22%" — derived from the band decimal, never typed as a literal.
const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const fmtCloseDate = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
// band4's Infinity maxFace renders as "$50,000+"; finite bands as a range.
const bandRange = (b: { minFace: number; maxFace: number }) =>
  b.maxFace === Infinity ? `${fmtWhole(b.minFace)}+` : `${fmtWhole(b.minFace)} – ${fmtWhole(b.maxFace)}`;

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
  const [cycle, setCycle] = useState<CurrentCycle | null>(null);

  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get("upgrade");
    if (u === "success" || u === "cancelled") setBanner(u as "success" | "cancelled");
  }, []);

  // Resolve the current cycle client-side (avoids any SSR/client clock mismatch).
  useEffect(() => {
    setCycle(groupIntoCurrentCycle(MOCK_LEDGER, new Date()));
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const [{ data: planRows }, subResult] = await Promise.all([
        supabase
          .from("plans")
          .select("id, tier, display_name, monthly_price_cents, stripe_product_id"),
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
          (planRows as PlanRow[])
            .filter((p) => BETA_VISIBLE_TIERS.has(p.tier))
            .sort((a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99))
        );
      }
      const sub = subResult.data as {
        subscription_status?: string;
        plan?: { tier?: string };
      } | null;
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
      if (!res.ok || !json.url) throw new Error(json.error ?? "Could not start checkout");
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout");
      setCheckoutPlan(null);
    }
  }

  const currentRank = currentTier ? TIER_ORDER[currentTier] ?? 0 : 0;

  const sectionHeader = (title: string, subtitle: string) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>{subtitle}</div>
    </div>
  );
  const labelStyle: CSSProperties = {
    fontSize: 12,
    color: C.textMid,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  };

  return (
    <section style={{ animation: "fadeUp 0.2s ease" }}>
      {/* ── Rev Share Fees (derived entirely from REV_SHARE_BANDS / MIN_QUALIFYING_FACE) ── */}
      <div style={{ marginBottom: 28 }}>
        {sectionHeader("Rev Share Fees", "We earn only when you recover. The rate steps down as invoice size grows.")}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          {REV_SHARE_BANDS.map((band, i) => (
            <div
              key={band.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                padding: "14px 20px",
                borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{bandRange(band)}</div>
              <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>
                {pct(band.rate)} + standard payment processing
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: C.textDim, fontWeight: 500, marginTop: 10, lineHeight: 1.5 }}>
          Payment processing fees are passed through at cost — never marked up or bundled into the rev-share rate.
          <br />
          {fmtWhole(MIN_QUALIFYING_FACE)} minimum invoice face value to qualify.
        </div>
      </div>

      {/* ── Accrual Ledger (prototype mock data grouped under the cycle close date) ── */}
      <div style={{ marginBottom: 28 }}>
        {sectionHeader("Accrual Ledger", "Rev share accrued this cycle from off-platform recoveries.")}
        {!cycle ? (
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>Loading ledger…</div>
        ) : (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            {/* Cycle summary — total accrued + the 15th it bills on (DISPLAY only) */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                padding: "16px 20px",
                background: C.surface,
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <div>
                <div style={labelStyle}>Accrued this cycle</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: C.text, marginTop: 2 }}>
                  {fmtCents(cycle.totalAccrued)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={labelStyle}>Cycle closes</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginTop: 4 }}>
                  {fmtCloseDate(cycle.cycleCloseDate)}
                </div>
              </div>
            </div>

            {/* Column header */}
            <div
              style={{
                display: "flex",
                padding: "8px 20px",
                fontSize: 11,
                fontWeight: 600,
                color: C.textDim,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <div style={{ flex: 2 }}>Invoice</div>
              <div style={{ flex: 1, textAlign: "right" }}>Recovered</div>
              <div style={{ flex: 1, textAlign: "right" }}>Rate</div>
              <div style={{ flex: 1, textAlign: "right" }}>Fee</div>
            </div>

            {/* Rows grouped under this cycle */}
            {cycle.rows.length === 0 ? (
              <div style={{ padding: "16px 20px", fontSize: 13, color: C.textDim, fontWeight: 500 }}>
                No accruals yet this cycle.
              </div>
            ) : (
              cycle.rows.map((row, i) => (
                <div
                  key={row.invoiceRef}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "12px 20px",
                    borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                    fontSize: 13,
                  }}
                >
                  <div style={{ flex: 2, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: C.text }}>{row.invoiceRef}</div>
                    <div style={{ fontSize: 12, color: C.textDim, fontWeight: 500 }}>
                      {fmtWhole(row.faceValue)} face
                    </div>
                  </div>
                  <div style={{ flex: 1, textAlign: "right", color: C.textMid, fontWeight: 500 }}>
                    {fmtCents(row.dollarsRecovered)}
                  </div>
                  <div style={{ flex: 1, textAlign: "right", color: C.textMid, fontWeight: 500 }}>
                    {row.result.qualifies ? pct(row.result.rate) : "—"}
                  </div>
                  <div style={{ flex: 1, textAlign: "right", fontWeight: 600, color: C.text }}>
                    {fmtCents(row.result.feeAmount)}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Existing subscription / tier UI — preserved intact, demoted below ── */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>
          Subscription
        </div>
        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
          {currentTier
            ? `You're on the ${currentTier.charAt(0).toUpperCase() + currentTier.slice(1)} plan${status ? ` · ${status}` : ""}.`
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
