"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { C } from "@/lib/theme";
import type { Client, NegotiationRec, ClientInvoiceSet } from "@/lib/mock-data";
import type { ClientContactDisplay } from "@/lib/contacts/contactDisplay";
import type { Database } from "@/types/supabase";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import ExchangeDrawer from "@/components/shared/ExchangeDrawer";
import ContactEditorDrawer from "./ContactEditorDrawer";
import PTRWidget from "./PTRWidget";
import NegotiationActions from "@/components/dashboard/NegotiationActions";
import { RecCard } from "@/components/dashboard/RecoveryRecModal";
import { Toast, ToastSuccessDot } from "@/components/ui/Toast";

type ContactUpdate = Database["public"]["Tables"]["client_contacts"]["Update"];

// ── Contacts card sub-components (Contacts editable pass) ─────────────────────
// contact_type sits ABOVE the channels: a header-level POC/Dunning segmented
// toggle. Purely presentational — the parent owns the write + optimistic state.
function TypeToggle({
  type,
  onSelect,
}: {
  type: string | null;
  onSelect: (next: "poc" | "dunning") => void;
}) {
  const seg = (label: string, val: "poc" | "dunning") => {
    const on = type === val;
    return (
      <button
        onClick={() => {
          if (!on) onSelect(val);
        }}
        aria-pressed={on}
        style={{
          padding: "3px 12px",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          border: "none",
          cursor: on ? "default" : "pointer",
          color: on ? "#fff" : C.textMid,
          background: on ? C.blue : "transparent",
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      style={{
        display: "inline-flex",
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        overflow: "hidden",
        background: C.surface,
      }}
    >
      {seg("POC", "poc")}
      {seg("Dunning", "dunning")}
    </div>
  );
}

// One channel row: label + value (or "none") + an Active/Opted-out toggle.
// A channel with no value renders muted and its toggle is disabled — Call and
// Text both pass the shared phone value.
function ChannelRow({
  label,
  value,
  active,
  onToggle,
}: {
  label: string;
  value: string | null;
  active: boolean; // true = channel on (NOT opted out)
  onToggle: () => void;
}) {
  const has = !!value;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: has ? C.navy : C.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          width: 44,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: has ? C.text : C.textDim,
          fontStyle: has ? "normal" : "italic",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {has ? value : "none"}
      </span>
      <span style={{ marginLeft: "auto", flexShrink: 0 }}>
        <button
          onClick={has ? onToggle : undefined}
          disabled={!has}
          aria-pressed={active}
          style={{
            padding: "3px 10px",
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            borderRadius: 8,
            cursor: has ? "pointer" : "not-allowed",
            color: !has ? C.textDim : active ? C.green : C.red,
            background: !has ? C.surface : active ? C.greenBg : C.redBg,
            border: `1px solid ${!has ? C.border : active ? C.green : C.red}`,
          }}
        >
          {!has ? "—" : active ? "Active" : "Opted out"}
        </button>
      </span>
    </div>
  );
}

interface Props {
  client: Client;
  // Real Supabase-backed invoice set for this client. When present, the screen
  // renders real data; otherwise it falls back to mock data for demo mode.
  invoiceSet?: ClientInvoiceSet;
  // Read-only contacts for this client (Brick 3). Undefined in demo/mock mode.
  contacts?: ClientContactDisplay[];
}

export default function DetailScreen({ client, invoiceSet, contacts }: Props) {
  const realMode = invoiceSet !== undefined;
  // Mock data flushed (D2 closeout): real invoice set when present, else empty.
  // negotiationRecs has no real source yet — stays empty until D3.
  const negotiationRecs = [] as NegotiationRec[];
  const invoices = realMode ? invoiceSet : undefined;

  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const [selectedInvoiceForExchanges, setSelectedInvoiceForExchanges] = useState<string | null>(null);
  const [showBack, setShowBack] = useState(false);
  const [recCards, setRecCards] = useState<RecCard[]>(
    negotiationRecs.filter(r => invoices?.outstanding.some(inv => inv.id === r.id)).map(r => ({ ...r, editAmount: r.suggestedAmount, status: "pending" as const }))
  );
  const [activeRecModal, setActiveRecModal] = useState<string | null>(null);
  // Contact editor (Brick 4b): add a dunning contact, or edit an existing one.
  const [contactEditor, setContactEditor] = useState<
    { mode: "add" } | { mode: "edit"; contact: ClientContactDisplay } | null
  >(null);
  const [contactToast, setContactToast] = useState(false);
  const [contactError, setContactError] = useState(false);

  // Local, optimistic copy of the contacts so the header/channel toggles update
  // instantly. Re-syncs whenever the server prop changes (e.g. after the add/edit
  // drawer calls router.refresh()).
  const [contactRows, setContactRows] = useState<ClientContactDisplay[]>(contacts ?? []);
  useEffect(() => {
    setContactRows(contacts ?? []);
  }, [contacts]);

  // Browser (anon-key) client: writes are RLS-scoped to the signed-in subscriber,
  // so no manual subscriber_id filter — the client_contacts policy enforces it.
  const supabase = useMemo(() => createSupabaseBrowser(), []);

  // Optimistic single-field write with rollback. `patch` carries only the toggled
  // column (contact_type or one opt_out_*); on error we restore the whole prior row.
  async function patchContact(id: string, patch: ContactUpdate) {
    const before = contactRows.find((r) => r.id === id);
    if (!before) return;
    setContactRows((rows) =>
      rows.map((r) => (r.id === id ? ({ ...r, ...patch } as ClientContactDisplay) : r)),
    );
    const { error } = await supabase.from("client_contacts").update(patch).eq("id", id);
    if (error) {
      setContactRows((rows) => rows.map((r) => (r.id === before.id ? before : r)));
      setContactError(true);
    }
  }

  useEffect(() => {
    const isDirect = sessionStorage.getItem('clyintel_nav_direct') === 'true';
    setShowBack(!isDirect);
    sessionStorage.removeItem('clyintel_nav_direct');
  }, []);

  const backLabel = from === "portfolio" ? "Back to Portfolio" : "Back to Recovery";
  const backHref = from === "portfolio" ? "/portfolio" : "/";

  const scoreColor = client.score >= 80 ? C.green : client.score >= 60 ? C.amber : C.red;
  const scoreLabel = client.score >= 80 ? "Low risk" : client.score >= 60 ? "Medium risk" : "High risk";

  const allActive = invoices ? [...(invoices.outstanding || []), ...(invoices.upcoming || [])] : [];
  const allInvoicesList = invoices ? [...(invoices.outstanding || []), ...(invoices.upcoming || []), ...(invoices.paid || [])] : [];

  const totalPastDue = allActive.filter(i => i.status === "past_due").reduce((s, i) => s + i.amount, 0);
  const totalRecovered = invoices ? (invoices.paid || []).reduce((s, i) => s + i.amount, 0) : 0;
  const totalOutstandingAmt = allActive.reduce((s, i) => s + i.amount, 0);

  const invoiceSummaryStats = [
    { label: "Total Outstanding", value: totalOutstandingAmt > 0 ? `$${totalOutstandingAmt.toLocaleString()}` : "—", color: totalOutstandingAmt > 0 ? C.text : C.textDim },
    { label: "Total Past Due", value: totalPastDue > 0 ? `$${totalPastDue.toLocaleString()}` : "—", color: totalPastDue > 0 ? C.red : C.textDim },
    { label: "Total Recovered", value: totalRecovered > 0 ? `$${totalRecovered.toLocaleString()}` : "—", color: totalRecovered > 0 ? C.green : C.textDim },
  ];

  const prevScore = client.prevScore;
  const scoreDelta = client.score - prevScore;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, padding: "28px 36px", minHeight: 520, fontFamily: C.sans }}>
      <div style={{ marginBottom: 24 }}>
        {showBack && (
          <button onClick={() => router.back()} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 15, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}>
            <span style={{ fontSize: 16 }}>←</span> Back
          </button>
        )}
