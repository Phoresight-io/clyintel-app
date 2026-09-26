"use client";
import { useState, useEffect } from "react";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { BUSINESS_NAME_MAX, validateBusinessName } from "@/lib/subscriber/businessName";
import { Toast, ToastSuccessDot } from "@/components/ui/Toast";

// Profile tab — the subscriber's customer-facing business name
// (subscribers.business_name). It is what the Recovery Agent says on calls and
// what signs payment/cadence emails. Read with the browser client (RLS scopes it
// to the caller's own row); saved through /api/settings/business-name, which
// validates (trim, non-empty, ≤120) and writes only the caller's row.

export default function ProfileTab() {
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);

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
        .select("business_name")
        .eq("id", user.id)
        .maybeSingle();
      if (!active) return;
      const current = (sub as { business_name?: string | null } | null)?.business_name;
      if (typeof current === "string") setName(current);
      setLoaded(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleSave = async () => {
    const result = validateBusinessName(name);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/business-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_name: result.name }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not save business name.");
        return;
      }
      const data = (await res.json()) as { business_name: string };
      setName(data.business_name);
      setShowToast(true);
    } catch {
      setError("Could not save business name.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={{ animation: "fadeUp 0.2s ease" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>Profile</div>
        <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
          How your business appears to your customers.
        </div>
      </div>

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
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>Business name</div>
          <div style={{ fontSize: 13, color: C.textDim, fontWeight: 500 }}>
            Your Recovery Agent says this name on calls, and it signs your payment emails.
          </div>
        </div>

        <label
          htmlFor="business-name"
          style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}
        >
          Name your customers see on calls and emails
        </label>
        <input
          id="business-name"
          type="text"
          value={name}
          maxLength={BUSINESS_NAME_MAX}
          disabled={!loaded}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          placeholder="e.g. Ocean View Landscaping"
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

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button
            onClick={handleSave}
            disabled={saving || !loaded}
            style={{
              padding: "9px 18px",
              fontSize: 14,
              fontWeight: 600,
              color: "#fff",
              background: saving || !loaded ? C.textDim : C.blue,
              border: "none",
              borderRadius: 6,
              cursor: saving || !loaded ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {showToast && (
        <Toast icon={<ToastSuccessDot />} onDismiss={() => setShowToast(false)}>
          Business name saved
        </Toast>
      )}
    </section>
  );
}
