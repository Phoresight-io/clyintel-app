"use client";
import { useState, useEffect } from "react";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { validatePaymentLink } from "@/lib/validatePaymentLink";
import { Toast, ToastSuccessDot } from "@/components/ui/Toast";

// Revenue Recovery tab — holds recovery mechanics (not the connect card, which
// lives in Integrations > Revenue Share). This tab now owns the account-level
// default payment link (set + update + test). Off-platform reconciliation
// remains a future prompt; those sections stay as placeholders below.
//
// NOTE: there is deliberately no clear/remove affordance here. Emptying the
// input does not persist — clearing an existing link is guarded (impact-check +
// warning) and ships separately in A′-2.

export default function RevenueRecoveryTab() {
  // Current input value for the default payment link. Seeded on mount from the
  // subscriber's stored value; edited freely thereafter.
  const [linkValue, setLinkValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);

  // Read the subscriber's current default payment link into local state. Scoped
  // to the caller's own row (subscribers PK = auth user id), matching the read
  // convention used elsewhere in Settings (IntegrationsScreen).
  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || !active) return;
      const { data: sub } = await supabase
        .from("subscribers")
        .select("payment_link_url")
        .eq("id", user.id)
        .maybeSingle();
      if (!active) return;
      const current = (sub as { payment_link_url?: string | null } | null)?.payment_link_url;
      if (typeof current === "string") setLinkValue(current);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Client-side validation, recomputed each render (pure + cheap). Gates the
  // Test link button and short-circuits Save so bad input never round-trips.
  const validation = validatePaymentLink(linkValue);
  const canTest = validation.ok;

  const handleSave = async () => {
    const result = validatePaymentLink(linkValue);
    if (!result.ok) {
      setError(result.reason === "empty" ? "Enter a payment link to save." : result.reason);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_link_url: result.url }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not save payment link.");
        return;
      }
      const data = (await res.json()) as { payment_link_url: string };
      setLinkValue(data.payment_link_url);
      setShowToast(true);
    } catch {
      setError("Could not save payment link.");
    } finally {
      setSaving(false);
    }
  };

  // Opens the CURRENT input value in a new tab — does not save. Only reachable
  // when the input passes client-side validation (canTest).
  const handleTest = () => {
    if (!canTest) return;
    window.open(validation.url, "_blank", "noopener,noreferrer");
  };

  return (
    <section style={{ animation: "fadeUp 0.2s ease" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>
          Revenue Recovery
        </div>
        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
          Configure how ClyIntel recovers overdue invoices on your behalf.
        </div>
      </div>

      {/* Default Payment Link */}
      <div
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "20px 24px",
          marginBottom: 16,
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>
            Default Payment Link
          </div>
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            The payment link ClyIntel uses by default when recovering overdue invoices.
          </div>
        </div>

        <label
          htmlFor="default-payment-link"
          style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}
        >
          Default payment link (https://…)
        </label>
        <input
          id="default-payment-link"
          type="url"
          value={linkValue}
          onChange={(e) => {
            setLinkValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="https://buy.stripe.com/…"
          style={{
            width: "100%",
            padding: "9px 12px",
            fontSize: 14,
            fontWeight: 500,
            color: C.text,
            background: C.surface,
            border: `1px solid ${error ? C.red : C.border}`,
            borderRadius: 6,
            outline: "none",
            boxSizing: "border-box",
          }}
        />

        {error && (
          <div
            style={{
              marginTop: 10,
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

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
          <button
            onClick={handleTest}
            disabled={!canTest}
            style={{
              padding: "9px 18px",
              fontSize: 14,
              fontWeight: 600,
              color: canTest ? C.blue : C.textDim,
              background: C.surface,
              border: `1px solid ${canTest ? C.blue : C.border}`,
              borderRadius: 6,
              cursor: canTest ? "pointer" : "not-allowed",
            }}
          >
            Test link
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "9px 18px",
              fontSize: 14,
              fontWeight: 600,
              color: "#fff",
              background: saving ? C.textDim : C.blue,
              border: "none",
              borderRadius: 6,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Off-Platform Payment Reconciliation */}
      <div
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "20px 24px",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>
              Off-Platform Payment Reconciliation
            </div>
            <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
              Automatically reconcile payments collected outside of ClyIntel payment links.
            </div>
          </div>
          <div
            style={{
              width: 40,
              height: 22,
              borderRadius: 11,
              background: C.border,
              cursor: "not-allowed",
              flexShrink: 0,
              opacity: 0.5,
            }}
          />
        </div>
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: C.surface,
            border: `1px dashed ${C.border}`,
            fontSize: 13,
            color: C.textDim,
            fontWeight: 500,
          }}
        >
          Off-platform reconciliation settings coming soon.
        </div>
      </div>

      {/* Recent Off-Platform Captures */}
      <div
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "20px 24px",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>
          Recent Off-Platform Captures
        </div>
        <div
          style={{
            padding: "32px 24px",
            borderRadius: 8,
            background: C.surface,
            border: `1px dashed ${C.border}`,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, marginBottom: 4 }}>
            No captures yet
          </div>
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            Off-platform payments will appear here once reconciliation is enabled.
          </div>
        </div>
      </div>

      {showToast && (
        <Toast icon={<ToastSuccessDot />} onDismiss={() => setShowToast(false)}>
          Default payment link saved
        </Toast>
      )}
    </section>
  );
}