<div style={{ fontSize: 28, fontWeight: 600, color: C.navy }}>Clyintel Analyzer</div>
      </div>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* Left Panel */}
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text }}>{client.name}</div>
          </div>

          <PTRWidget client={client} />

          <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0 16px" }} />

          {/* Invoice Summary */}
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
            <div style={{ padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>Invoice Summary</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
              {invoiceSummaryStats.map((w, i, arr) => (
                <div key={w.label} style={{ padding: "14px 16px", borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none", textAlign: "center" }}>
                  <div style={{ fontSize: 11, color: C.navy, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>{w.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: w.color, fontFamily: C.mono }}>{w.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Contacts. contact_type is a header-level POC/Dunning toggle above
              three independent channels: Email (opt_out_email), Call
              (opt_out_voice) and Text (opt_out_sms). Call and Text share the one
              phone value. Toggles write through the RLS-scoped browser client.
              Only rendered in real mode (contacts !== undefined). */}
          {contacts !== undefined && (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>Contacts</span>
                <button onClick={() => setContactEditor({ mode: "add" })} style={{ fontSize: 12, fontWeight: 600, color: C.blue, background: C.blueBg, border: `1px solid ${C.blue}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>+ Add contact</button>
              </div>
              {contactRows.length === 0 ? (
                <div style={{ padding: "20px 16px", fontSize: 14, color: C.textDim, fontWeight: 500 }}>No contacts on file.</div>
              ) : (
                contactRows.map((ct, i) => (
                  <div key={ct.id} style={{ padding: "14px 16px", borderTop: i > 0 ? `1px solid ${C.border}` : "none", display: "flex", flexDirection: "column", gap: 10 }}>
                    {/* Header: name + role + Primary badge (left), POC/Dunning toggle (right) */}
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 15, fontWeight: 600, color: ct.name ? C.text : C.textDim }}>
                            {ct.name || "Unnamed contact"}
                          </span>
                          {ct.is_primary && (
                            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: C.green, background: C.greenBg, border: `1px solid ${C.green}`, borderRadius: 8, padding: "1px 6px" }}>Primary</span>
                          )}
                        </div>
                        {ct.role && (
                          <div style={{ fontSize: 12, fontWeight: 500, color: C.textMid, marginTop: 2 }}>{ct.role}</div>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        {/* Edit opens the existing add/edit drawer (name/email). Dunning
                            only — the mutation route refuses PoC writes. */}
                        {ct.contact_type === "dunning" && (
                          <button onClick={() => setContactEditor({ mode: "edit", contact: ct })} style={{ fontSize: 12, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px" }}>Edit</button>
                        )}
                        <TypeToggle type={ct.contact_type} onSelect={(next) => patchContact(ct.id, { contact_type: next })} />
                      </div>
                    </div>

                    {/* Three independent channels. Call + Text share ct.phone. */}
                    <ChannelRow
                      label="Email"
                      value={ct.email}
                      active={!ct.opt_out_email}
                      onToggle={() => patchContact(ct.id, { opt_out_email: !ct.opt_out_email })}
                    />
                    <ChannelRow
                      label="Call"
                      value={ct.phone}
                      active={!ct.opt_out_voice}
                      onToggle={() => patchContact(ct.id, { opt_out_voice: !ct.opt_out_voice })}
                    />
                    <ChannelRow
                      label="Text"
                      value={ct.phone}
                      active={!ct.opt_out_sms}
                      onToggle={() => patchContact(ct.id, { opt_out_sms: !ct.opt_out_sms })}
                    />
                  </div>
                ))
              )}
            </div>
          )}

          <NegotiationActions cards={recCards} onUpdate={(id, patch) => setRecCards(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))} activeModal={activeRecModal} setActiveModal={setActiveRecModal} />

          {/* Invoice History Table */}
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>Invoice History</span>
            </div>
            {allInvoicesList.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 20px", color: "#6B7280" }}>No invoices found for this client.</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "120px 120px 120px 100px 120px 1fr 36px", gap: 16, padding: "12px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  <div>Invoice #</div><div>Amount</div><div>Due Date</div><div>Due In</div><div>Status</div><div>Last Activity</div><div />
                </div>
                {allInvoicesList.map((inv, i) => {
                  const isPastDue = inv.status === "past_due";
                  const isPaid = inv.status === "paid";
                  const dueInValue = isPaid ? (inv.paidDate || "—") : isPastDue && inv.daysOverdue ? `-${inv.daysOverdue}d` : inv.daysUntilDue ? `${inv.daysUntilDue}d` : "—";
                  const statusColor = isPaid ? C.green : isPastDue ? C.red : C.text;
                  const statusLabel = isPaid ? "Paid" : isPastDue ? "Past Due" : "Current";
                  return (
                    <div key={inv.id} style={{ display: "grid", gridTemplateColumns: "120px 120px 120px 100px 120px 1fr 36px", gap: 16, padding: "14px 16px", borderBottom: i < allInvoicesList.length - 1 ? `1px solid ${C.border}` : "none", fontSize: 15, alignItems: "center", background: isPaid ? "rgba(22,163,74,0.03)" : "transparent" }}>
                      <div onClick={() => !isPaid && setSelectedInvoiceForExchanges(inv.id)} style={{ fontFamily: C.mono, fontSize: 14, color: isPaid ? C.textMid : C.blue, cursor: isPaid ? "default" : "pointer" }} onMouseEnter={(e) => { if (!isPaid) e.currentTarget.style.color = C.amber; }} onMouseLeave={(e) => { if (!isPaid) e.currentTarget.style.color = C.blue; }}>{inv.id}</div>
                      <div style={{ fontFamily: C.mono, fontSize: 16, color: isPastDue ? C.red : C.text }}>${inv.amount.toLocaleString()}</div>
                      <div style={{ fontSize: 15, color: isPastDue ? C.red : C.textMid }}>{inv.dueDate}</div>
                      <div style={{ fontSize: 14, color: isPaid ? C.green : isPastDue ? C.red : C.text }}>{dueInValue}</div>
                      <div style={{ fontSize: 14, fontWeight: isPaid ? 600 : 400, color: statusColor }}>{statusLabel}</div>
                      <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500 }}>{inv.lastActivity}</div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {!isPaid && negotiationRecs.some(r => r.id === inv.id) && (
                          <button onClick={() => setActiveRecModal(inv.id)} title="Recovery recommendation pending" style={{ width: 26, height: 26, borderRadius: "50%", background: C.amberBg, color: C.amber, border: "none", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }} onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.75")} onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}>!</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Right Rail - Client Score */}
        <div style={{ width: 300 }}>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "18px 20px", position: "sticky", top: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 12 }}>Client Score</div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 48, fontWeight: 700, color: scoreColor, fontFamily: C.mono }}>{client.score}</div>
                <div style={{ fontSize: 15, color: C.textMid, fontWeight: 500 }}>
                  <span style={{ color: scoreColor, fontWeight: 600 }}>{scoreDelta > 0 ? "▲" : "▼"} {Math.abs(scoreDelta)}</span> (prev: {prevScore})
                </div>
              </div>
              <div style={{ fontSize: 13, color: C.textMid, fontWeight: 500, marginBottom: 10 }}>out of 100</div>
              <div style={{ height: 6, borderRadius: 3, background: "linear-gradient(to right, #DC2626 0%, #F59E0B 50%, #16A34A 100%)", marginBottom: 12, position: "relative" }}>
                <div style={{ position: "absolute", left: `${client.score}%`, top: -2, width: 10, height: 10, borderRadius: "50%", background: scoreColor, border: "2px solid #FFFFFF" }} />
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: scoreColor, marginBottom: 14 }}>{scoreLabel}</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Score Summary</div>
              <div style={{ paddingLeft: 8 }}>
                {client.scoreSummary.map((line, i) => (
                  <div key={i} style={{ fontSize: 15, fontWeight: 500, color: C.textMid, marginBottom: i < client.scoreSummary.length - 1 ? 6 : 0 }}>• {line}</div>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Score Factors</div>
              <div style={{ paddingLeft: 8 }}>
                {client.scoreFactors.map((line, i) => (
                  <div key={i} style={{ fontSize: 15, fontWeight: 500, color: C.textMid, marginBottom: i < client.scoreFactors.length - 1 ? 6 : 0 }}>• {line}</div>
                ))}
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${C.border}`, margin: "16px 0" }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>Risk Drivers</div>
              <div style={{ paddingLeft: 8 }}>
                {client.riskDrivers.map((line, i) => (
                  <div key={i} style={{ fontSize: 15, fontWeight: 500, color: C.textMid, marginBottom: i < client.riskDrivers.length - 1 ? 6 : 0 }}>• {line}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedInvoiceForExchanges && (
        <ExchangeDrawer invoiceId={selectedInvoiceForExchanges} onClose={() => setSelectedInvoiceForExchanges(null)} />
      )}

      {/* Contact editor drawer (Brick 4b). client.id is the real clients.id uuid
          in real mode (the only mode the Contacts card renders in). The success
          Toast lives here so it survives the drawer's unmount + router.refresh(). */}
      {contactEditor && (
        <ContactEditorDrawer
          clientId={String(client.id)}
          contact={contactEditor.mode === "edit" ? contactEditor.contact : undefined}
          existingContacts={contacts ?? []}
          onClose={() => setContactEditor(null)}
          onSaved={() => {
            setContactToast(true);
            router.refresh();
          }}
        />
      )}

      {contactToast && (
        <Toast icon={<ToastSuccessDot />} onDismiss={() => setContactToast(false)}>
          Contact saved.
        </Toast>
      )}

      {contactError && (
        <Toast
          icon={<span style={{ width: 8, height: 8, borderRadius: "50%", background: C.red, display: "inline-block", flexShrink: 0 }} />}
          onDismiss={() => setContactError(false)}
        >
          Couldn&apos;t update contact. Change reverted.
        </Toast>
      )}
    </div>
  );
}
