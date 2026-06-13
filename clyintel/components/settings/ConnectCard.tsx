"use client";
import { useState, useEffect, type ReactNode } from "react";
import { C } from "@/lib/theme";
import { getProvider } from "@/lib/providers";

const STRIPE = getProvider("stripe");

type OnboardingStatus = "not_started" | "pending" | "complete" | "restricted" | "disconnected";
type VisualState = "not_started" | "pending" | "connected" | "restricted" | "disconnected";
type LinkDisposition = "void" | "keep";

interface ConnectStatus {
  connected: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  onboarding_status: OnboardingStatus;
  last_link_disposition: LinkDisposition | null;
}

function deriveVisualState(cs: ConnectStatus | null): VisualState {
  if (!cs || cs.onboarding_status === "not_started") return "not_started";
  if (cs.onboarding_status === "disconnected") return "disconnected";
  if (cs.charges_enabled && cs.payouts_enabled) return "connected";
  if (cs.onboarding_status === "restricted") return "restricted";
  return "pending";
}

function formatRate(rate: number | null): string | null {
  if (rate == null) return null;
  return String(Number((rate * 100).toFixed(2)));
}

interface ConnectCardProps {
  revShareRate: number | null;
}

export default function ConnectCard({ revShareRate }: ConnectCardProps) {
  const [cs, setCs] = useState<ConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");

  // Interstitial shown only on initial connect (not_started → Stripe)
  const [showInterstitial, setShowInterstitial] = useState(false);

  // Disconnect dialog state
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [disconnectInput, setDisconnectInput] = useState("");
  const [linkDisposition, setLinkDisposition] = useState<LinkDisposition | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Reconnect warning: fires when returning from Stripe with last_link_disposition === "keep"
  const [showReconnectWarn, setShowReconnectWarn] = useState(false);
  const [expiringLinks, setExpiringLinks] = useState(false);

  const ratePct = formatRate(revShareRate);
  const disclosure = STRIPE.feeDisclosure(ratePct);

  async function fetchStatus() {
    try {
      const res = await fetch(STRIPE.routes.status, { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as ConnectStatus;
        setCs(json);
        const params = new URLSearchParams(window.location.search);
        if (params.get("connect") === "complete" && json.last_link_disposition === "keep") {
          setShowReconnectWarn(true);
        }
      }
    } catch {
      // Leave cs null; card renders a retry CTA.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doOnboard() {
    setError("");
    setActing(true);
    try {
      const res = await fetch(STRIPE.routes.onboard, { method: "POST" });
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !json.url) throw new Error(json.error ?? "Could not start onboarding");
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start onboarding");
      setActing(false);
    }
  }

  async function handleDisconnect() {
    if (!linkDisposition) return;
    setDisconnecting(true);
    setError("");
    try {
      const res = await fetch("/api/connect/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkDisposition }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? "Disconnect failed");
      }
      setShowDisconnect(false);
      setDisconnectInput("");
      setLinkDisposition(null);
      setLoading(true);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleExpireLinks() {
    setExpiringLinks(true);
    try {
      await fetch("/api/connect/expire-links", { method: "POST" });
    } finally {
      setExpiringLinks(false);
      setShowReconnectWarn(false);
      // Update local state to clear last_link_disposition
      setCs((prev) => prev ? { ...prev, last_link_disposition: null } : prev);
    }
  }

  const vstate = deriveVisualState(cs);
  const disconnectConfirmed =
    disconnectInput.trim().toLowerCase() === "disconnect" && linkDisposition !== null;

  function badge(text: string, tone: "grey" | "amber" | "green" | "red"): ReactNode {
    const map = {
      grey:  { bg: C.surface,  border: C.border, color: C.textMid },
      amber: { bg: C.amberBg, border: C.amber,  color: C.amber  },
      green: { bg: C.greenBg, border: C.green,  color: C.green  },
      red:   { bg: C.redBg,   border: C.red,    color: C.red    },
    }[tone];
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 20,
          fontSize: 12,
          fontWeight: 600,
          background: map.bg,
          border: `1px solid ${map.border}`,
          color: map.color,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: map.color,
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        {text}
      </span>
    );
  }

  function primaryBtn(label: string, onClick: () => void): ReactNode {
    return (
      <button
        onClick={onClick}
        disabled={acting}
        style={{
          padding: "8px 16px",
          fontSize: 13,
          fontWeight: 600,
          color: "#fff",
          background: acting ? C.textDim : C.blue,
          border: "none",
          borderRadius: 6,
          cursor: acting ? "not-allowed" : "pointer",
          flexShrink: 0,
        }}
      >
        {acting ? "Redirecting…" : label}
      </button>
    );
  }

  function secondaryBtn(label: string, onClick: () => void, danger = false): ReactNode {
    return (
      <button
        onClick={onClick}
        style={{
          padding: "8px 16px",
          fontSize: 13,
          fontWeight: 600,
          color: danger ? C.red : C.textMid,
          background: C.surface,
          border: `1px solid ${danger ? C.red : C.border}`,
          borderRadius: 6,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {label}
      </button>
    );
  }

  let stateContent: ReactNode;

  if (loading) {
    stateContent = (
      <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>Checking connection…</div>
    );
  } else if (vstate === "connected") {
    stateContent = (
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {badge("Connected", "green")}
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            Your Stripe account is connected and ready to collect on overdue invoices
            {cs?.payouts_enabled ? " and receive payouts" : ""}. {disclosure}
          </div>
        </div>
        {secondaryBtn("Disconnect", () => setShowDisconnect(true), true)}
      </div>
    );
  } else if (vstate === "pending") {
    stateContent = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {badge("Pending", "amber")}
        <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>{disclosure}</div>
        {primaryBtn(STRIPE.copy.finishCta, doOnboard)}
      </div>
    );
  } else if (vstate === "restricted") {
    stateContent = (
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {badge("Restricted", "red")}
          <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>
            Stripe has restricted this account. Resolve the issues to resume collecting. {disclosure}
          </div>
          {primaryBtn(STRIPE.copy.continueCta, doOnboard)}
        </div>
        {secondaryBtn("Disconnect", () => setShowDisconnect(true), true)}
      </div>
    );
  } else if (vstate === "disconnected") {
    stateContent = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {badge("Disconnected", "grey")}
        <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>
          Your Stripe account is disconnected. Reconnect to resume collecting on overdue invoices. {disclosure}
        </div>
        {primaryBtn(STRIPE.copy.reconnectCta, doOnboard)}
      </div>
    );
  } else {
    // not_started
    stateContent = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>{disclosure}</div>
        {primaryBtn(STRIPE.copy.connectCta, () => setShowInterstitial(true))}
      </div>
    );
  }

  return (
    <>
      {/* Main card */}
      <div
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 2 }}>
            {STRIPE.copy.cardTitle}
          </div>
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            {STRIPE.copy.cardSubtitle}
          </div>
        </div>
        {stateContent}
        {error && (
          <div
            style={{
              padding: "8px 12px",
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
      </div>

      {/* Interstitial — initial connect only */}
      {showInterstitial && (
        <Modal onClose={() => setShowInterstitial(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.navy, marginBottom: 4 }}>
                Connect Stripe Express
              </div>
              <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
                Powered by Stripe — you&apos;ll be redirected to complete setup.
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                ["1", "Create your Stripe Express account", "Takes about 2 minutes. Stripe securely verifies your identity."],
                ["2", "Link a payout bank account", "Stripe deposits recovered payments directly to your bank."],
                ["3", "Start collecting on overdue invoices", "Payment links become available once your account is approved."],
              ].map(([step, title, desc]) => (
                <div key={step} style={{ display: "flex", gap: 12 }}>
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      background: C.blueBg,
                      border: `1px solid ${C.blue}`,
                      color: C.blue,
                      fontSize: 11,
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    {step}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{title}</div>
                    <div style={{ fontSize: 12, color: C.textDim, fontWeight: 500, marginTop: 2 }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {ratePct && (
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: C.blueBg,
                  border: `1px solid ${C.blue}`,
                  fontSize: 13,
                  color: C.navy,
                  fontWeight: 500,
                }}
              >
                {disclosure}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowInterstitial(false)}
                style={{
                  padding: "9px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.textMid,
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                onClick={doOnboard}
                disabled={acting}
                style={{
                  padding: "9px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "#fff",
                  background: acting ? C.textDim : C.blue,
                  border: "none",
                  borderRadius: 6,
                  cursor: acting ? "not-allowed" : "pointer",
                }}
              >
                {acting ? "Redirecting…" : "Continue to Stripe"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Disconnect dialog */}
      {showDisconnect && (
        <Modal onClose={() => { setShowDisconnect(false); setDisconnectInput(""); setLinkDisposition(null); }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.navy, marginBottom: 4 }}>
                Disconnect Stripe Express
              </div>
              <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
                This will stop ClyIntel from generating payment links on your behalf.
                Your Stripe account itself is not affected.
              </div>
            </div>

            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>
                What should happen to active payment links?
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ display: "flex", gap: 10, cursor: "pointer", alignItems: "flex-start" }}>
                  <input
                    type="radio"
                    name="link_disposition"
                    value="void"
                    checked={linkDisposition === "void"}
                    onChange={() => setLinkDisposition("void")}
                    style={{ marginTop: 2, accentColor: C.blue }}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Void active links now</div>
                    <div style={{ fontSize: 12, color: C.textDim, fontWeight: 500 }}>
                      All active recovery links are immediately expired. Clients who click them will see an expired page.
                    </div>
                  </div>
                </label>
                <label style={{ display: "flex", gap: 10, cursor: "pointer", alignItems: "flex-start" }}>
                  <input
                    type="radio"
                    name="link_disposition"
                    value="keep"
                    checked={linkDisposition === "keep"}
                    onChange={() => setLinkDisposition("keep")}
                    style={{ marginTop: 2, accentColor: C.blue }}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Keep active links live</div>
                    <div style={{ fontSize: 12, color: C.textDim, fontWeight: 500 }}>
                      Existing links continue working and route payments to your current Stripe account.
                      New links cannot be generated while disconnected.
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>
                Type DISCONNECT to confirm
              </label>
              <input
                type="text"
                value={disconnectInput}
                onChange={(e) => setDisconnectInput(e.target.value)}
                placeholder="DISCONNECT"
                autoFocus
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.text,
                  background: C.surface,
                  border: `1px solid ${disconnectConfirmed ? C.red : C.border}`,
                  borderRadius: 6,
                  outline: "none",
                  boxSizing: "border-box",
                  letterSpacing: "0.03em",
                }}
              />
            </div>

            {error && (
              <div
                style={{
                  padding: "8px 12px",
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

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setShowDisconnect(false); setDisconnectInput(""); setLinkDisposition(null); }}
                style={{
                  padding: "9px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.textMid,
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleDisconnect}
                disabled={!disconnectConfirmed || disconnecting}
                style={{
                  padding: "9px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "#fff",
                  background: !disconnectConfirmed || disconnecting ? C.textDim : C.red,
                  border: "none",
                  borderRadius: 6,
                  cursor: !disconnectConfirmed || disconnecting ? "not-allowed" : "pointer",
                }}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect account"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Reconnect warning — shown when reconnecting with kept-live links */}
      {showReconnectWarn && (
        <Modal onClose={() => setShowReconnectWarn(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.amber, marginBottom: 4 }}>
                Active links may need updating
              </div>
              <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
                You previously kept active payment links live when you disconnected. If you reconnected
                with a different Stripe account, those links still route to your previous account and
                cannot be transferred. You can expire them now or leave them as-is.
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowReconnectWarn(false)}
                style={{
                  padding: "9px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.textMid,
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Keep links active
              </button>
              <button
                onClick={handleExpireLinks}
                disabled={expiringLinks}
                style={{
                  padding: "9px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "#fff",
                  background: expiringLinks ? C.textDim : C.amber,
                  border: "none",
                  borderRadius: 6,
                  cursor: expiringLinks ? "not-allowed" : "pointer",
                }}
              >
                {expiringLinks ? "Expiring…" : "Expire active links"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "rgba(0,0,0,0.35)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 14,
          padding: "28px 32px",
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
