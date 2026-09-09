"use client";
import { useState } from "react";
import { C } from "@/lib/theme";
import { validateEmail } from "@/lib/validateEmail";
import { type ClientContactDisplay, rankLabel } from "@/lib/contacts/contactDisplay";
import { takenEmailRanks } from "@/lib/contacts/contactRanks";

// Add/edit a DUNNING contact (Contacts Brick 4b) via the 4a mutation route.
// Drawer idiom mirrors components/shared/ExchangeDrawer.tsx (fixed overlay +
// 500px right panel + slideInRight + header/✕ + body); form idiom mirrors
// RevenueRecoveryTab (useState fields, save → fetch, inline error string).
//
// Scope: email + email_rank only. Delete + sms/voice ranks + opt-outs are 4c.
// PoC rows never reach this component (DetailScreen renders no edit control on
// them) — the route also refuses a poc write, so this stays dunning-only.
//
// The success Toast is owned by the parent (DetailScreen): on success this drawer
// calls onSaved() then onClose(), and the drawer unmounts — a Toast rendered here
// would never paint, so the parent shows it (and survives the unmount + refresh).

interface Props {
  clientId: string; // real clients.id uuid (client.id in real mode)
  contact?: ClientContactDisplay; // undefined = ADD, present = EDIT
  existingContacts: ClientContactDisplay[]; // to compute taken ranks
  onClose: () => void; // cancel (✕ / backdrop)
  onSaved: () => void; // success: parent refreshes + toasts + closes
}

export default function ContactEditorDrawer({
  clientId,
  contact,
  existingContacts,
  onClose,
  onSaved,
}: Props) {
  const isEdit = contact !== undefined;

  const taken = takenEmailRanks(existingContacts, contact?.id);
  // Offer enough ranks that at least one slot is always free.
  const maxRank = Math.max(3, existingContacts.length + 1);
  const rankOptions = Array.from({ length: maxRank }, (_, i) => i + 1);
  const firstFree = rankOptions.find((r) => !taken.has(r)) ?? 1;

  const [name, setName] = useState(contact?.name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [emailRank, setEmailRank] = useState<number>(contact?.email_rank ?? firstFree);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const result = validateEmail(email);
    if (!result.ok) {
      setError(result.reason === "empty" ? "Enter an email address." : "Enter a valid email address.");
      return;
    }
    setSaving(true);
    setError(null);
    // Name is optional: trim, and send null when empty so the greeting falls
    // back to the company name rather than storing an empty string.
    const trimmedName = name.trim();
    const nameValue = trimmedName === "" ? null : trimmedName;
    try {
      const res = await fetch("/api/clients/contacts", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit
            ? { id: contact!.id, name: nameValue, email: result.email, email_rank: emailRank }
            : { client_id: clientId, name: nameValue, email: result.email, email_rank: emailRank },
        ),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(
          res.status === 409
            ? "That rank is already in use for this channel."
            : data?.error ?? "Could not save the contact.",
        );
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError("Could not save the contact.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.3)", zIndex: 999 }}
      />
      <div
        style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 500, background: "#FFFFFF", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)", zIndex: 1000, display: "flex", flexDirection: "column", fontFamily: C.sans }}
      >
        <style>{`@keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
        <div style={{ animation: "slideInRight 0.3s ease-out", display: "flex", flexDirection: "column", height: "100%" }}>
          {/* Header */}
          <div style={{ padding: "24px 28px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1, marginRight: 16 }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: C.text, marginBottom: 4 }}>
                {isEdit ? "Edit contact" : "Add contact"}
              </div>
              <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500 }}>
                Dunning contact · email is the active channel
              </div>
            </div>
            <button onClick={onClose} style={{ padding: "8px 12px", fontSize: 18, color: C.textMid, fontWeight: 500, background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
          </div>

          {/* Body — form */}
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
            <label htmlFor="contact-name" style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>
              Contact name (optional)
            </label>
            <input
              id="contact-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Jordan Reyes"
              style={{ width: "100%", padding: "9px 12px", fontSize: 14, fontWeight: 500, color: C.text, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, outline: "none", boxSizing: "border-box", marginBottom: 18 }}
            />

            <label htmlFor="contact-email" style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>
              Email
            </label>
            <input
              id="contact-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(null);
              }}
              placeholder="name@company.com"
              style={{ width: "100%", padding: "9px 12px", fontSize: 14, fontWeight: 500, color: C.text, background: C.surface, border: `1px solid ${error ? C.red : C.border}`, borderRadius: 6, outline: "none", boxSizing: "border-box" }}
            />

            <label htmlFor="contact-email-rank" style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, margin: "18px 0 6px" }}>
              Email priority
            </label>
            <select
              id="contact-email-rank"
              value={emailRank}
              onChange={(e) => setEmailRank(Number(e.target.value))}
              style={{ width: "100%", padding: "9px 12px", fontSize: 14, fontWeight: 500, color: C.text, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, outline: "none", boxSizing: "border-box" }}
            >
              {rankOptions.map((r) => {
                const disabled = taken.has(r) && r !== contact?.email_rank;
                return (
                  <option key={r} value={r} disabled={disabled}>
                    {rankLabel(r)}
                    {disabled ? " — in use" : ""}
                  </option>
                );
              })}
            </select>
            <div style={{ fontSize: 12, color: C.textDim, marginTop: 6 }}>
              A rank already used by another contact for this client is disabled.
            </div>

            {error && (
              <div style={{ marginTop: 14, padding: "8px 12px", borderRadius: 8, fontSize: 13, fontWeight: 500, background: C.redBg, border: `1px solid ${C.red}`, color: C.red }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
              <button
                onClick={onClose}
                style={{ padding: "9px 18px", fontSize: 14, fontWeight: 600, color: C.textMid, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ padding: "9px 18px", fontSize: 14, fontWeight: 600, color: "#fff", background: saving ? C.textDim : C.blue, border: "none", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer" }}
              >
                {saving ? "Saving…" : isEdit ? "Save changes" : "Add contact"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
