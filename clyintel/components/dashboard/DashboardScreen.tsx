"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import * as mockRaw from "@/lib/mock-data";
import type { Invoice, Client, NegotiationRec, ClientInvoiceSet, Exchange } from "@/lib/mock-data";
import { isDemoReset, CLIENTS_KEY, INTEGRATIONS_KEY } from "@/lib/demo-mode";
import ExchangeDrawer from "@/components/shared/ExchangeDrawer";
import NegotiationActions from "./NegotiationActions";
import { RecCard } from "./RecoveryRecModal";

type SortCol = "clientName" | "id" | "amount" | "dueDate" | "daysOverdue" | "status" | "lastActivity";
type SortDir = "asc" | "desc";

interface ActiveFilters {
  status: string[];
  dueDate: string[];
  customer: string[];
  invoiceNumber: string[];
}

interface FlatInvoice extends Invoice {
  clientName: string;
  clientId: number;
}

export default function DashboardScreen() {
  const isReset = isDemoReset();
  const isCustomMode = !!localStorage.getItem(INTEGRATIONS_KEY);
  const storedClients: Client[] = (() => {
    if (isReset) return [];
    try { return JSON.parse(localStorage.getItem(CLIENTS_KEY) || '[]') as Client[]; } catch { return []; }
  })();
  const clients = isReset ? [] : isCustomMode ? storedClients : [...mockRaw.clients, ...storedClients];
  const clientInvoices = isReset ? ({} as Record<number, ClientInvoiceSet>) : mockRaw.clientInvoices;
  const invoiceExchanges = isReset ? ({} as Record<string, Exchange[]>) : mockRaw.invoiceExchanges;
  const negotiationRecs = isReset ? ([] as NegotiationRec[]) : mockRaw.negotiationRecs;

  const router = useRouter();
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({ status: [], dueDate: [], customer: [], invoiceNumber: [] });
  const [searchText, setSearchText] = useState("");
  const [selectedInvoiceForHistory, setSelectedInvoiceForHistory] = useState<string | null>(null);
  const [recCards, setRecCards] = useState<RecCard[]>(
    negotiationRecs.map(r => ({ ...r, editAmount: r.suggestedAmount, status: "pending" as const }))
  );
  const [activeRecModal, setActiveRecModal] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>("daysOverdue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const updateRec = (id: string, patch: Partial<RecCard>) =>
    setRecCards(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));

  const pastDueClients = clients.filter(c => c.status === "past_due" || c.status === "due");
  const totalOutstanding = pastDueClients.reduce((sum, c) => sum + c.balance, 0);
  const totalPastDue = pastDueClients.reduce((sum, c) => {
    const inv = clientInvoices[c.id];
    return sum + (inv?.outstanding.reduce((s, i) => s + i.amount, 0) || 0);
  }, 0);
  const activeInvoices = pastDueClients.reduce((sum, c) => {
    const inv = clientInvoices[c.id];
    return sum + (inv?.outstanding.length || 0);
  }, 0);

  const filterInvoices = (invoices: { outstanding: Invoice[]; upcoming: Invoice[] } | undefined): Invoice[] => {
    if (!invoices) return [];
    let all = [...(invoices.outstanding || []), ...(invoices.upcoming || [])];
    if (activeFilters.status.length > 0) all = all.filter(inv => activeFilters.status.includes(inv.status));
    if (activeFilters.dueDate.length > 0) all = all.filter(inv => activeFilters.dueDate.some(f => {
      if (f === "overdue") return inv.status === "past_due";
      if (f === "due_soon") return inv.daysUntilDue !== undefined && inv.daysUntilDue <= 7;
      if (f === "due_later") return inv.daysUntilDue !== undefined && inv.daysUntilDue > 7;
      return false;
    }));
    return all;
  };

  const sortFn = (a: FlatInvoice, b: FlatInvoice): number => {
    let av: number | string, bv: number | string;
    if (sortCol === "amount") { av = a.amount || 0; bv = b.amount || 0; }
    else if (sortCol === "daysOverdue") {
      av = a.status === "past_due" ? -(a.daysOverdue || 0) : (a.daysUntilDue || 0);
      bv = b.status === "past_due" ? -(b.daysOverdue || 0) : (b.daysUntilDue || 0);
    }
    else if (sortCol === "dueDate") { av = new Date(a.dueDate || 0).getTime(); bv = new Date(b.dueDate || 0).getTime(); }
    else { av = ((a as unknown as Record<string, unknown>)[sortCol] || "").toString().toLowerCase(); bv = ((b as unknown as Record<string, unknown>)[sortCol] || "").toString().toLowerCase(); }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  };

  const allInvoices: FlatInvoice[] = pastDueClients.flatMap(client => {
    const invoices = clientInvoices[client.id];
    return filterInvoices(invoices).map(inv => ({ ...inv, clientName: client.name, clientId: client.id }));
  }).filter(inv => {
    if (searchText.length < 3) return true;
    const s = searchText.toLowerCase();
    return inv.id.toLowerCase().includes(s) || inv.clientName.toLowerCase().includes(s);
  }).sort(sortFn);

  const totalFilterCount = Object.values(activeFilters).reduce((s, a) => s + a.length, 0);

  const kpis = [
    { label: "Recovery YTD", value: isReset ? "$0" : "$42,150", color: C.green },
    { label: "Total Outstanding", value: `$${totalOutstanding.toLocaleString()}`, color: C.text },
    { label: "Past Due", value: `$${totalPastDue.toLocaleString()}`, color: C.red },
    { label: "Active Invoices", value: String(activeInvoices), color: C.text },
  ];

  const SortBtn = ({ col, label }: { col: SortCol; label: string }) => {
    const active = sortCol === col;
    const arrow = active ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕";
    return (
      <button onClick={() => toggleSort(col)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
        {label}<span style={{ fontSize: 15, color: C.blue, opacity: active ? 1 : 0.4 }}>{arrow}</span>
      </button>
    );
  };

  const statusMap: Record<string, { label: string; color: string }> = {
    current: { label: "Current", color: C.text },
    due: { label: "Due", color: C.amber },
    past_due: { label: "Past due", color: C.red },
    recovered: { label: "Recovered", color: C.blue },
  };

  return (
    <div style={{ padding: "28px 36px", minHeight: 520, fontFamily: C.sans }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 28, lineHeight: 1.15, fontWeight: 600, color: C.navy }}>Receivables</div>
          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={() => { sessionStorage.removeItem('clyintel_nav_direct'); router.push("/connections"); }} style={{ padding: "8px 16px", fontSize: 15, fontWeight: 600, color: C.blue, background: C.blueBg, border: `1px solid ${C.blue}`, borderRadius: 6, cursor: "pointer" }} onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")} onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}>+ Add Client</button>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        {kpis.map((kpi, i) => (
          <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, textAlign: "center", boxShadow: "0 2px 8px rgba(43,108,176,0.10)" }}>
            <div style={{ fontSize: 14, color: C.navy, marginBottom: 8, fontWeight: 600 }}>{kpi.label}</div>
            <div style={{ fontSize: 34, fontWeight: 700, color: kpi.color, fontFamily: C.mono }}>{kpi.value}</div>
          </div>
        ))}
      </div>

      <NegotiationActions cards={recCards} onUpdate={updateRec} activeModal={activeRecModal} setActiveModal={setActiveRecModal} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: C.navy }}>Outstanding</div>
      </div>
      <div style={{ marginBottom: 20, display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <button
            onClick={() => { const d = document.getElementById("filter-dd"); if (d) d.style.display = d.style.display === "block" ? "none" : "block"; }}
            style={{ padding: "8px 12px", fontSize: 14, fontWeight: 500, border: `1px solid ${C.blue}`, borderRadius: 6, color: C.blue, background: C.card, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <span>Filters</span>
            {totalFilterCount > 0 && <span style={{ background: C.blue, color: "white", borderRadius: 10, padding: "2px 6px", fontSize: 11, fontWeight: 600 }}>{totalFilterCount}</span>}
            <span style={{ fontSize: 10, color: C.blue }}>▼</span>
          </button>
          <div id="filter-dd" style={{ display: "none", position: "absolute", top: "100%", left: 0, marginTop: 4, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", zIndex: 1000, minWidth: 280, maxHeight: 400, overflow: "auto" }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid, marginBottom: 8 }}>Status</div>
              {[{ v: "past_due", l: "Past Due" }, { v: "current", l: "Current" }, { v: "promise_to_pay", l: "Promise to Pay" }].map(s => (
                <label key={s.v} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={activeFilters.status.includes(s.v)} onChange={(e) => setActiveFilters({ ...activeFilters, status: e.target.checked ? [...activeFilters.status, s.v] : activeFilters.status.filter(x => x !== s.v) })} />
                  <span style={{ fontSize: 14, color: C.text }}>{s.l}</span>
                </label>
              ))}
            </div>
            <div style={{ padding: "12px 16px" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid, marginBottom: 8 }}>Due Date</div>
              {[{ v: "overdue", l: "Overdue" }, { v: "due_soon", l: "Due Soon (≤7 days)" }, { v: "due_later", l: "Due Later (>7 days)" }].map(d => (
                <label key={d.v} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={activeFilters.dueDate.includes(d.v)} onChange={(e) => setActiveFilters({ ...activeFilters, dueDate: e.target.checked ? [...activeFilters.dueDate, d.v] : activeFilters.dueDate.filter(x => x !== d.v) })} />
                  <span style={{ fontSize: 14, color: C.text }}>{d.l}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, maxWidth: 400 }}>
          <input type="text" placeholder="Search by client or invoice number (min. 3 chars)" value={searchText} onChange={(e) => setSearchText(e.target.value)} style={{ width: "100%", padding: "8px 12px", fontSize: 14, border: `1px solid ${C.blue}`, borderRadius: 6, color: C.text, background: C.card, outline: "none" }} />
          {searchText.length > 0 && searchText.length < 3 && <div style={{ fontSize: 11, color: C.textMid, fontWeight: 500, marginTop: 4 }}>Type {3 - searchText.length} more character{3 - searchText.length > 1 ? "s" : ""} to search</div>}
        </div>
      </div>

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "160px 120px 120px 120px 100px 120px 1fr 36px", alignItems: "center", padding: "12px 16px", paddingRight: 24, gap: 14, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          <SortBtn col="clientName" label="Client" />
          <SortBtn col="id" label="Invoice #" />
          <SortBtn col="amount" label="Amount" />
          <SortBtn col="dueDate" label="Due Date" />
          <SortBtn col="daysOverdue" label="Due In" />
          <SortBtn col="status" label="Status" />
          <SortBtn col="lastActivity" label="Last Activity" />
          <div />
        </div>

        {allInvoices.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: C.textMid, fontWeight: 500, fontSize: 14 }}>
            No invoices match your filters.
          </div>
        )}
        {allInvoices.map((inv, idx) => {
          const statusStyle = statusMap[inv.status] || { label: inv.status, color: C.text };
          const prevSameClient = idx > 0 && allInvoices[idx - 1].clientId === inv.clientId;
          const isLastRow = idx === allInvoices.length - 1;
          const rec = recCards.find(c => c.id === inv.id);
          const exchanges = invoiceExchanges[inv.id];
          const lastExchange = exchanges && exchanges.length > 0 ? exchanges[exchanges.length - 1] : null;
          const channelIcons: Record<string, string> = { "Voice": "📞", "Email": "📧", "Text": "💬" };
          const lastExchangeDate = lastExchange ? lastExchange.timestamp.split(" ")[0] : null;
          const lastExchangeOutcome = lastExchange ? (lastExchange.outcome.length > 50 ? lastExchange.outcome.substring(0, 50) + "..." : lastExchange.outcome) : null;

          return (
            <div key={inv.id} style={{ display: "grid", gridTemplateColumns: "160px 120px 120px 120px 100px 120px 1fr 36px", alignItems: "center", padding: "18px 16px", paddingRight: 24, borderBottom: isLastRow ? "none" : `1px solid ${C.border}`, fontSize: 15, gap: 14, background: selectedInvoiceForHistory === inv.id ? C.blueBg : "#FFFFFF", borderLeft: selectedInvoiceForHistory === inv.id ? `3px solid ${C.blue}` : "3px solid transparent" }}>
              <div>
                <button onClick={() => { sessionStorage.removeItem('clyintel_nav_direct'); router.push(`/client/${inv.clientId}`); }} style={{ fontWeight: prevSameClient ? 400 : 600, fontSize: prevSameClient ? 13 : 14, color: C.blue, background: "transparent", border: "none", cursor: "pointer", padding: 0, paddingLeft: prevSameClient ? 10 : 0, textAlign: "left" }} onMouseEnter={(e) => (e.currentTarget.style.color = C.amber)} onMouseLeave={(e) => (e.currentTarget.style.color = C.blue)}>{inv.clientName}</button>
              </div>
              <div>
                <button onClick={() => setSelectedInvoiceForHistory(inv.id)} style={{ fontFamily: C.mono, color: C.blue, fontSize: 15, background: "transparent", border: "none", cursor: "pointer", padding: 0 }} onMouseEnter={(e) => (e.currentTarget.style.color = C.amber)} onMouseLeave={(e) => (e.currentTarget.style.color = C.blue)}>{inv.id}</button>
              </div>
              <div style={{ fontFamily: C.mono, fontSize: 16, color: inv.status === "past_due" ? C.red : C.text }}>${inv.amount.toLocaleString()}</div>
              <div style={{ color: inv.status === "past_due" ? C.red : C.textMid }}>{inv.dueDate}</div>
              <div style={{ fontWeight: 500, color: inv.status === "past_due" ? C.red : C.text }}>{inv.status === "past_due" && inv.daysOverdue ? `-${inv.daysOverdue}d` : inv.daysUntilDue ? `${inv.daysUntilDue}d` : "—"}</div>
              <div style={{ fontSize: 14, color: statusStyle.color }}>{statusStyle.label}</div>
              <div style={{ fontSize: 14, color: C.textMid, fontWeight: 500, lineHeight: 1.4 }}>
                {lastExchange ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ fontWeight: 600, color: C.text }}>{lastExchangeDate}</span>
                      <span style={{ color: C.textMid, fontWeight: 500 }}>{channelIcons[lastExchange.channel]} {lastExchange.channel}</span>
                    </div>
                    <div style={{ fontStyle: "italic", fontSize: 12 }}>{lastExchangeOutcome}</div>
                  </div>
                ) : "—"}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                {rec && (
                  <button onClick={() => setActiveRecModal(rec.id)} title="Recovery recommendation pending" style={{ width: 26, height: 26, borderRadius: "50%", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, background: C.amberBg, color: C.amber }} onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.75")} onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}>
                    !
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selectedInvoiceForHistory && (
        <ExchangeDrawer invoiceId={selectedInvoiceForHistory} onClose={() => setSelectedInvoiceForHistory(null)} />
      )}
    </div>
  );
}
